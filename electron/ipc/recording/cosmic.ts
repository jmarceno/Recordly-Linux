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
	path: string;
	file: WriteStream;
	/** Wall-clock time of the first captured sample. */
	startedAtMs: number | null;
	firstData: Promise<void>;
}

interface ActiveCosmicRecording {
	capture: ChildProcess;
	encoder: ChildProcess;
	audio: CosmicAudioTrack[];
	videoPath: string;
	outputPath: string;
	encoderExit: Promise<number | null>;
	/** Wall-clock time of the first video frame. */
	videoStartedAtMs: number;
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

	// Audio starts before the video. Each track remembers when its first sample
	// was captured, and the mux trims it to the first video frame.
	const pauseState = { paused: false };
	const audio: CosmicAudioTrack[] = [];
	const startAudio = (device: string, suffix: string) => {
		const file = path.join(recordingsDir, `.recording-${timestamp}.${suffix}.pcm`);
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

	const killAudio = () => {
		for (const track of audio) {
			track.process.kill("SIGKILL");
			track.file.destroy();
		}
	};
	const capture = spawn(getCaptureHelperPath(), [outputName, String(CAPTURE_FPS)], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let format: Awaited<ReturnType<typeof readCaptureFormat>>;
	try {
		format = await readCaptureFormat(capture);
	} catch (error) {
		capture.kill();
		killAudio();
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
		capture,
		encoder,
		audio,
		videoPath,
		outputPath,
		encoderExit: waitForExit(encoder),
		videoStartedAtMs,
		pauseState,
	};
	console.log(
		`[cosmic-capture] Recording ${outputName} ${format.width}x${format.height} transform ${format.transform} to ${outputPath}`,
	);
	return { success: true };
}

export function pauseCosmicRecording() {
	if (!active) return { success: false, message: "No screen recording is active." };
	if (!active.pauseState.paused) {
		active.capture.stdin?.write("pause\n");
		active.pauseState.paused = true;
	}
	return { success: true };
}

export function resumeCosmicRecording() {
	if (!active) return { success: false, message: "No screen recording is active." };
	if (active.pauseState.paused) {
		active.capture.stdin?.write("resume\n");
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
	const shiftMs = cursorCaptureStartTimeMs - recording.videoStartedAtMs;
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

export async function stopCosmicRecording(): Promise<{
	success: boolean;
	path?: string;
	error?: string;
}> {
	const recording = active;
	if (!recording) return { success: false, error: "No screen recording is active." };
	active = null;

	recording.capture.stdin?.end("stop\n");
	const audioExits = recording.audio.map(async (track) => {
		track.process.kill("SIGINT");
		await waitForExit(track.process);
		await new Promise<void>((resolve) => track.file.end(resolve));
	});
	await waitForExit(recording.capture);
	await persistCosmicCursorTelemetry(recording);
	const [encoderCode] = await Promise.all([recording.encoderExit, ...audioExits]);
	if (encoderCode !== 0) {
		return { success: false, error: `The video encoder exited with code ${encoderCode}.` };
	}

	const audioTracks: CosmicAudioTrack[] = [];
	for (const track of recording.audio) {
		if (track.startedAtMs !== null && (await hasAudioData(track.path))) audioTracks.push(track);
		else console.warn(`[cosmic-capture] No audio captured in ${track.path}`);
	}

	const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", recording.videoPath];
	for (const track of audioTracks) {
		args.push("-f", "s16le", "-ar", String(AUDIO_RATE), "-ac", "2", "-i", track.path);
	}
	args.push("-map", "0:v");
	if (audioTracks.length > 0) {
		// Line each track up with the first video frame.
		const chains = audioTracks.map((track, index) => {
			const offsetMs = Math.round((track.startedAtMs ?? 0) - recording.videoStartedAtMs);
			console.log(`[cosmic-capture] ${path.basename(track.path)} audio offset ${offsetMs}ms`);
			const align =
				offsetMs > 0
					? `adelay=${offsetMs}:all=1`
					: `atrim=start=${(-offsetMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`;
			return `[${index + 1}:a]${align}[a${index}]`;
		});
		const mixed =
			audioTracks.length === 1
				? chains[0].replace(/\[a0\]$/, "[a]")
				: `${chains.join(";")};${audioTracks.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioTracks.length}:duration=longest:normalize=0[a]`;
		args.push("-filter_complex", mixed, "-map", "[a]");
	}
	args.push("-c:v", "copy");
	if (audioTracks.length > 0) args.push("-c:a", "aac", "-b:a", "192k");
	args.push("-movflags", "+faststart", "-shortest", recording.outputPath);

	const mux = spawn(getFfmpegBinaryPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
	let muxError = "";
	mux.stderr?.on("data", (chunk: Buffer) => {
		muxError += chunk.toString();
	});
	const muxCode = await waitForExit(mux);
	if (muxCode !== 0) {
		return { success: false, error: muxError.trim() || `Muxing failed with code ${muxCode}.` };
	}

	await Promise.all(
		[recording.videoPath, ...recording.audio.map((entry) => entry.path)].map((file) =>
			fs.rm(file, { force: true }),
		),
	);
	console.log(`[cosmic-capture] Saved ${recording.outputPath}`);
	return { success: true, path: recording.outputPath };
}

/** Stops the processes without producing a file. */
export async function discardCosmicRecording() {
	const recording = active;
	if (!recording) return;
	active = null;
	recording.capture.kill();
	recording.encoder.kill();
	for (const track of recording.audio) {
		track.process.kill("SIGKILL");
		track.file.destroy();
	}
	await Promise.all([waitForExit(recording.capture), recording.encoderExit]);
	await Promise.all(
		[recording.videoPath, ...recording.audio.map((entry) => entry.path)].map((file) =>
			fs.rm(file, { force: true }),
		),
	);
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
