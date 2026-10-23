import fs from "node:fs/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import {
	findMeetingAsset,
	isAssetInstalled,
	LLAMA_RUNTIME,
	LOCAL_LLM_MODELS,
	WHISPER_MODELS,
	ensureAsset,
	removeAsset,
} from "../meeting/assets";
import {
	cancelMeetingJob,
	enqueueMeetingJob,
	isMeetingJobInterrupted,
	listMeetingJobs,
} from "../meeting/jobs";
import { stopLocalModelServer } from "../meeting/llamaServer";
import { type MeetingJobMode, meetingFilesFor, readMeetingMeta } from "../meeting/pipeline";
import {
	type MeetingSettings,
	readMeetingSettingsView,
	writeMeetingApiKey,
	writeMeetingSettings,
} from "../meeting/settings";
import { isAllowedLocalReadPath } from "../project/manager";
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
