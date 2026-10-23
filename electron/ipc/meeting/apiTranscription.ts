import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import type { MeetingStatusCallback } from "./context";
import { type OpenAiEndpoint, transcribeAudioFile } from "./openaiClient";
import { languageCodeFromName } from "./prompts";
import {
	type MeetingAudioInputs,
	mergeSpeakerSegments,
	type TranscriptSegment,
} from "./transcript";

const execFileAsync = promisify(execFile);

/**
 * Upload size limits (25 MB on OpenAI) rule out long meetings in one request,
 * so audio is cut into speech-quality mono MP3 chunks. 10 minutes at 48 kbps
 * is ~3.6 MB.
 */
export const CHUNK_SECONDS = 600;

export function chunkCommand(input: string, pattern: string) {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-i",
		input,
		"-map",
		"0:a:0",
		"-vn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-c:a",
		"libmp3lame",
		"-b:a",
		"48k",
		"-f",
		"segment",
		"-segment_time",
		String(CHUNK_SECONDS),
		"-reset_timestamps",
		"1",
		pattern,
	];
}

async function splitForUpload(input: string, dir: string) {
	await execFileAsync(
		getFfmpegBinaryPath(),
		chunkCommand(input, path.join(dir, "chunk-%03d.mp3")),
		{
			timeout: 30 * 60 * 1000,
		},
	);
	const chunks = (await fs.readdir(dir))
		.filter((name) => name.startsWith("chunk-") && name.endsWith(".mp3"))
		.sort()
		.map((name) => path.join(dir, name));
	if (chunks.length === 0) throw new Error("No audio was found to transcribe.");
	return chunks;
}

async function transcribeTrack(options: {
	endpoint: OpenAiEndpoint;
	model: string;
	input: string;
	language: string;
	label: string;
	onStatus?: MeetingStatusCallback;
	signal?: AbortSignal;
}) {
	const dir = await fs.mkdtemp(path.join(app.getPath("temp"), "recordly-meeting-api-"));
	try {
		const chunks = await splitForUpload(options.input, dir);
		const segments: TranscriptSegment[] = [];
		let language: string | null = null;
		for (const [index, chunk] of chunks.entries()) {
			options.signal?.throwIfAborted();
			options.onStatus?.(
				`Transcribing ${options.label}part ${index + 1} of ${chunks.length}…`,
				Math.round((index / chunks.length) * 100),
			);
			const offsetMs = index * CHUNK_SECONDS * 1000;
			const result = await transcribeAudioFile(
				options.endpoint,
				{ model: options.model, filePath: chunk, language: options.language },
				{ signal: options.signal, timeoutMs: 10 * 60 * 1000 },
			);
			language ??= languageCodeFromName(result.language);
			if (result.segments) {
				for (const segment of result.segments) {
					if (segment.text)
						segments.push({
							startMs: offsetMs + Math.round(segment.start * 1000),
							text: segment.text,
							speaker: null,
						});
				}
			} else if (result.text) {
				// No timings from this model: one paragraph per chunk at the chunk start.
				segments.push({ startMs: offsetMs, text: result.text, speaker: null });
			}
		}
		return { segments, language };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * API transcription. With both speaker tracks each is transcribed on its own
 * and merged into one Me/Remote timeline (two uploads, but no crosstalk).
 */
export async function transcribeWithApi(options: {
	endpoint: OpenAiEndpoint;
	model: string;
	inputs: MeetingAudioInputs;
	language: string;
	onStatus?: MeetingStatusCallback;
	signal?: AbortSignal;
}) {
	const { inputs } = options;
	if (inputs.mic && inputs.system) {
		const mic = await transcribeTrack({ ...options, input: inputs.mic, label: "your audio, " });
		const system = await transcribeTrack({
			...options,
			input: inputs.system,
			label: "other participants, ",
		});
		return {
			segments: mergeSpeakerSegments(mic.segments, system.segments),
			language: mic.language ?? system.language,
		};
	}
	return transcribeTrack({
		...options,
		input: inputs.mic ?? inputs.system ?? inputs.mediaPath,
		label: "",
	});
}
