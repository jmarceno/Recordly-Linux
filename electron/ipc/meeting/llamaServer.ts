import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { MeetingStatusCallback } from "./context";
import {
	ensureAsset,
	getLlamaServerPath,
	LLAMA_RUNTIME,
	LOCAL_LLM_MODELS,
	type LocalLlmModelId,
} from "./assets";

/**
 * Runs llama.cpp's server on demand for local summarization. It is started for
 * a job and stopped right after, so it never holds memory between meetings and
 * never runs at the same time as whisper.
 */

/** Context window for local runs. ~1 h of talk; longer meetings are chunked. */
export const LOCAL_CONTEXT_TOKENS = 16_384;

interface RunningServer {
	process: ChildProcess;
	modelId: LocalLlmModelId;
	baseUrl: string;
}

let running: RunningServer | null = null;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("No free port for the local model server.")),
			);
		});
	});
}

export function llamaServerArgs(modelPath: string, port: number) {
	return [
		"-m",
		modelPath,
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"-c",
		String(LOCAL_CONTEXT_TOKENS),
		// One request at a time; more slots only split the context.
		"-np",
		"1",
		// Offload as much as fits in free VRAM, the rest stays on the CPU.
		"--fit",
		"on",
		"--no-webui",
	];
}

async function waitForHealth(baseUrl: string, child: ChildProcess, log: () => string) {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`The local model server stopped while loading: ${log()}`);
		}
		try {
			const response = await fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("The local model server did not become ready within 2 minutes.");
}

/** Downloads what is missing, starts the server and returns its OpenAI base URL. */
export async function startLocalModelServer(
	modelId: LocalLlmModelId,
	onStatus?: MeetingStatusCallback,
): Promise<string> {
	if (running?.modelId === modelId && running.process.exitCode === null) return running.baseUrl;
	await stopLocalModelServer();

	const model = LOCAL_LLM_MODELS[modelId];
	await ensureAsset(LLAMA_RUNTIME, (percent) =>
		onStatus?.("Downloading the local model runtime…", percent),
	);
	await ensureAsset(model, (percent) => onStatus?.(`Downloading ${model.label}…`, percent));

	onStatus?.(`Loading ${model.label}…`);
	const port = await freePort();
	const binary = getLlamaServerPath();
	const child = spawn(binary, llamaServerArgs(model.path, port), {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, LD_LIBRARY_PATH: path.dirname(binary) },
	});
	let logTail = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		logTail = (logTail + chunk.toString()).slice(-3000);
	});
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		await waitForHealth(baseUrl, child, () => logTail.trim().split("\n").slice(-4).join(" "));
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
	running = { process: child, modelId, baseUrl: `${baseUrl}/v1` };
	return running.baseUrl;
}

export async function stopLocalModelServer() {
	const server = running;
	running = null;
	if (!server || server.process.exitCode !== null) return;
	const exited = new Promise((resolve) => server.process.once("exit", resolve));
	server.process.kill("SIGTERM");
	const timer = setTimeout(() => server.process.kill("SIGKILL"), 5000);
	await exited;
	clearTimeout(timer);
}
