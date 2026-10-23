import { useEffect, useState } from "react";
import { MeetingView } from "./MeetingView";

/** Event the dashboard dispatches to open a meeting in this window. */
export const OPEN_MEETING_EVENT = "recordly:open-meeting";

export function requestOpenMeeting(mediaPath: string) {
	window.dispatchEvent(new CustomEvent<string>(OPEN_MEETING_EVENT, { detail: mediaPath }));
}

/**
 * Shows the meeting view over the dashboard, which renders it.
 * Opened from the dashboard (window event) or from the HUD after an
 * audio-only recording (a request kept by the main process).
 */
export function MeetingViewHost() {
	const [mediaPath, setMediaPath] = useState<string | null>(null);

	useEffect(() => {
		const takeRequest = () =>
			void window.electronAPI.meetingTakeOpenRequest().then((requested) => {
				if (requested) setMediaPath(requested);
			});
		takeRequest();
		const unsubscribe = window.electronAPI.onMeetingOpenRequested(takeRequest);
		const onOpen = (event: Event) => {
			const detail = (event as CustomEvent<string>).detail;
			if (detail) setMediaPath(detail);
		};
		window.addEventListener(OPEN_MEETING_EVENT, onOpen);
		return () => {
			unsubscribe();
			window.removeEventListener(OPEN_MEETING_EVENT, onOpen);
		};
	}, []);

	return <MeetingView mediaPath={mediaPath} onClose={() => setMediaPath(null)} />;
}
