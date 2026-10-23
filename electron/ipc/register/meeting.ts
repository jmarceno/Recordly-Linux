import fs from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { buildMediaUrl, ensureMediaServer } from "../../mediaServer";
import {
	ensureAsset,
	findMeetingAsset,
	isAssetInstalled,
	LLAMA_RUNTIME,
	LOCAL_LLM_MODELS,
	removeAsset,
	WHISPER_MODELS,
} from "../meeting/assets";
import {
	cancelMeetingJob,
	enqueueMeetingJob,
	isMeetingJobInterrupted,
	listMeetingJobs,
} from "../meeting/jobs";
import { importMeetingFile, listMeetings, renameMeeting, trashMeeting } from "../meeting/library";
import { stopLocalModelServer } from "../meeting/llamaServer";
import { type MeetingJobMode, meetingFilesFor, readMeetingMeta } from "../meeting/pipeline";
import {
	type MeetingSettings,
	readMeetingSettingsView,
	writeMeetingApiKey,
	writeMeetingSettings,
} from "../meeting/settings";
import { isAllowedLocalReadPath, rememberApprovedLocalReadPath } from "../project/manager";
import { startCosmicAudioRecording } from "../recording/cosmic";
import type { NativeMacRecordingOptions } from "../types";

const JOB_MODES: MeetingJobMode[] = ["full", "transcribe", "summarize"];

function requireAllowedMedia(mediaPath: unknown): string {
	if (typeof mediaPath !== "string" || !mediaPath || !isAllowedLocalReadPath(mediaPath)) {
		throw new Error("That recording is not accessible.");
	}
	return mediaPath;
}

async function readOptional(file: string) {
	try {
		return await fs.readFile(file, "utf-8");
	} catch {
		return null;
	}
}

function errorResult(error: unknown) {
	return {
		success: false as const,
		error: error instanceof Error ? error.message : String(error),
	};
}

export function registerMeetingHandlers() {
	app.on("before-quit", () => {
		void stopLocalModelServer();
	});

	ipcMain.handle("meeting-get-settings", () => readMeetingSettingsView());

	ipcMain.handle("meeting-list", async () => {
		try {
			return { success: true as const, meetings: await listMeetings() };
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle("meeting-media-url", async (_, mediaPath: string) => {
		try {
			const allowed = requireAllowedMedia(mediaPath);
			// The media server only serves files approved for this session.
			await rememberApprovedLocalReadPath(allowed);
			return {
				success: true as const,
				url: buildMediaUrl(await ensureMediaServer(), allowed),
			};
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle("meeting-import", async () => {
		try {
			const result = await dialog.showOpenDialog({
				title: "Import a meeting recording",
				filters: [
					{
						name: "Audio or video",
						extensions: [
							"m4a",
							"mp3",
							"wav",
							"ogg",
							"opus",
							"flac",
							"aac",
							"mp4",
							"mov",
							"webm",
							"mkv",
						],
					},
				],
				properties: ["openFile"],
			});
			if (result.canceled || result.filePaths.length === 0) {
				return { success: false as const, canceled: true };
			}
			return {
				success: true as const,
				mediaPath: await importMeetingFile(result.filePaths[0]),
			};
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle("meeting-rename", async (_, request: { mediaPath: string; title: string }) => {
		try {
			const allowed = requireAllowedMedia(request?.mediaPath);
			return {
				success: true as const,
				title: await renameMeeting(allowed, String(request.title ?? "")),
			};
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle("meeting-delete", async (_, mediaPaths: string[]) => {
		const deleted: string[] = [];
		for (const mediaPath of Array.isArray(mediaPaths) ? mediaPaths : []) {
			try {
				const allowed = requireAllowedMedia(mediaPath);
				if (
					listMeetingJobs().some(
						(job) =>
							job.mediaPath === allowed &&
							(job.status === "queued" || job.status === "running"),
					)
				) {
					continue;
				}
				await trashMeeting(allowed);
				deleted.push(allowed);
			} catch (error) {
				console.warn("[meeting] Could not delete", mediaPath, error);
			}
		}
		return { success: true as const, deleted };
	});

	ipcMain.handle("meeting-reveal", (_, mediaPath: string) => {
		try {
			shell.showItemInFolder(requireAllowedMedia(mediaPath));
			return { success: true as const };
		} catch (error) {
			return errorResult(error);
		}
	});

	// The HUD and editor windows load from different origins, so the meeting to
	// open after an audio-only recording waits here until the editor takes it.
	let requestedMeeting: string | null = null;
	ipcMain.handle("meeting-request-open", (_, mediaPath: string) => {
		requestedMeeting = mediaPath;
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.send("meeting-open-requested");
		}
	});
	ipcMain.handle("meeting-take-open-request", () => {
		const mediaPath = requestedMeeting;
		requestedMeeting = null;
		return mediaPath;
	});

	ipcMain.handle(
		"meeting-set-settings",
		(_, patch: Partial<MeetingSettings> & { apiKey?: string | null }) => {
			try {
				const { apiKey, ...settings } = patch ?? {};
				if (apiKey !== undefined) writeMeetingApiKey(apiKey);
				writeMeetingSettings(settings);
				return { success: true as const, settings: readMeetingSettingsView() };
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	ipcMain.handle("meeting-start-audio-recording", (_, options?: NativeMacRecordingOptions) => {
		if (process.platform !== "linux") {
			return { success: false, message: "Audio-only meetings are only available on Linux." };
		}
		return startCosmicAudioRecording({ ...options, keepSpeakerTracks: true });
	});

	ipcMain.handle("meeting-run-job", (_, request: { mediaPath: string; mode: MeetingJobMode }) => {
		try {
			const mediaPath = requireAllowedMedia(request?.mediaPath);
			if (!JOB_MODES.includes(request.mode))
				throw new Error(`Unknown job mode ${request.mode}.`);
			return { success: true as const, job: enqueueMeetingJob(mediaPath, request.mode) };
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle("meeting-cancel-job", (_, jobId: string) => ({
		success: cancelMeetingJob(jobId),
	}));

	ipcMain.handle("meeting-list-jobs", () => listMeetingJobs());

	ipcMain.handle("meeting-get-files", async (_, mediaPath: string) => {
		try {
			const allowed = requireAllowedMedia(mediaPath);
			const files = meetingFilesFor(allowed);
			const [transcript, notes, meta, interrupted] = await Promise.all([
				readOptional(files.transcript),
				readOptional(files.notes),
				readMeetingMeta(allowed),
				isMeetingJobInterrupted(allowed),
			]);
			return { success: true as const, paths: files, transcript, notes, meta, interrupted };
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle(
		"meeting-save-file",
		async (
			_,
			request: { mediaPath: string; kind: "transcript" | "notes"; content: string },
		) => {
			try {
				const allowed = requireAllowedMedia(request?.mediaPath);
				if (request.kind !== "transcript" && request.kind !== "notes")
					throw new Error("Unknown file.");
				if (typeof request.content !== "string") throw new Error("Missing content.");
				await fs.writeFile(
					meetingFilesFor(allowed)[request.kind],
					request.content,
					"utf-8",
				);
				return { success: true as const };
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	ipcMain.handle("meeting-list-assets", async () => {
		const assets = [
			LLAMA_RUNTIME,
			...Object.values(WHISPER_MODELS),
			...Object.values(LOCAL_LLM_MODELS),
		];
		return Promise.all(
			assets.map(async (asset) => ({
				id: asset.id,
				label: asset.label,
				sizeBytes: asset.sizeBytes,
				installed: await isAssetInstalled(asset),
			})),
		);
	});

	ipcMain.handle("meeting-download-asset", async (event, assetId: string) => {
		const asset = findMeetingAsset(assetId);
		if (!asset) return { success: false, error: "Unknown download." };
		const sender = event.sender;
		try {
			await ensureAsset(asset, (progress) => {
				if (!sender.isDestroyed())
					sender.send("meeting-asset-progress", { id: asset.id, progress });
			});
			return { success: true as const };
		} catch (error) {
			return errorResult(error);
		}
	});

	ipcMain.handle("meeting-remove-asset", async (_, assetId: string) => {
		const asset = findMeetingAsset(assetId);
		if (!asset) return { success: false, error: "Unknown download." };
		await removeAsset(asset);
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed())
				window.webContents.send("meeting-asset-progress", {
					id: asset.id,
					progress: 0,
					removed: true,
				});
		}
		return { success: true as const };
	});
}
