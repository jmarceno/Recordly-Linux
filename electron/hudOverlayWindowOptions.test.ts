import { describe, expect, it } from "vitest";
import { getHudOverlayTaskbarOptions } from "./hudOverlayWindowOptions";

describe("getHudOverlayTaskbarOptions", () => {
	it.each([
		"win32",
		"linux",
	] as const)("keeps a focusable HUD in the taskbar on %s", (platform) => {
		expect(getHudOverlayTaskbarOptions(platform)).toEqual({
			skipTaskbar: false,
			focusable: true,
		});
	});

	it("keeps the HUD non-focusable and out of the taskbar on darwin", () => {
		expect(getHudOverlayTaskbarOptions("darwin")).toEqual({
			skipTaskbar: true,
			focusable: false,
		});
	});
});
