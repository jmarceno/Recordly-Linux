import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import { speakerTrackPath } from "../recording/cosmic";
import { getRecordingsDir } from "../utils";
import { enqueueMeetingJob, isMeetingJobInterrupted, listMeetingJobs } from "./jobs";
import { type MeetingMeta, meetingFilesFor, readMeetingMeta, updateMeetingMeta } from "./pipeline";
import { readMeetingSettings } from "./settings";

/**
 * A meeting is its media file plus the sidecars next to it
 * (`.meeting.json`, `.transcript.md`, `.notes.md`, speaker tracks). There is
 * no separate project file: a meeting with video is edited like any other
 * recording, and the editor reads the same sidecars.
 */
export interface MeetingLibraryEntry {
	mediaPath: string;
	title: string;
	createdAt: number;
	durationMs: number | null;
	hasVideo: boolean;
	hasTranscript: boolean;
	hasNotes: boolean;
	status: "idle" | "queued" | "running" | "failed" | "interrupted";
	error: string | null;
}

const MEDIA_EXTENSIONS = [
	"mp4",
	"mov",
	"webm",
	"mkv",
	"m4a",
	"mp3",
	"wav",
	"ogg",
	"opus",
	"flac",
	"aac",
];

async function exists(file: string) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function findMediaForMeta(metaPath: string) {
	const base = metaPath.replace(/\.meeting\.json$/, "");
	for (const extension of MEDIA_EXTENSIONS) {
		const candidate = `${base}.${extension}`;
		if (await exists(candidate)) return candidate;
	}
	return null;
}

export function defaultMeetingTitle(createdAt: number) {
	const date = new Date(createdAt);
	return `Meeting ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export async function listMeetings(): Promise<MeetingLibraryEntry[]> {
	const dir = await getRecordingsDir();
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	const jobs = listMeetingJobs();
	const entries = await Promise.all(
		names
			.filter((name) => name.endsWith(".meeting.json"))
			.map(async (name): Promise<MeetingLibraryEntry | null> => {
				const mediaPath = await findMediaForMeta(path.join(dir, name));
				if (!mediaPath) return null;
				const meta = await readMeetingMeta(mediaPath);
				if (meta.kind !== "meeting") return null;
				const files = meetingFilesFor(mediaPath);
				const createdAt = meta.createdAt
					? Date.parse(meta.createdAt)
					: (await fs.stat(mediaPath)).mtimeMs;
				const job = jobs.find(
					(entry) =>
						entry.mediaPath === mediaPath &&
						(entry.status === "queued" || entry.status === "running"),
				);
				const interrupted = !job && (await isMeetingJobInterrupted(mediaPath));
				return {
					mediaPath,
					title: meta.title?.trim() || defaultMeetingTitle(createdAt),
					createdAt,
					durationMs: meta.durationMs ?? null,
					hasVideo: Boolean(meta.hasVideo),
					hasTranscript: await exists(files.transcript),
					hasNotes: await exists(files.notes),
					status: job
						? job.status === "queued"
							? "queued"
							: "running"
						: interrupted
							? "interrupted"
							: meta.lastJob?.status === "failed"
								? "failed"
								: "idle",
					error: meta.lastJob?.status === "failed" ? (meta.lastJob.error ?? null) : null,
				};
			}),
	);
	return entries
		.filter((entry): entry is MeetingLibraryEntry => entry !== null)
		.sort((a, b) => b.createdAt - a.createdAt);
}

/** Marks a fresh recording as a meeting and, when enabled, starts processing it. */
export async function registerMeetingRecording(mediaPath: string, options: { hasVideo: boolean }) {
	const meta: Partial<MeetingMeta> = {
		kind: "meeting",
		createdAt: new Date().toISOString(),
		hasVideo: options.hasVideo,
	};
	await updateMeetingMeta(mediaPath, meta);
	if (readMeetingSettings().autoProcess) enqueueMeetingJob(mediaPath, "full");
}

/** Copies an existing audio or video file into the library as a new meeting. */
export async function importMeetingFile(sourcePath: string) {
	const extension = path.extname(sourcePath).replace(/^\./, "").toLowerCase();
	if (!MEDIA_EXTENSIONS.includes(extension)) {
		throw new Error(`Recordly cannot import .${extension} files as meetings.`);
	}
	const dir = await getRecordingsDir();
	const target = path.join(dir, `meeting-${Date.now()}-${randomUUID().slice(0, 6)}.${extension}`);
	await fs.copyFile(sourcePath, target);
	const hasVideo = ["mp4", "mov", "webm", "mkv"].includes(extension);
	const title = path.basename(sourcePath, path.extname(sourcePath));
	await updateMeetingMeta(target, {
		kind: "meeting",
		createdAt: new Date().toISOString(),
		hasVideo,
		title,
	});
	if (readMeetingSettings().autoProcess) enqueueMeetingJob(target, "full");
	return target;
}

export async function renameMeeting(mediaPath: string, title: string) {
	const trimmed = title.trim();
	if (!trimmed) throw new Error("The title cannot be empty.");
	await updateMeetingMeta(mediaPath, { title: trimmed.slice(0, 120) });
	return trimmed;
}

/** Moves a meeting's media and every sidecar to the system trash (recoverable). */
export async function trashMeeting(mediaPath: string) {
	const files = meetingFilesFor(mediaPath);
	const candidates = [
		mediaPath,
		files.transcript,
		files.notes,
		files.meta,
		speakerTrackPath(mediaPath, "mic"),
		speakerTrackPath(mediaPath, "system"),
		`${mediaPath}.cursor.json`,
	];
	for (const file of candidates) {
		if (await exists(file)) await shell.trashItem(file);
	}
}
