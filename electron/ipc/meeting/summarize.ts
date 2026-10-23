import type { MeetingContext, MeetingStatusCallback, SummarizerCapability } from "./context";
import { type ChatMessage, chatCompletion, type OpenAiEndpoint } from "./openaiClient";
import {
	chunkTranscript,
	cleanTitle,
	tidyNotes,
	effectivePrompt,
	MERGE_SUMMARY_PROMPT,
	PARTIAL_SUMMARY_PROMPT,
	renderPrompt,
	SUMMARY_PROMPT,
	stripThinking,
	TITLE_PROMPT,
	withLanguageInstruction,
} from "./prompts";

/**
 * A summarizer turns a MeetingContext into notes. Implementations declare what
 * they can take in; today only text is sent, and a vision-capable one can
 * later use `context.visuals` / `context.videoPath` without changing callers.
 */
export interface Summarizer {
	readonly capabilities: ReadonlySet<SummarizerCapability>;
	summarize(
		context: MeetingContext,
		options: { onStatus?: MeetingStatusCallback; signal?: AbortSignal },
	): Promise<string>;
	title(notes: string, context: MeetingContext, signal?: AbortSignal): Promise<string>;
}

export interface ChatSummarizerConfig {
	endpoint: OpenAiEndpoint;
	model: string;
	capabilities: SummarizerCapability[];
	/** Transcript characters that fit one request next to the prompt and the answer. */
	maxTranscriptChars: number;
	timeoutMs: number;
	summaryPrompt?: string;
	titlePrompt?: string;
	/** Extra request fields (llama-server: turn reasoning off). */
	requestExtra?: Record<string, unknown>;
	/**
	 * Cap answer length. Only for the local model: hosted reasoning models count
	 * their thinking against the cap and would return nothing.
	 */
	limitAnswerTokens?: boolean;
}

/** Room left for the transcript in a context window, at ~3 characters per token. */
export function transcriptCharBudget(contextTokens: number, reservedTokens = 3_500) {
	return Math.max(4_000, (contextTokens - reservedTokens) * 3);
}

export class ChatSummarizer implements Summarizer {
	readonly capabilities: ReadonlySet<SummarizerCapability>;

	constructor(private readonly config: ChatSummarizerConfig) {
		this.capabilities = new Set(config.capabilities);
	}

	private async complete(prompt: string, maxTokens: number, signal?: AbortSignal) {
		const messages: ChatMessage[] = [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		];
		const answer = await chatCompletion(
			this.config.endpoint,
			{
				model: this.config.model,
				messages,
				maxTokens: this.config.limitAnswerTokens ? maxTokens : undefined,
				temperature: 0.3,
				extra: this.config.requestExtra,
			},
			{ signal, timeoutMs: this.config.timeoutMs },
		);
		return stripThinking(answer);
	}

	async summarize(
		context: MeetingContext,
		options: { onStatus?: MeetingStatusCallback; signal?: AbortSignal } = {},
	) {
		const transcript = context.transcript.trim();
		if (!transcript) throw new Error("The transcript is empty; there is nothing to summarize.");
		const chunks = chunkTranscript(transcript, this.config.maxTranscriptChars);
		const summaryTemplate = withLanguageInstruction(
			effectivePrompt(this.config.summaryPrompt, SUMMARY_PROMPT),
			context.language,
		);
		if (chunks.length === 1) {
			options.onStatus?.("Writing meeting notes…");
			return tidyNotes(
				await this.complete(
					renderPrompt(summaryTemplate, { transcript }),
					2_000,
					options.signal,
				),
			);
		}

		// Long meeting: notes per part, then one merge pass.
		const partTemplate = withLanguageInstruction(PARTIAL_SUMMARY_PROMPT, context.language);
		const partials: string[] = [];
		for (const [index, chunk] of chunks.entries()) {
			options.signal?.throwIfAborted();
			options.onStatus?.(
				`Writing notes for part ${index + 1} of ${chunks.length}…`,
				Math.round((index / (chunks.length + 1)) * 100),
			);
			partials.push(
				await this.complete(
					renderPrompt(partTemplate, {
						transcript: chunk,
						part: index + 1,
						parts: chunks.length,
					}),
					1_200,
					options.signal,
				),
			);
		}
		options.onStatus?.(
			"Merging the notes…",
			Math.round((chunks.length / (chunks.length + 1)) * 100),
		);
		const merged = partials
			.map((notes, index) => `### Part ${index + 1}\n${notes}`)
			.join("\n\n");
		const mergeTemplate = withLanguageInstruction(MERGE_SUMMARY_PROMPT, context.language);
		return tidyNotes(
			await this.complete(
				renderPrompt(mergeTemplate, {
					transcript: merged.slice(0, this.config.maxTranscriptChars),
				}),
				2_000,
				options.signal,
			),
		);
	}

	async title(notes: string, context: MeetingContext, signal?: AbortSignal) {
		const template = withLanguageInstruction(
			effectivePrompt(this.config.titlePrompt, TITLE_PROMPT),
			context.language,
		);
		return cleanTitle(
			await this.complete(
				renderPrompt(template, { transcript: notes.slice(0, 6_000) }),
				60,
				signal,
			),
		);
	}
}
