import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { resolveWhisperExecutablePath } from "../captions/generate";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { speakerTrackPath } from "../recording/cosmic";
import type { MeetingStatusCallback } from "./context";

const execFileAsync = promisify(execFile);

export type SpeakerRole = "mic" | "system";

export interface TranscriptSegment {
	startMs: number;
	text: string;
	speaker: "Me" | "Remote" | null;
}

export interface MeetingAudioInputs {
	/** The recording people listen to: always the mixed track. */
	mediaPath: string;
	mic: string | null;
	system: string | null;
}

/** The per-speaker tracks Recordly keeps next to a meeting recording, if any. */
export function resolveMeetingAudioInputs(mediaPath: string): MeetingAudioInputs {
	const existing = (role: SpeakerRole) => {
		const candidate = speakerTrackPath(mediaPath, role);
		return existsSync(candidate) ? candidate : null;
	};
	return { mediaPath, mic: existing("mic"), system: existing("system") };
}

/** Per-channel clean-up from GravaAi: cut rumble, lift quiet voices. */
const SPEECH_FILTER = "highpass=f=80,speechnorm=e=10:l=1";

/**
 * ffmpeg argv producing the 16 kHz WAV whisper reads. With both speaker
 * tracks it is stereo (mic left, system right) so `-di` can label turns;
 * otherwise a mono mix of whatever exists.
 */
export function buildWhisperInputArgs(inputs: MeetingAudioInputs, wavPath: string) {
	const base = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
	if (inputs.mic && inputs.system) {
		return [
			...base,
			"-i",
			inputs.mic,
			"-i",
			inputs.system,
			"-filter_complex",
			`[0:a]aformat=channel_layouts=mono,${SPEECH_FILTER}[l];[1:a]aformat=channel_layouts=mono,${SPEECH_FILTER}[r];[l][r]amerge=inputs=2,aresample=16000[a]`,
			"-map",
			"[a]",
			"-c:a",
			"pcm_s16le",
			wavPath,
		];
	}
	const source = inputs.mic ?? inputs.system ?? inputs.mediaPath;
	return [
		...base,
		"-i",
		source,
		"-map",
		"0:a:0",
		"-vn",
		"-af",
		SPEECH_FILTER,
		"-ac",
		"1",
		"-ar",
		"16000",
		"-c:a",
		"pcm_s16le",
		wavPath,
	];
}

export function whisperMeetingArgs(options: {
	modelPath: string;
	wavPath: string;
	outputBase: string;
	language: string;
	threads: number;
	diarize: boolean;
	vadModelPath?: string;
}) {
	return [
		"-m",
		options.modelPath,
		"-f",
		options.wavPath,
		"-l",
		options.language.trim() || "auto",
		"-t",
		String(Math.max(1, options.threads)),
		"-pp",
		// Do not carry a hallucinated phrase through later decoding windows.
		"-mc",
		"0",
		...(options.diarize ? ["-di"] : []),
		// Decode only detected speech; on silence whisper invents text.
		...(options.vadModelPath ? ["--vad", "-vm", options.vadModelPath] : []),
		"-oj",
		"-of",
		options.outputBase,
	];
}

/** Parses whisper-cli `-oj` output. With `-di`, speaker 0 is the left channel (mic). */
export function parseWhisperJson(raw: string): {
	language: string | null;
	segments: TranscriptSegment[];
} {
	const data = JSON.parse(raw) as {
		result?: { language?: string };
		transcription?: Array<{ offsets?: { from?: number }; text?: string; speaker?: string }>;
	};
	const segments = (data.transcription ?? []).flatMap((segment) => {
		const text = (segment.text ?? "").trim();
		if (!text) return [];
		const speaker = segment.speaker === "0" ? "Me" : segment.speaker === "1" ? "Remote" : null;
		return [
			{
				startMs: Math.max(0, segment.offsets?.from ?? 0),
				text,
				speaker,
			} as TranscriptSegment,
		];
	});
	return { language: data.result?.language ?? null, segments };
}

export function formatTimestamp(ms: number) {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `[${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
}

/** A speaker's consecutive segments join one paragraph until it spans this long. */
const MAX_TURN_SPAN_MS = 60_000;

/**
 * Renders segments as the shared transcript format: one paragraph per speaker
 * turn, `[HH:MM:SS] **Me:** text`, blank line between turns so it reads as
 * Markdown. Unlabelled segments (mono input) start a new paragraph each.
 */
export function formatTranscriptMarkdown(segments: TranscriptSegment[]) {
	const turns: TranscriptSegment[] = [];
	for (const segment of segments) {
		const previous = turns[turns.length - 1];
		if (
			previous &&
			segment.speaker !== null &&
			previous.speaker === segment.speaker &&
			segment.startMs - previous.startMs < MAX_TURN_SPAN_MS
		) {
			previous.text = `${previous.text} ${segment.text}`;
			continue;
		}
		turns.push({ ...segment });
	}
	return turns
		.map(
			(turn) =>
				`${formatTimestamp(turn.startMs)} ${turn.speaker ? `**${turn.speaker}:** ` : ""}${turn.text}`,
		)
		.join("\n\n");
}

/** Merges two separately transcribed tracks into one timeline. */
export function mergeSpeakerSegments(mic: TranscriptSegment[], system: TranscriptSegment[]) {
	return [
		...mic.map((segment) => ({ ...segment, speaker: "Me" as const })),
		...system.map((segment) => ({ ...segment, speaker: "Remote" as const })),
	].sort((a, b) => a.startMs - b.startMs);
}

export async function probeDurationMs(mediaPath: string): Promise<number | null> {
	try {
		const { stderr } = await execFileAsync(getFfmpegBinaryPath(), [
			"-hide_banner",
			"-i",
			mediaPath,
		]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
		const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
		if (!match) return null;
		return Math.round(
			(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000,
		);
	} catch {
		return null;
	}
}

/** Local transcription with the bundled whisper-cli. */
export async function transcribeWithWhisper(options: {
	inputs: MeetingAudioInputs;
	modelPath: string;
	vadModelPath?: string;
	language: string;
	onStatus?: MeetingStatusCallback;
	signal?: AbortSignal;
}) {
	const whisper = await resolveWhisperExecutablePath();
	const work = await fs.mkdtemp(path.join(app.getPath("temp"), "recordly-meeting-"));
	try {
		const wavPath = path.join(work, "audio.wav");
		options.onStatus?.("Preparing audio…");
		await execFileAsync(getFfmpegBinaryPath(), buildWhisperInputArgs(options.inputs, wavPath), {
			timeout: 30 * 60 * 1000,
			signal: options.signal,
		});
		const diarize = Boolean(options.inputs.mic && options.inputs.system);
		const outputBase = path.join(work, "out");
		const args = whisperMeetingArgs({
			modelPath: options.modelPath,
			wavPath,
			outputBase,
			language: options.language,
			// whisper scales with physical cores, not SMT threads.
			threads: Math.min(8, Math.max(1, Math.floor(os.availableParallelism() / 2))),
			diarize,
			vadModelPath: options.vadModelPath,
		});
		options.onStatus?.("Transcribing…", 0);
		await runWhisperWithProgress(whisper, args, options.onStatus, options.signal);
		return parseWhisperJson(await fs.readFile(`${outputBase}.json`, "utf-8"));
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

async function runWhisperWithProgress(
	whisper: string,
	args: string[],
	onStatus?: MeetingStatusCallback,
	signal?: AbortSignal,
) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(whisper, args, {
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, LD_LIBRARY_PATH: path.dirname(whisper) },
			signal,
		});
		let tail = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			tail = (tail + text).slice(-4000);
			const matches = [...text.matchAll(/progress\s*=\s*(\d+)%/g)];
			const last = matches[matches.length - 1];
			if (last) onStatus?.("Transcribing…", Number(last[1]));
		});
		child.once("error", reject);
		child.once("exit", (code, signalName) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`whisper-cli failed (${signalName ?? `code ${code}`}): ${tail.trim().split("\n").slice(-3).join(" ")}`,
					),
				);
		});
	});
}
