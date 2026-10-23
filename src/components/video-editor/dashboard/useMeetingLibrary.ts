import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectLibraryEntry } from "../ProjectBrowserDialog";

function toEntry(meeting: MeetingLibraryEntry): ProjectLibraryEntry {
	return {
		path: meeting.mediaPath,
		name: meeting.title,
		createdAt: meeting.createdAt,
		updatedAt: meeting.createdAt,
		thumbnailPath: null,
		isCurrent: false,
		isInProjectsDirectory: false,
		meeting,
	};
}

/** The Meetings section of the dashboard: recordings marked as meetings. */
export function useMeetingLibrary(enabled: boolean) {
	const [entries, setEntries] = useState<ProjectLibraryEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const loadedOnce = useRef(false);

	const refresh = useCallback(async () => {
		if (!loadedOnce.current) setLoading(true);
		try {
			const result = await window.electronAPI.meetingList();
			if (!result.success) throw new Error(result.error);
			setEntries((result.meetings ?? []).map(toEntry));
			setError(null);
			loadedOnce.current = true;
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		void refresh();
		// Status badges and titles change while jobs run; refresh when a job moves on.
		let timer: number | null = null;
		const unsubscribe = window.electronAPI.onMeetingJobUpdate((job) => {
			if (job.status === "running" && job.progress !== null && job.progress % 50 !== 0)
				return;
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => void refresh(), 400);
		});
		return () => {
			unsubscribe();
			if (timer !== null) window.clearTimeout(timer);
		};
	}, [enabled, refresh]);

	const rename = async (path: string, name: string) => {
		const result = await window.electronAPI.meetingRename({ mediaPath: path, title: name });
		if (!result.success) throw new Error(result.error ?? "Could not rename the meeting.");
		setEntries((current) =>
			current.map((entry) =>
				entry.path === path ? { ...entry, name: result.title ?? name } : entry,
			),
		);
		return path;
	};

	const remove = async (paths: string[]) => {
		const result = await window.electronAPI.meetingDelete(paths);
		setEntries((current) => current.filter((entry) => !result.deleted.includes(entry.path)));
		if (result.deleted.length < paths.length) {
			throw new Error("Meetings that are still being processed were not deleted.");
		}
		return result.deleted;
	};

	/** Asks for a file, copies it into the library and returns its path. */
	const importFile = async () => {
		const result = await window.electronAPI.meetingImport();
		if (!result.success) {
			if (result.canceled) return null;
			throw new Error(result.error ?? "Could not import the file.");
		}
		await refresh();
		return result.mediaPath ?? null;
	};

	return { entries, error, loading, refresh, rename, remove, importFile };
}
