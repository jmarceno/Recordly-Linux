import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getPrebundledNativeHelperPath } from "../paths/binaries";
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

interface ActiveCosmicRecording {
	capture: ChildProcess;
	encoder: ChildProcess;
	audio: { process: ChildProcess; path: string }[];
	videoPath: string;
	outputPath: string;
	encoderExit: Promise<number | null>;
	paused: boolean;
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

	const capture = spawn(getCaptureHelperPath(), [outputName, String(CAPTURE_FPS)], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let format: Awaited<ReturnType<typeof readCaptureFormat>>;
	try {
		format = await readCaptureFormat(capture);
	} catch (error) {
		capture.kill();
		return { success: false, message: error instanceof Error ? error.message : String(error) };
	}

	// Audio starts alongside the first frames so the tracks line up.
	const audio: ActiveCosmicRecording["audio"] = [];
	const startAudio = (device: string, suffix: string) => {
		const file = path.join(recordingsDir, `.recording-${timestamp}.${suffix}.wav`);
		const child = spawn(
			"parec",
			[
				`--device=${device}`,
				"--file-format=wav",
				"--rate=48000",
				"--channels=2",
				"--latency-msec=20",
				file,
			],
			{ stdio: "ignore" },
		);
		audio.push({ process: child, path: file });
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
		paused: false,
	};
	console.log(
		`[cosmic-capture] Recording ${outputName} ${format.width}x${format.height} transform ${format.transform} to ${outputPath}`,
	);
	return { success: true };
}

export function pauseCosmicRecording() {
	if (!active) return { success: false, message: "No screen recording is active." };
	if (!active.paused) {
		active.capture.stdin?.write("pause\n");
		for (const { process } of active.audio) process.kill("SIGSTOP");
		active.paused = true;
	}
	return { success: true };
}

export function resumeCosmicRecording() {
	if (!active) return { success: false, message: "No screen recording is active." };
	if (active.paused) {
		active.capture.stdin?.write("resume\n");
		for (const { process } of active.audio) process.kill("SIGCONT");
		active.paused = false;
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

export async function stopCosmicRecording(): Promise<{
	success: boolean;
	path?: string;
	error?: string;
}> {
	const recording = active;
	if (!recording) return { success: false, error: "No screen recording is active." };
	active = null;

	if (recording.paused) {
		for (const { process } of recording.audio) process.kill("SIGCONT");
	}
	recording.capture.stdin?.end("stop\n");
	const audioExits = recording.audio.map(({ process }) => {
		process.kill("SIGINT");
		return waitForExit(process);
	});
	await waitForExit(recording.capture);
	const [encoderCode] = await Promise.all([recording.encoderExit, ...audioExits]);
	if (encoderCode !== 0) {
		return { success: false, error: `The video encoder exited with code ${encoderCode}.` };
	}

	const audioFiles: string[] = [];
	for (const { path: file } of recording.audio) {
		if (await hasAudioData(file)) audioFiles.push(file);
		else console.warn(`[cosmic-capture] No audio captured in ${file}`);
	}

	const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", recording.videoPath];
	for (const file of audioFiles) args.push("-i", file);
	args.push("-map", "0:v");
	if (audioFiles.length === 1) {
		args.push("-map", "1:a");
	} else if (audioFiles.length > 1) {
		const inputs = audioFiles.map((_, index) => `[${index + 1}:a]`).join("");
		args.push(
			"-filter_complex",
			`${inputs}amix=inputs=${audioFiles.length}:duration=longest:normalize=0[a]`,
			"-map",
			"[a]",
		);
	}
	args.push("-c:v", "copy");
	if (audioFiles.length > 0) args.push("-c:a", "aac", "-b:a", "192k");
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
	for (const { process } of recording.audio) process.kill("SIGKILL");
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
