import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { snapshotCursorTelemetryForPersistence, writeCursorTelemetry } from "../cursor/telemetry";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getPrebundledNativeHelperPath } from "../paths/binaries";
import { cursorCaptureStartTimeMs, pendingCursorSamples, setPendingCursorSamples } from "../state";
import type { NativeMacRecordingOptions, SelectedSource } from "../types";
import { getRecordingsDir } from "../utils";

/**
 * Native screen recording for Wayland compositors with ext-image-copy-capture
 * (COSMIC). The xdg-desktop-portal screencast shows stale browser content after
 * tab switches and stalls on rotated outputs, so video comes straight from the
 * compositor and audio from PulseAudio (parec), then everything is muxed.
 */

const execFileAsync = promisify(execFile);
const CAPTURE_FPS = 60;
export const COSMIC_SOURCE_PREFIX = "screen:cosmic:";

export interface CosmicOutput {
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

// parec writes s16le stereo at 48 kHz: 192 bytes per millisecond.
const AUDIO_RATE = 48000;
const AUDIO_BYTES_PER_MS = (AUDIO_RATE * 2 * 2) / 1000;

interface CosmicAudioTrack {
	process: ChildProcess;
	role: "mic" | "system";
	path: string;
	file: WriteStream;
	/** Wall-clock time of the first captured sample. */
	startedAtMs: number | null;
	firstData: Promise<void>;
}

interface CosmicVideoCapture {
	capture: ChildProcess;
	encoder: ChildProcess;
	videoPath: string;
	encoderExit: Promise<number | null>;
}

interface ActiveCosmicRecording {
	/** Null for audio-only (meeting) recordings. */
	video: CosmicVideoCapture | null;
	audio: CosmicAudioTrack[];
	outputPath: string;
	/** Wall-clock time every track is aligned to: the first video frame, or the first audio sample. */
	startedAtMs: number;
	keepSpeakerTracks: boolean;
	pauseState: { paused: boolean };
}

let active: ActiveCosmicRecording | null = null;

function getCaptureHelperPath() {
	return getPrebundledNativeHelperPath("recordly-wayland-capture", "linux-x64");
}

export function isCosmicSource(source: SelectedSource | null | undefined) {
	return Boolean(source?.id?.startsWith(COSMIC_SOURCE_PREFIX));
}

export function isCosmicRecordingActive() {
	return active !== null;
}

export async function listCosmicOutputs(): Promise<CosmicOutput[]> {
	const { stdout } = await execFileAsync(getCaptureHelperPath(), ["--list"], { timeout: 5000 });
	return stdout
		.split("\n")
		.map((line) => line.match(/^OUTPUT (\S+) (-?\d+) (-?\d+) (\d+) (\d+)$/))
		.filter((match): match is RegExpMatchArray => match !== null)
		.map((match) => ({
			name: match[1],
			x: Number(match[2]),
			y: Number(match[3]),
			width: Number(match[4]),
			height: Number(match[5]),
		}));
}

/** The PulseAudio source whose description matches Chromium's device label. */
async function resolvePulseMicrophone(label?: string): Promise<string> {
	if (!label || /^default$/i.test(label)) return "@DEFAULT_SOURCE@";
	try {
		const { stdout } = await execFileAsync("pactl", ["-f", "json", "list", "sources"]);
		const sources = JSON.parse(stdout) as { name: string; description: string }[];
		const match = sources.find(
			(source) =>
				source.description === label ||
				label.includes(source.description) ||
				source.description.includes(label),
		);
		if (match) return match.name;
	} catch (error) {
		console.warn("[cosmic-capture] Could not list PulseAudio sources:", error);
	}
	return "@DEFAULT_SOURCE@";
}

function transposeFilter(transform: number): string | null {
	const flip = transform >= 4 ? "hflip," : "";
	switch (transform % 4) {
		case 1:
			return `${flip}transpose=1`;
		case 2:
			return `${flip}hflip,vflip`;
		case 3:
			return `${flip}transpose=2`;
		default:
			return flip ? "hflip" : null;
	}
}

function waitForExit(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(child.exitCode);
	}
	return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

/** Resolves with the helper's FORMAT line, or rejects with its error. */
function readCaptureFormat(capture: ChildProcess) {
	return new Promise<{ width: number; height: number; pixelFormat: string; transform: number }>(
		(resolve, reject) => {
			let stderr = "";
			const onData = (chunk: Buffer) => {
				stderr += chunk.toString();
				const match = stderr.match(/^FORMAT (\d+) (\d+) (\w+) (\d+)$/m);
				if (match) {
					capture.stderr?.off("data", onData);
					resolve({
						width: Number(match[1]),
						height: Number(match[2]),
						pixelFormat: match[3],
						transform: Number(match[4]),
					});
				}
			};
			capture.stderr?.on("data", onData);
			capture.once("exit", () =>
				reject(new Error(stderr.trim() || "The screen capture helper exited early.")),
			);
		},
	);
}

/**
 * Starts one parec per requested device. Audio starts before any video; each
 * track remembers when its first sample was captured so the mux can align it.
 */
async function startAudioTracks(
	recordingsDir: string,
	timestamp: number,
	options: NativeMacRecordingOptions | undefined,
	pauseState: { paused: boolean },
): Promise<CosmicAudioTrack[]> {
	const audio: CosmicAudioTrack[] = [];
	const startAudio = (device: string, role: "mic" | "system") => {
		const file = path.join(recordingsDir, `.recording-${timestamp}.${role}.pcm`);
		const child = spawn(
			"parec",
			[
				`--device=${device}`,
				"--raw",
				"--format=s16le",
				`--rate=${AUDIO_RATE}`,
				"--channels=2",
				"--latency-msec=20",
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let resolveFirstData!: () => void;
		const track: CosmicAudioTrack = {
			process: child,
			role,
			path: file,
			file: createWriteStream(file),
			startedAtMs: null,
			firstData: new Promise((resolve) => {
				resolveFirstData = resolve;
			}),
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (track.startedAtMs === null) {
				track.startedAtMs = Date.now() - chunk.length / AUDIO_BYTES_PER_MS;
				resolveFirstData();
			}
			// Paused audio is dropped, matching the video, which stops emitting frames.
			if (!pauseState.paused) track.file.write(chunk);
		});
		child.once("exit", () => resolveFirstData());
		audio.push(track);
		console.log(`[cosmic-capture] Recording audio from ${device}`);
	};
	if (options?.capturesSystemAudio) {
		// The monitor's own volume scales what capture apps get, not what you hear;
		// a low value there records near-silence.
		await execFileAsync("pactl", ["set-source-volume", "@DEFAULT_MONITOR@", "100%"]).catch(
			() => undefined,
		);
		startAudio("@DEFAULT_MONITOR@", "system");
	}
	if (options?.capturesMicrophone) {
		startAudio(await resolvePulseMicrophone(options.microphoneLabel), "mic");
	}
	await Promise.race([
		Promise.all(audio.map((track) => track.firstData)),
		new Promise((resolve) => setTimeout(resolve, 1500)),
	]);
	return audio;
}

function killAudioTracks(audio: CosmicAudioTrack[]) {
	for (const track of audio) {
		track.process.kill("SIGKILL");
		track.file.destroy();
	}
}

export async function startCosmicRecording(
	source: SelectedSource,
	options: NativeMacRecordingOptions | undefined,
): Promise<{ success: boolean; message?: string }> {
	if (active) return { success: false, message: "A screen recording is already active." };
	const outputName = (source.id ?? "").slice(COSMIC_SOURCE_PREFIX.length);
	const recordingsDir = await getRecordingsDir();
	const timestamp = Date.now();
	const outputPath = path.join(recordingsDir, `recording-${timestamp}.mp4`);
	const videoPath = path.join(recordingsDir, `.recording-${timestamp}.video.mkv`);

	const pauseState = { paused: false };
	const audio = await startAudioTracks(recordingsDir, timestamp, options, pauseState);

	const capture = spawn(getCaptureHelperPath(), [outputName, String(CAPTURE_FPS)], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let format: Awaited<ReturnType<typeof readCaptureFormat>>;
	try {
		format = await readCaptureFormat(capture);
	} catch (error) {
		capture.kill();
		killAudioTracks(audio);
		return { success: false, message: error instanceof Error ? error.message : String(error) };
	}
	// The helper prints FORMAT right after grabbing the first frame and its
	// frame clock starts there.
	const videoStartedAtMs = Date.now();

	const filters = [transposeFilter(format.transform), "format=yuv420p"].filter(Boolean);
	const encoder = spawn(
		getFfmpegBinaryPath(),
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"rawvideo",
			"-pix_fmt",
			format.pixelFormat,
			"-s",
			`${format.width}x${format.height}`,
			"-r",
			String(CAPTURE_FPS),
			"-i",
			"pipe:0",
			"-vf",
			filters.join(","),
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-crf",
			"18",
			"-g",
			String(CAPTURE_FPS * 2),
			videoPath,
		],
		{ stdio: ["pipe", "ignore", "pipe"] },
	);
	encoder.stderr?.on("data", (chunk: Buffer) =>
		console.warn("[cosmic-capture] ffmpeg:", chunk.toString().trim()),
	);
	capture.stdout?.pipe(encoder.stdin!);
	capture.stderr?.on("data", (chunk: Buffer) =>
		console.warn("[cosmic-capture] helper:", chunk.toString().trim()),
	);

	active = {
		video: { capture, encoder, videoPath, encoderExit: waitForExit(encoder) },
		audio,
		outputPath,
		startedAtMs: videoStartedAtMs,
		keepSpeakerTracks: Boolean(options?.keepSpeakerTracks),
		pauseState,
	};
	console.log(
		`[cosmic-capture] Recording ${outputName} ${format.width}x${format.height} transform ${format.transform} to ${outputPath}`,
	);
	return { success: true };
}

/** Records only audio (a meeting without the screen) into an .m4a. */
export async function startCosmicAudioRecording(
	options: NativeMacRecordingOptions | undefined,
): Promise<{ success: boolean; message?: string }> {
	if (active) return { success: false, message: "A recording is already active." };
	if (!options?.capturesMicrophone && !options?.capturesSystemAudio) {
		return { success: false, message: "Choose a microphone or system audio to record." };
	}
	const recordingsDir = await getRecordingsDir();
	const timestamp = Date.now();
	const pauseState = { paused: false };
	const audio = await startAudioTracks(recordingsDir, timestamp, options, pauseState);
	const starts = audio.flatMap((track) =>
		track.startedAtMs === null ? [] : [track.startedAtMs],
	);
	if (starts.length === 0) {
		killAudioTracks(audio);
		return { success: false, message: "No audio device produced any sound data." };
	}
	active = {
		video: null,
		audio,
		outputPath: path.join(recordingsDir, `recording-${timestamp}.m4a`),
		startedAtMs: Math.min(...starts),
		keepSpeakerTracks: Boolean(options.keepSpeakerTracks),
		pauseState,
	};
	console.log(`[cosmic-capture] Recording audio only to ${active.outputPath}`);
	return { success: true };
}

export function pauseCosmicRecording() {
	if (!active) return { success: false, message: "No screen recording is active." };
	if (!active.pauseState.paused) {
		active.video?.capture.stdin?.write("pause\n");
		active.pauseState.paused = true;
	}
	return { success: true };
}

export function resumeCosmicRecording() {
	if (!active) return { success: false, message: "No screen recording is active." };
	if (active.pauseState.paused) {
		active.video?.capture.stdin?.write("resume\n");
		active.pauseState.paused = false;
	}
	return { success: true };
}

async function hasAudioData(file: string) {
	try {
		// A WAV header alone is 44 bytes.
		return (await fs.stat(file)).size > 1024;
	} catch {
		return false;
	}
}

/**
 * Saves the cursor telemetry next to the screen video, on the video's clock.
 * The cursor clock starts when the renderer reports the recording as started,
 * a little after the first frame.
 */
async function persistCosmicCursorTelemetry(recording: ActiveCosmicRecording) {
	snapshotCursorTelemetryForPersistence();
	const shiftMs = cursorCaptureStartTimeMs - recording.startedAtMs;
	const appliedShiftMs = shiftMs > 0 && shiftMs < 5000 ? shiftMs : 0;
	const samples = pendingCursorSamples.map((sample) => ({
		...sample,
		timeMs: sample.timeMs + appliedShiftMs,
	}));
	setPendingCursorSamples([]);
	try {
		await writeCursorTelemetry(recording.outputPath, samples);
		console.log(
			`[cosmic-capture] Saved ${samples.length} cursor samples (shifted ${appliedShiftMs}ms)`,
		);
	} catch (error) {
		console.warn("[cosmic-capture] Failed to save cursor telemetry:", error);
	}
}

/** ffmpeg filter that lines a raw track up with the recording's reference start. */
export function alignTrackFilter(trackStartedAtMs: number, referenceMs: number) {
	const offsetMs = Math.round(trackStartedAtMs - referenceMs);
	return offsetMs > 0
		? `adelay=${offsetMs}:all=1`
		: `atrim=start=${(-offsetMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`;
}

/** Path of the per-speaker meeting track kept next to a recording. */
export function speakerTrackPath(outputPath: string, role: "mic" | "system") {
	return outputPath.replace(/\.[^./\\]+$/, "") + `.meeting-${role}.opus`;
}

async function runFfmpeg(args: string[]) {
	const child = spawn(getFfmpegBinaryPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const code = await waitForExit(child);
	return { code, stderr: stderr.trim() };
}

const rawTrackInput = (file: string) => [
	"-f",
	"s16le",
	"-ar",
	String(AUDIO_RATE),
	"-ac",
	"2",
	"-i",
	file,
];

export async function stopCosmicRecording(): Promise<{
	success: boolean;
	path?: string;
	error?: string;
	/** Set for meeting recordings (speaker tracks kept). */
	meeting?: { hasVideo: boolean };
}> {
	const recording = active;
	if (!recording) return { success: false, error: "No screen recording is active." };
	active = null;

	const { video } = recording;
	video?.capture.stdin?.end("stop\n");
	const audioExits = recording.audio.map(async (track) => {
		track.process.kill("SIGINT");
		await waitForExit(track.process);
		await new Promise<void>((resolve) => track.file.end(resolve));
	});
	if (video) {
		await waitForExit(video.capture);
		await persistCosmicCursorTelemetry(recording);
	}
	const [encoderCode] = await Promise.all([video?.encoderExit ?? 0, ...audioExits]);
	if (encoderCode !== 0) {
		return { success: false, error: `The video encoder exited with code ${encoderCode}.` };
	}

	const audioTracks: CosmicAudioTrack[] = [];
	for (const track of recording.audio) {
		if (track.startedAtMs !== null && (await hasAudioData(track.path))) audioTracks.push(track);
		else console.warn(`[cosmic-capture] No audio captured in ${track.path}`);
	}
	if (!video && audioTracks.length === 0) {
		await removeCosmicTempFiles(recording);
		return { success: false, error: "No audio was captured." };
	}

	const args = ["-hide_banner", "-loglevel", "error", "-y"];
	if (video) args.push("-i", video.videoPath);
	const firstAudioInput = video ? 1 : 0;
	for (const track of audioTracks) args.push(...rawTrackInput(track.path));
	if (video) args.push("-map", "0:v");
	if (audioTracks.length > 0) {
		// Line each track up with the first video frame (or the earliest audio sample).
		const chains = audioTracks.map((track, index) => {
			const align = alignTrackFilter(track.startedAtMs ?? 0, recording.startedAtMs);
			console.log(`[cosmic-capture] ${path.basename(track.path)} align ${align}`);
			return `[${index + firstAudioInput}:a]${align}[a${index}]`;
		});
		const mixed =
			audioTracks.length === 1
				? chains[0].replace(/\[a0\]$/, "[a]")
				: `${chains.join(";")};${audioTracks.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioTracks.length}:duration=longest:normalize=0[a]`;
		args.push("-filter_complex", mixed, "-map", "[a]");
	}
	if (video) args.push("-c:v", "copy");
	if (audioTracks.length > 0) args.push("-c:a", "aac", "-b:a", "192k");
	args.push("-movflags", "+faststart");
	if (video) args.push("-shortest");
	args.push(recording.outputPath);

	// Speaker tracks are transcription input only: mono, aligned like the mix,
	// never played back (listeners always get the mixed track above).
	const speakerTracks = recording.keepSpeakerTracks
		? audioTracks.map((track) =>
				runFfmpeg([
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					...rawTrackInput(track.path),
					"-af",
					alignTrackFilter(track.startedAtMs ?? 0, recording.startedAtMs),
					"-ac",
					"1",
					"-c:a",
					"libopus",
					"-b:a",
					"48k",
					speakerTrackPath(recording.outputPath, track.role),
				]),
			)
		: [];

	const [mux, ...speakers] = await Promise.all([runFfmpeg(args), ...speakerTracks]);
	if (mux.code !== 0) {
		return { success: false, error: mux.stderr || `Muxing failed with code ${mux.code}.` };
	}
	for (const result of speakers) {
		if (result.code !== 0)
			console.warn("[cosmic-capture] Speaker track failed:", result.stderr);
	}

	await removeCosmicTempFiles(recording);
	console.log(`[cosmic-capture] Saved ${recording.outputPath}`);
	return {
		success: true,
		path: recording.outputPath,
		...(recording.keepSpeakerTracks ? { meeting: { hasVideo: Boolean(video) } } : {}),
	};
}

async function removeCosmicTempFiles(recording: ActiveCosmicRecording) {
	const files = recording.audio.map((entry) => entry.path);
	if (recording.video) files.push(recording.video.videoPath);
	await Promise.all(files.map((file) => fs.rm(file, { force: true })));
}

/** Stops the processes without producing a file. */
export async function discardCosmicRecording() {
	const recording = active;
	if (!recording) return;
	active = null;
	recording.video?.capture.kill();
	recording.video?.encoder.kill();
	killAudioTracks(recording.audio);
	if (recording.video) {
		await Promise.all([waitForExit(recording.video.capture), recording.video.encoderExit]);
	}
	await removeCosmicTempFiles(recording);
}

/** Waits for the next mouse click anywhere and resolves with the output under it. */
export function waitForCosmicOutputClick(timeoutMs = 15000): Promise<CosmicOutput | null> {
	return new Promise((resolve) => {
		const helper = spawn(
			getPrebundledNativeHelperPath("recordly-wayland-cursor", "linux-x64"),
			[],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		let point: { x: number; y: number } | null = null;
		let buffer = "";
		let settled = false;
		const finish = async (picked: { x: number; y: number } | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			helper.stdin?.end();
			helper.kill();
			if (!picked) return resolve(null);
			const outputs = await listCosmicOutputs().catch(() => []);
			resolve(
				outputs.find(
					(output) =>
						picked.x >= output.x &&
						picked.x < output.x + output.width &&
						picked.y >= output.y &&
						picked.y < output.y + output.height,
				) ?? null,
			);
		};
		const timer = setTimeout(() => void finish(null), timeoutMs);
		helper.on("exit", () => void finish(null));
		helper.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const position = line.match(/^POS:(-?\d+):(-?\d+)$/);
				if (position) point = { x: Number(position[1]), y: Number(position[2]) };
				else if (line.startsWith("INTERACTION:mousedown") && point) void finish(point);
			}
		});
	});
}
