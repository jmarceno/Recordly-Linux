/**
 * Meeting mode in the HUD and the hand-off to the editor window. The windows
 * load from different origins, so the meeting to open goes through the main
 * process, which keeps it until the editor takes it.
 */
const HUD_PREFS_KEY = "recordly.meeting-hud.v1";

export interface MeetingHudPrefs {
	meetingMode: boolean;
	recordScreen: boolean;
}

export function readMeetingHudPrefs(): MeetingHudPrefs {
	try {
		const value = JSON.parse(
			localStorage.getItem(HUD_PREFS_KEY) || "{}",
		) as Partial<MeetingHudPrefs>;
		return {
			meetingMode: value.meetingMode === true,
			recordScreen: value.recordScreen !== false,
		};
	} catch {
		return { meetingMode: false, recordScreen: true };
	}
}

export function writeMeetingHudPrefs(prefs: MeetingHudPrefs) {
	try {
		localStorage.setItem(HUD_PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// Preferences are a convenience; recording works without them.
	}
}

/** Opens the editor window on the dashboard with this meeting in front. */
export async function openMeetingInEditor(mediaPath: string) {
	await window.electronAPI.meetingRequestOpen(mediaPath);
	await window.electronAPI.showProjectDashboard();
}
