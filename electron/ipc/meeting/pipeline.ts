import fs from "node:fs/promises";
import { WHISPER_MODELS, WHISPER_VAD_MODEL, ensureAsset } from "./assets";
import { transcribeWithApi } from "./apiTranscription";
import type { MeetingContext, MeetingStatusCallback } from "./context";
import { LOCAL_CONTEXT_TOKENS, startLocalModelServer, stopLocalModelServer } from "./llamaServer";
import { readMeetingApiKey, type MeetingSettings } from "./settings";
import { ChatSummarizer, type Summarizer, transcriptCharBudget } from "./summarize";
import {
	formatTranscriptMarkdown,
	probeDurationMs,
	resolveMeetingAudioInputs,
	transcribeWithWhisper,
} from "./transcript";

/**
 * Transcribe → summarize → title, as separate stages that each write their own
 * file next to the recording, so a stage can be re-run alone and new ones
 * (screen context) can slot in between.
 */
export type MeetingJobMode = "full" | "transcribe" | "summarize";

export interface MeetingFiles {
	transcript: string;
	notes: string;
	meta: string;
}

export function meetingFilesFor(mediaPath: string): MeetingFiles {
	const base = mediaPath.replace(/\.[^./\\]+$/, "");
	return {
		transcript: `${base}.transcript.md`,
		notes: `${base}.notes.md`,
		meta: `${base}.meeting.json`,
	};
}

export interface MeetingMeta {
	/** Set for recordings made (or imported) as meetings; they show up in the Meetings library. */
	kind?: "meeting";
	createdAt?: string;
	hasVideo?: boolean;
	language?: string | null;
	durationMs?: number | null;
	title?: string;
	/** "auto" when the title came from the notes; a typed title is never replaced or cleared. */
	titleSource?: "auto" | "user";
	transcribedAt?: string;
	summarizedAt?: string;
	transcriptionSource?: string;
	summarizationSource?: string;
	lastJob?: {
		mode: MeetingJobMode;
		status: "running" | "done" | "failed" | "cancelled";
		error?: string;
		at: string;
	};
}

export async function readMeetingMeta(mediaPath: string): Promise<MeetingMeta> {
	try {
		return JSON.parse(
			await fs.readFile(meetingFilesFor(mediaPath).meta, "utf-8"),
		) as MeetingMeta;
	} catch {
		return {};
	}
}

export async function updateMeetingMeta(mediaPath: string, patch: Partial<MeetingMeta>) {
	const next = { ...(await readMeetingMeta(mediaPath)), ...patch };
	const file = meetingFilesFor(mediaPath).meta;
	await fs.writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), "utf-8");
	await fs.rename(`${file}.tmp`, file);
	return next;
}

async function writeAtomic(file: string, content: string) {
	await fs.writeFile(`${file}.tmp`, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
	await fs.rename(`${file}.tmp`, file);
}

function apiEndpoint(settings: MeetingSettings) {
	return { baseUrl: settings.apiBaseUrl, apiKey: readMeetingApiKey() };
}

async function runTranscription(
	mediaPath: string,
	settings: MeetingSettings,
	onStatus: MeetingStatusCallback,
	signal: AbortSignal,
) {
	const inputs = resolveMeetingAudioInputs(mediaPath);
	let result: Awaited<ReturnType<typeof transcribeWithWhisper>>;
	let source: string;
	if (settings.transcriptionService === "api") {
		result = await transcribeWithApi({
			endpoint: apiEndpoint(settings),
			model: settings.apiTranscriptionModel,
			inputs,
			language: settings.language,
			onStatus,
			signal,
		});
		source = `api:${settings.apiTranscriptionModel}`;
	} else {
		const model = WHISPER_MODELS[settings.whisperModel];
		const modelPath = await ensureAsset(model, (percent) =>
			onStatus(`Downloading ${model.label}…`, percent),
		);
		const vadModelPath = await ensureAsset(WHISPER_VAD_MODEL, (percent) =>
			onStatus(`Downloading ${WHISPER_VAD_MODEL.label}…`, percent),
		);
		result = await transcribeWithWhisper({
			inputs,
			modelPath,
			vadModelPath,
			language: settings.language,
			onStatus,
			signal,
		});
		source = `whisper:${settings.whisperModel}`;
	}
	if (result.segments.length === 0) {
		// A transcript or notes left from an earlier run of this audio were invented.
		const files = meetingFilesFor(mediaPath);
		await Promise.all([
			fs.rm(files.transcript, { force: true }),
			fs.rm(files.notes, { force: true }),
		]);
		const meta = await readMeetingMeta(mediaPath);
		await updateMeetingMeta(mediaPath, {
			language: undefined,
			...(meta.titleSource === "auto" ? { title: undefined, titleSource: undefined } : {}),
		});
		throw new Error("No speech was found in this recording.");
	}
	const transcript = formatTranscriptMarkdown(result.segments);
	await writeAtomic(meetingFilesFor(mediaPath).transcript, transcript);
	await updateMeetingMeta(mediaPath, {
		language: result.language,
		durationMs: await probeDurationMs(mediaPath),
		transcribedAt: new Date().toISOString(),
		transcriptionSource: source,
	});
	return { transcript, language: result.language };
}

async function createSummarizer(
	settings: MeetingSettings,
	onStatus: MeetingStatusCallback,
): Promise<{ summarizer: Summarizer; source: string }> {
	const prompts = { summaryPrompt: settings.summaryPrompt, titlePrompt: settings.titlePrompt };
	if (settings.summarizationService === "api") {
		return {
			source: `api:${settings.apiChatModel}`,
			summarizer: new ChatSummarizer({
				endpoint: apiEndpoint(settings),
				model: settings.apiChatModel,
				capabilities: settings.apiChatCapabilities,
				// Hosted models have large windows; chunking only kicks in for very long meetings.
				maxTranscriptChars: 300_000,
				timeoutMs: settings.apiTimeoutMinutes * 60 * 1000,
				...prompts,
			}),
		};
	}
	const baseUrl = await startLocalModelServer(settings.localModel, onStatus);
	return {
		source: `local:${settings.localModel}`,
		summarizer: new ChatSummarizer({
			endpoint: { baseUrl },
			model: settings.localModel,
			capabilities: ["text"],
			maxTranscriptChars: transcriptCharBudget(LOCAL_CONTEXT_TOKENS),
			// CPU prompt processing of a long meeting can take many minutes.
			timeoutMs: 30 * 60 * 1000,
			requestExtra: { chat_template_kwargs: { enable_thinking: false } },
			limitAnswerTokens: true,
			...prompts,
		}),
	};
}

export async function runMeetingPipeline(options: {
	mediaPath: string;
	mode: MeetingJobMode;
	settings: MeetingSettings;
	onStatus: (
		stage: "transcribe" | "summarize" | "title",
		message: string,
		progress?: number,
	) => void;
	signal: AbortSignal;
}) {
	const { mediaPath, mode, settings, signal } = options;
	const files = meetingFilesFor(mediaPath);

	let transcript: string;
	let language: string | null;
	if (mode === "summarize") {
		try {
			transcript = await fs.readFile(files.transcript, "utf-8");
		} catch {
			throw new Error("There is no transcript yet. Transcribe this recording first.");
		}
		language = (await readMeetingMeta(mediaPath)).language ?? null;
	} else {
		({ transcript, language } = await runTranscription(
			mediaPath,
			settings,
			(message, progress) => options.onStatus("transcribe", message, progress),
			signal,
		));
	}
	if (mode === "transcribe") return;
	signal.throwIfAborted();

	const summarizeStatus: MeetingStatusCallback = (message, progress) =>
		options.onStatus("summarize", message, progress);
	try {
		const { summarizer, source } = await createSummarizer(settings, summarizeStatus);
		const meta = await readMeetingMeta(mediaPath);
		const context: MeetingContext = {
			transcript,
			language,
			durationMs: meta.durationMs ?? null,
			// Visual context is not produced yet; see docs/meeting-mode-plan.md.
		};
		const notes = await summarizer.summarize(context, { onStatus: summarizeStatus, signal });
		await writeAtomic(files.notes, notes);
		await updateMeetingMeta(mediaPath, {
			summarizedAt: new Date().toISOString(),
			summarizationSource: source,
		});

		if (settings.autoTitle && meta.titleSource !== "user") {
			signal.throwIfAborted();
			options.onStatus("title", "Generating a title…");
			try {
				const title = await summarizer.title(notes, context, signal);
				if (title) await updateMeetingMeta(mediaPath, { title, titleSource: "auto" });
			} catch (error) {
				// A missing title must not fail notes that were already written.
				console.warn("[meeting] Title generation failed:", error);
			}
		}
	} finally {
		await stopLocalModelServer();
	}
}
