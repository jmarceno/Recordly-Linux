import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { USER_DATA_PATH } from "../../appPaths";
import { downloadFileWithProgress } from "../captions/whisper";
import { WHISPER_MODEL_DIR } from "../constants";

const execFileAsync = promisify(execFile);

/**
 * Everything meeting mode downloads on first use: whisper models, the local
 * LLM runtime (llama.cpp's prebuilt server) and the GGUF models. Pinned URLs
 * and SHA-256 so installs are reproducible; bump the hash with the URL.
 */
export interface MeetingAsset {
	id: string;
	label: string;
	url: string;
	sha256: string;
	sizeBytes: number;
	/** Final file (or, for archives, the directory they extract into). */
	path: string;
	archive?: "tar.gz";
}

export const MEETING_DIR = path.join(USER_DATA_PATH, "meeting");
const LLM_MODEL_DIR = path.join(MEETING_DIR, "models");
const LLAMA_RUNTIME_DIR = path.join(MEETING_DIR, "llama");

export const LLAMA_RELEASE = "b11829";

/** The Vulkan build also carries the CPU backends and falls back to them without a GPU. */
export const LLAMA_RUNTIME: MeetingAsset = {
	id: "llama-runtime",
	label: `llama.cpp ${LLAMA_RELEASE} (Vulkan)`,
	url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`,
	sha256: "656bd1425bdde09565f2191c2a62940a1992441497fc5fb5fd45cdfa337e621f",
	sizeBytes: 34_989_558,
	path: path.join(LLAMA_RUNTIME_DIR, LLAMA_RELEASE),
	archive: "tar.gz",
};

export function getLlamaServerPath() {
	return path.join(LLAMA_RUNTIME.path, `llama-${LLAMA_RELEASE}`, "llama-server");
}

export const WHISPER_MODELS = {
	"large-v3-turbo-q5_0": {
		id: "large-v3-turbo-q5_0",
		label: "Whisper large-v3-turbo (q5)",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
		sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
		sizeBytes: 574_041_195,
		path: path.join(WHISPER_MODEL_DIR, "ggml-large-v3-turbo-q5_0.bin"),
	},
	small: {
		id: "small",
		label: "Whisper small",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
		sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
		sizeBytes: 487_601_967,
		path: path.join(WHISPER_MODEL_DIR, "ggml-small.bin"),
	},
} satisfies Record<string, MeetingAsset>;

export type WhisperModelId = keyof typeof WHISPER_MODELS;

/** Silero voice detection: whisper only decodes speech, so silence cannot turn into invented text. */
export const WHISPER_VAD_MODEL: MeetingAsset = {
	id: "whisper-vad",
	label: "Silero voice detection",
	url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
	sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
	sizeBytes: 885_098,
	path: path.join(WHISPER_MODEL_DIR, "ggml-silero-v5.1.2.bin"),
};

export const LOCAL_LLM_MODELS = {
	"qwen3.5-2b": {
		id: "qwen3.5-2b",
		label: "Qwen3.5 2B (Q4_K_M)",
		url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
		sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
		sizeBytes: 1_280_835_840,
		path: path.join(LLM_MODEL_DIR, "Qwen3.5-2B-Q4_K_M.gguf"),
	},
	"qwen3.5-4b": {
		id: "qwen3.5-4b",
		label: "Qwen3.5 4B (Q4_K_M)",
		url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
		sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
		sizeBytes: 2_740_937_888,
		path: path.join(LLM_MODEL_DIR, "Qwen3.5-4B-Q4_K_M.gguf"),
	},
} satisfies Record<string, MeetingAsset>;

export type LocalLlmModelId = keyof typeof LOCAL_LLM_MODELS;

export function findMeetingAsset(id: string): MeetingAsset | null {
	if (id === LLAMA_RUNTIME.id) return LLAMA_RUNTIME;
	const all: MeetingAsset[] = [
		...Object.values(WHISPER_MODELS),
		WHISPER_VAD_MODEL,
		...Object.values(LOCAL_LLM_MODELS),
	];
	return all.find((asset) => asset.id === id) ?? null;
}

export async function isAssetInstalled(asset: MeetingAsset) {
	try {
		await fs.access(asset.archive ? getAssetMarker(asset) : asset.path);
		return true;
	} catch {
		return false;
	}
}

function getAssetMarker(asset: MeetingAsset) {
	return path.join(asset.path, ".installed");
}

async function sha256Of(file: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

const inFlight = new Map<string, Promise<string>>();

/** Downloads and verifies an asset once; concurrent callers share the download. */
export function ensureAsset(asset: MeetingAsset, onProgress?: (percent: number) => void) {
	const running = inFlight.get(asset.id);
	if (running) return running;
	const job = installAsset(asset, onProgress).finally(() => inFlight.delete(asset.id));
	inFlight.set(asset.id, job);
	return job;
}

async function installAsset(asset: MeetingAsset, onProgress?: (percent: number) => void) {
	if (await isAssetInstalled(asset)) return asset.path;
	const download = `${asset.path}.download`;
	await fs.mkdir(path.dirname(asset.path), { recursive: true });
	await fs.rm(download, { force: true });
	try {
		await downloadFileWithProgress(asset.url, download, (percent) => onProgress?.(percent));
		const actual = await sha256Of(download);
		if (actual !== asset.sha256) {
			throw new Error(`${asset.label} failed its checksum (got ${actual}).`);
		}
		if (asset.archive) {
			await fs.rm(asset.path, { recursive: true, force: true });
			await fs.mkdir(asset.path, { recursive: true });
			await execFileAsync("tar", ["-xzf", download, "-C", asset.path]);
			await fs.writeFile(getAssetMarker(asset), asset.sha256);
			await fs.rm(download, { force: true });
		} else {
			await fs.rename(download, asset.path);
		}
		return asset.path;
	} catch (error) {
		await fs.rm(download, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function removeAsset(asset: MeetingAsset) {
	await fs.rm(asset.path, { recursive: true, force: true });
}
