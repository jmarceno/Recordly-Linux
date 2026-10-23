import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp", getAppPath: () => "/tmp", isPackaged: false },
	safeStorage: {},
}));

const { DEFAULT_MEETING_SETTINGS, normalizeMeetingSettings } = await import("./settings");
const { transcriptCharBudget } = await import("./summarize");

describe("normalizeMeetingSettings", () => {
	it("returns the defaults for missing or broken input", () => {
		expect(normalizeMeetingSettings(null)).toEqual(DEFAULT_MEETING_SETTINGS);
		expect(normalizeMeetingSettings("nope")).toEqual(DEFAULT_MEETING_SETTINGS);
	});

	it("keeps valid values and replaces invalid ones", () => {
		const settings = normalizeMeetingSettings({
			summarizationService: "api",
			localModel: "qwen3.5-4b",
			whisperModel: "huge",
			apiBaseUrl: "ftp://example",
			apiChatCapabilities: ["images"],
			apiTimeoutMinutes: 0,
			autoTitle: false,
			unknown: 1,
		});
		expect(settings.summarizationService).toBe("api");
		expect(settings.localModel).toBe("qwen3.5-4b");
		expect(settings.whisperModel).toBe(DEFAULT_MEETING_SETTINGS.whisperModel);
		expect(settings.apiBaseUrl).toBe(DEFAULT_MEETING_SETTINGS.apiBaseUrl);
		// Text is always required: a provider that takes images still takes text.
		expect(settings.apiChatCapabilities).toEqual(["text"]);
		expect(settings.apiTimeoutMinutes).toBe(DEFAULT_MEETING_SETTINGS.apiTimeoutMinutes);
		expect(settings.autoTitle).toBe(false);
		expect("unknown" in settings).toBe(false);
	});
});

describe("transcriptCharBudget", () => {
	it("leaves room for the prompt and the answer", () => {
		expect(transcriptCharBudget(16_384)).toBe((16_384 - 3_500) * 3);
		expect(transcriptCharBudget(2_000)).toBe(4_000);
	});
});
