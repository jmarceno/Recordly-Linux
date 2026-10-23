import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp", getAppPath: () => "/tmp", isPackaged: false },
	safeStorage: {},
	BrowserWindow: { getAllWindows: () => [] },
}));

const { alignTrackFilter, speakerTrackPath } = await import("../recording/cosmic");
const {
	buildWhisperInputArgs,
	formatTimestamp,
	formatTranscriptMarkdown,
	mergeSpeakerSegments,
	parseWhisperJson,
	whisperMeetingArgs,
} = await import("./transcript");
const { chunkCommand } = await import("./apiTranscription");
const { meetingFilesFor } = await import("./pipeline");

describe("speaker tracks", () => {
	it("names the sidecars after the recording", () => {
		expect(speakerTrackPath("/r/recording-1.mp4", "mic")).toBe(
			"/r/recording-1.meeting-mic.opus",
		);
		expect(speakerTrackPath("/r/recording-1.m4a", "system")).toBe(
			"/r/recording-1.meeting-system.opus",
		);
	});

	it("delays late tracks and trims early ones", () => {
		expect(alignTrackFilter(1250, 1000)).toBe("adelay=250:all=1");
		expect(alignTrackFilter(900, 1000)).toBe("atrim=start=0.100,asetpts=PTS-STARTPTS");
	});
});

describe("whisper input", () => {
	it("builds a mic-left / system-right stereo file when both tracks exist", () => {
		const args = buildWhisperInputArgs(
			{
				mediaPath: "/r/a.m4a",
				mic: "/r/a.meeting-mic.opus",
				system: "/r/a.meeting-system.opus",
			},
			"/t/a.wav",
		);
		expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 4)).toEqual([
			"-i",
			"/r/a.meeting-mic.opus",
			"-i",
			"/r/a.meeting-system.opus",
		]);
		expect(args.join(" ")).toContain("[l][r]amerge=inputs=2");
	});

	it("falls back to a mono mix of the recording", () => {
		const args = buildWhisperInputArgs(
			{ mediaPath: "/r/demo.mp4", mic: null, system: null },
			"/t/a.wav",
		);
		expect(args).toContain("/r/demo.mp4");
		expect(args[args.indexOf("-ac") + 1]).toBe("1");
	});

	const base = { modelPath: "m", wavPath: "w", outputBase: "o", language: "", threads: 4 };

	it("only asks whisper to diarize stereo input", () => {
		expect(whisperMeetingArgs({ ...base, diarize: true })).toContain("-di");
		const mono = whisperMeetingArgs({ ...base, diarize: false });
		expect(mono).not.toContain("-di");
		expect(mono[mono.indexOf("-l") + 1]).toBe("auto");
		expect(mono).not.toContain("--vad");
	});

	it("decodes only detected speech when a voice-detection model is given", () => {
		const args = whisperMeetingArgs({ ...base, diarize: true, vadModelPath: "/m/vad.bin" });
		expect(args).toContain("--vad");
		expect(args[args.indexOf("-vm") + 1]).toBe("/m/vad.bin");
	});
});

describe("transcript markdown", () => {
	const json = JSON.stringify({
		result: { language: "pt" },
		transcription: [
			{ offsets: { from: 0 }, text: " Bom dia a todos.", speaker: "0" },
			{ offsets: { from: 4000 }, text: " Vamos começar.", speaker: "0" },
			{ offsets: { from: 7200 }, text: " Bom dia!", speaker: "1" },
			{ offsets: { from: 9000 }, text: "  ", speaker: "1" },
			{ offsets: { from: 3_725_000 }, text: " Até logo.", speaker: "?" },
		],
	});

	it("parses language, speakers and drops empty segments", () => {
		const parsed = parseWhisperJson(json);
		expect(parsed.language).toBe("pt");
		expect(parsed.segments.map((segment) => segment.speaker)).toEqual([
			"Me",
			"Me",
			"Remote",
			null,
		]);
	});

	it("renders one paragraph per speaker turn", () => {
		expect(formatTranscriptMarkdown(parseWhisperJson(json).segments)).toBe(
			[
				"[00:00:00] **Me:** Bom dia a todos. Vamos começar.",
				"[00:00:07] **Remote:** Bom dia!",
				"[01:02:05] Até logo.",
			].join("\n\n"),
		);
	});

	it("starts a new paragraph when a monologue runs past a minute", () => {
		const segments = [0, 30_000, 61_000].map((startMs) => ({
			startMs,
			text: "x",
			speaker: "Me" as const,
		}));
		expect(formatTranscriptMarkdown(segments).split("\n\n")).toHaveLength(2);
	});

	it("merges separately transcribed tracks by time", () => {
		const merged = mergeSpeakerSegments(
			[{ startMs: 5000, text: "b", speaker: null }],
			[{ startMs: 1000, text: "a", speaker: null }],
		);
		expect(merged.map((segment) => `${segment.speaker}:${segment.text}`)).toEqual([
			"Remote:a",
			"Me:b",
		]);
	});

	it("formats timestamps", () => {
		expect(formatTimestamp(3_661_999)).toBe("[01:01:01]");
	});
});

describe("files and chunks", () => {
	it("keeps meeting files next to the recording", () => {
		expect(meetingFilesFor("/r/recording-1.m4a")).toEqual({
			transcript: "/r/recording-1.transcript.md",
			notes: "/r/recording-1.notes.md",
			meta: "/r/recording-1.meeting.json",
		});
	});

	it("cuts API uploads into 10-minute mono MP3 segments", () => {
		const args = chunkCommand("/r/a.m4a", "/t/chunk-%03d.mp3");
		expect(args[args.indexOf("-segment_time") + 1]).toBe("600");
		expect(args[args.indexOf("-ac") + 1]).toBe("1");
	});
});
