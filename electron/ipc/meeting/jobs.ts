import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
	type MeetingJobMode,
	readMeetingMeta,
	runMeetingPipeline,
	updateMeetingMeta,
} from "./pipeline";
import { readMeetingSettings } from "./settings";

/**
 * Meeting jobs run in the main process, one at a time (whisper and the local
 * model must never share the machine), and keep going when windows close.
 * Each job's state is mirrored into the recording's .meeting.json so a crash
 * shows up as "interrupted" with a retry.
 */
export type MeetingJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface MeetingJob {
	id: string;
	mediaPath: string;
	mode: MeetingJobMode;
	status: MeetingJobStatus;
	stage: "transcribe" | "summarize" | "title" | null;
	message: string;
	progress: number | null;
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}

const jobs: MeetingJob[] = [];
const controllers = new Map<string, AbortController>();
let draining = false;
/** Finished jobs kept around for the UI. */
const MAX_FINISHED_JOBS = 20;

function broadcast(job: MeetingJob) {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("meeting-job-update", { ...job });
	}
}

function update(job: MeetingJob, patch: Partial<MeetingJob>) {
	Object.assign(job, patch);
	broadcast(job);
}

export function listMeetingJobs() {
	return jobs.map((job) => ({ ...job }));
}

function isActive(job: MeetingJob) {
	return job.status === "queued" || job.status === "running";
}

export function enqueueMeetingJob(mediaPath: string, mode: MeetingJobMode): MeetingJob {
	const existing = jobs.find((job) => job.mediaPath === mediaPath && isActive(job));
	if (existing) return { ...existing };
	const job: MeetingJob = {
		id: randomUUID(),
		mediaPath,
		mode,
		status: "queued",
		stage: null,
		message: "Waiting…",
		progress: null,
		error: null,
		createdAt: new Date().toISOString(),
		finishedAt: null,
	};
	jobs.push(job);
	const finished = jobs.filter((entry) => !isActive(entry));
	for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
		jobs.splice(jobs.indexOf(old), 1);
	}
	broadcast(job);
	void drain();
	return { ...job };
}

export function cancelMeetingJob(id: string) {
	const job = jobs.find((entry) => entry.id === id);
	if (!job || !isActive(job)) return false;
	if (job.status === "queued") {
		update(job, {
			status: "cancelled",
			message: "Cancelled",
			finishedAt: new Date().toISOString(),
		});
		return true;
	}
	controllers.get(id)?.abort();
	return true;
}

/** A job the last session left "running" (the app quit or crashed). */
export async function isMeetingJobInterrupted(mediaPath: string) {
	const meta = await readMeetingMeta(mediaPath);
	return (
		meta.lastJob?.status === "running" &&
		!jobs.some((job) => job.mediaPath === mediaPath && isActive(job))
	);
}

async function drain() {
	if (draining) return;
	draining = true;
	try {
		for (
			let job = jobs.find((entry) => entry.status === "queued");
			job;
			job = jobs.find((entry) => entry.status === "queued")
		) {
			await runJob(job);
		}
	} finally {
		draining = false;
	}
}

async function runJob(job: MeetingJob) {
	const controller = new AbortController();
	controllers.set(job.id, controller);
	update(job, { status: "running", message: "Starting…" });
	const at = () => new Date().toISOString();
	try {
		await updateMeetingMeta(job.mediaPath, {
			lastJob: { mode: job.mode, status: "running", at: at() },
		});
		await runMeetingPipeline({
			mediaPath: job.mediaPath,
			mode: job.mode,
			settings: readMeetingSettings(),
			signal: controller.signal,
			onStatus: (stage, message, progress) =>
				update(job, { stage, message, progress: progress ?? null }),
		});
		// Meta first, so anyone reacting to "done" reads the finished state.
		await updateMeetingMeta(job.mediaPath, {
			lastJob: { mode: job.mode, status: "done", at: at() },
		});
		update(job, { status: "done", message: "Done", progress: 100, finishedAt: at() });
	} catch (error) {
		const cancelled = controller.signal.aborted;
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[meeting] Job ${job.mode} for ${job.mediaPath} failed:`, error);
		await updateMeetingMeta(job.mediaPath, {
			lastJob: {
				mode: job.mode,
				status: cancelled ? "cancelled" : "failed",
				...(cancelled ? {} : { error: message }),
				at: at(),
			},
		}).catch(() => undefined);
		update(job, {
			status: cancelled ? "cancelled" : "failed",
			message: cancelled ? "Cancelled" : message,
			error: cancelled ? null : message,
			finishedAt: at(),
		});
	} finally {
		controllers.delete(job.id);
	}
}
