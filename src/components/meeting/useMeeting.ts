import { useCallback, useEffect, useRef, useState } from "react";

export interface MeetingFilesState {
	transcript: string | null;
	notes: string | null;
	meta: MeetingMeta;
	interrupted: boolean;
}

const EMPTY: MeetingFilesState = { transcript: null, notes: null, meta: {}, interrupted: false };

function isActive(job: MeetingJob | null) {
	return job?.status === "queued" || job?.status === "running";
}

/** Live state of one recording's meeting files and its processing job. */
export function useMeeting(mediaPath: string | null) {
	const [files, setFiles] = useState<MeetingFilesState>(EMPTY);
	const [job, setJob] = useState<MeetingJob | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pathRef = useRef(mediaPath);
	pathRef.current = mediaPath;

	const refresh = useCallback(async () => {
		const current = pathRef.current;
		if (!current) return;
		const result = await window.electronAPI.meetingGetFiles(current);
		if (pathRef.current !== current) return;
		if (!result.success) {
			setError(result.error ?? "Could not read the meeting files.");
			return;
		}
		setError(null);
		setFiles({
			transcript: result.transcript ?? null,
			notes: result.notes ?? null,
			meta: result.meta ?? {},
			interrupted: Boolean(result.interrupted),
		});
	}, []);

	useEffect(() => {
		setFiles(EMPTY);
		setJob(null);
		if (!mediaPath) return;
		let active = true;
		setLoading(true);
		void refresh().finally(() => {
			if (active) setLoading(false);
		});
		void window.electronAPI.meetingListJobs().then((jobs) => {
			if (!active) return;
			const own = jobs.filter((entry) => entry.mediaPath === mediaPath);
			const latest = own[own.length - 1] ?? null;
			if (latest) setJob(latest);
		});
		const unsubscribe = window.electronAPI.onMeetingJobUpdate((update) => {
			if (update.mediaPath !== pathRef.current) return;
			setJob(update);
			// Reload as soon as a stage has written its file, and at the end.
			if (update.stage === "summarize" || update.stage === "title" || !isActive(update)) {
				void refresh();
			}
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [mediaPath, refresh]);

	const run = useCallback(async (mode: MeetingJobMode) => {
		const current = pathRef.current;
		if (!current) return;
		const result = await window.electronAPI.meetingRunJob({ mediaPath: current, mode });
		if (!result.success) setError(result.error ?? "Could not start processing.");
		else if (result.job) setJob(result.job);
	}, []);

	const cancel = useCallback(async () => {
		if (job && isActive(job)) await window.electronAPI.meetingCancelJob(job.id);
	}, [job]);

	const save = useCallback(
		async (kind: "transcript" | "notes", content: string) => {
			const current = pathRef.current;
			if (!current) return false;
			const result = await window.electronAPI.meetingSaveFile({
				mediaPath: current,
				kind,
				content,
			});
			if (!result.success) {
				setError(result.error ?? "Could not save.");
				return false;
			}
			await refresh();
			return true;
		},
		[refresh],
	);

	return { files, job, busy: isActive(job), loading, error, refresh, run, cancel, save };
}
