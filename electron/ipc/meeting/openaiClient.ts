import fs from "node:fs/promises";
import path from "node:path";

/**
 * Minimal OpenAI-compatible client. The same code talks to the local
 * llama-server and to any API (OpenAI, OpenRouter, Ollama's /v1, LM Studio…).
 * Messages use content parts so images can be added later without a new client.
 */
export type ChatContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string | ChatContentPart[];
}

export interface OpenAiEndpoint {
	baseUrl: string;
	apiKey?: string | null;
}

export class OpenAiHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function endpointUrl(baseUrl: string, route: string) {
	return `${baseUrl.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

function authHeaders(endpoint: OpenAiEndpoint): Record<string, string> {
	return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

/** Turns a failed response into a message a user can act on. */
export function describeHttpError(status: number, body: string, context: string) {
	let detail = body.trim();
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } | string };
		detail =
			typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? detail);
	} catch {
		// Not JSON; keep the raw body.
	}
	detail = detail.slice(0, 400);
	if (status === 401 || status === 403)
		return `${context} was rejected (HTTP ${status}). Check the API key. ${detail}`.trim();
	if (status === 404)
		return `${context} failed: endpoint or model not found (HTTP 404). Check the base URL and model name. ${detail}`.trim();
	if (status === 429) return `${context} hit a rate or quota limit (HTTP 429). ${detail}`.trim();
	if (status === 413)
		return `${context} failed: the request was too large (HTTP 413). ${detail}`.trim();
	return `${context} failed (HTTP ${status}). ${detail}`.trim();
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postJson(
	endpoint: OpenAiEndpoint,
	route: string,
	body: unknown,
	context: string,
	options: { signal?: AbortSignal; timeoutMs: number },
) {
	let response: Response;
	try {
		response = await fetch(endpointUrl(endpoint.baseUrl, route), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders(endpoint) },
			body: JSON.stringify(body),
			signal: withTimeout(options.signal, options.timeoutMs),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError")
			throw new Error(
				`${context} timed out after ${Math.round(options.timeoutMs / 60000)} min.`,
			);
		throw error;
	}
	const text = await response.text();
	if (!response.ok)
		throw new OpenAiHttpError(
			response.status,
			describeHttpError(response.status, text, context),
		);
	return JSON.parse(text) as unknown;
}

export async function chatCompletion(
	endpoint: OpenAiEndpoint,
	request: {
		model: string;
		messages: ChatMessage[];
		maxTokens?: number;
		temperature?: number;
		/** Extra body fields, e.g. llama-server's chat_template_kwargs. */
		extra?: Record<string, unknown>;
	},
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
	const data = (await postJson(
		endpoint,
		"chat/completions",
		{
			model: request.model,
			messages: request.messages,
			...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
			...request.extra,
		},
		"Summarization",
		options,
	)) as {
		choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
	};
	const choice = data.choices?.[0];
	const content = choice?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		throw new Error(
			choice?.finish_reason === "length"
				? "The model ran out of answer space before writing anything (reasoning models can spend it all on thinking)."
				: "The model returned an empty answer.",
		);
	}
	return content;
}

export interface TranscriptionSegmentResult {
	start: number;
	text: string;
}

/**
 * whisper-1 returns timed segments with verbose_json; the gpt-4o transcribe
 * models only accept json/text.
 */
export function responseFormatFor(model: string) {
	return /^whisper/i.test(model) ? "verbose_json" : "json";
}

export async function transcribeAudioFile(
	endpoint: OpenAiEndpoint,
	request: { model: string; filePath: string; language?: string | null; prompt?: string },
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{
	text: string;
	segments: TranscriptionSegmentResult[] | null;
	language: string | null;
}> {
	const form = new FormData();
	const bytes = await fs.readFile(request.filePath);
	form.append("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(request.filePath));
	form.append("model", request.model);
	const format = responseFormatFor(request.model);
	form.append("response_format", format);
	if (request.language && request.language !== "auto") form.append("language", request.language);
	if (request.prompt) form.append("prompt", request.prompt);
	const response = await fetch(endpointUrl(endpoint.baseUrl, "audio/transcriptions"), {
		method: "POST",
		headers: authHeaders(endpoint),
		body: form,
		signal: withTimeout(options.signal, options.timeoutMs),
	});
	const text = await response.text();
	if (!response.ok)
		throw new OpenAiHttpError(
			response.status,
			describeHttpError(response.status, text, "Transcription"),
		);
	const data = JSON.parse(text) as {
		text?: string;
		language?: string;
		segments?: Array<{ start?: number; text?: string }>;
	};
	return {
		text: (data.text ?? "").trim(),
		language: data.language ?? null,
		segments: Array.isArray(data.segments)
			? data.segments.map((segment) => ({
					start: segment.start ?? 0,
					text: (segment.text ?? "").trim(),
				}))
			: null,
	};
}
