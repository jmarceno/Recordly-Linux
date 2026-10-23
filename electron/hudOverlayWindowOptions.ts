export interface HudOverlayTaskbarOptions {
	skipTaskbar: boolean;
	focusable: boolean;
}

export function getHudOverlayTaskbarOptions(platform: NodeJS.Platform): HudOverlayTaskbarOptions {
	// On Wayland, Chromium turns a non-focusable window into an input-less
	// surface: every click on the HUD falls through and it cannot be dragged.
	// Linux needs a regular focusable toplevel with a taskbar entry.
	const regularWindow = platform === "win32" || platform === "linux";
	return {
		skipTaskbar: !regularWindow,
		focusable: regularWindow,
	};
}
