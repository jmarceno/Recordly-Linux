/**
 * Meeting-notes prompts and the text clean-up around them, ported from GravaAi
 * (linux/src/config/defaults.rs and processing/pipeline.rs).
 */

export const SUMMARY_PROMPT = `You are an experienced executive assistant taking minutes. Read the meeting transcript below and write clear, factual meeting notes in Markdown. Write the notes in the same language that is spoken in the transcript.

The transcript has [HH:MM:SS] timestamps and may label speakers (for example **Me:** for the person recording and **Remote:** for the other participants, or real names). Attribute statements, decisions and tasks to people when the transcript makes it clear; never invent names, facts, dates or numbers.

Use exactly these sections, in this order, and leave out any section that would be empty (never write "None" or "N/A"):

## Summary
2-5 sentences: the purpose of the meeting and its outcome.

## Key points
Bullet list of the main topics and what was said about each.

## Decisions
Bullet list of what was agreed or decided.

## Action items
Checklist, one task per line, with owner and due date when mentioned, e.g. \`- [ ] Maria: send the revised budget (by Friday)\`.

## Open questions
Bullet list of unresolved issues and follow-ups.

TRANSCRIPT:
{transcript}
`;

/** Map step for transcripts too long for one request. */
export const PARTIAL_SUMMARY_PROMPT = `You are taking minutes of a long meeting, one part at a time. This is part {part} of {parts}. Write concise Markdown notes for this part only: the topics discussed, anything decided, tasks with their owners and due dates, and open questions. Keep names, numbers and dates exactly as said; never invent anything. Write in the same language that is spoken in the transcript.

TRANSCRIPT PART:
{transcript}
`;

/** Reduce step: merges the partial notes using the normal section layout. */
export const MERGE_SUMMARY_PROMPT = `You are an experienced executive assistant. Below are notes taken from consecutive parts of one meeting. Merge them into a single set of meeting notes in Markdown, removing repetition. Write in the same language as the notes.

Use exactly these sections, in this order, and leave out any section that would be empty (never write "None" or "N/A"):

## Summary
2-5 sentences: the purpose of the meeting and its outcome.

## Key points
Bullet list of the main topics and what was said about each.

## Decisions
Bullet list of what was agreed or decided.

## Action items
Checklist, one task per line, with owner and due date when mentioned, e.g. \`- [ ] Maria: send the revised budget (by Friday)\`.

## Open questions
Bullet list of unresolved issues and follow-ups.

PARTIAL NOTES:
{transcript}
`;

export const TITLE_PROMPT = `Generate a concise 3-6 word title for this meeting based on the content below. Write it in the same language as the content. Return only the title text, nothing else.

{transcript}`;

const LANGUAGE_NAMES: Record<string, string> = {
	ar: "Arabic",
	ca: "Catalan",
	cs: "Czech",
	da: "Danish",
	de: "German",
	el: "Greek",
	en: "English",
	es: "Spanish",
	fi: "Finnish",
	fr: "French",
	he: "Hebrew",
	hi: "Hindi",
	hu: "Hungarian",
	id: "Indonesian",
	it: "Italian",
	ja: "Japanese",
	ko: "Korean",
	nl: "Dutch",
	no: "Norwegian",
	pl: "Polish",
	pt: "Portuguese",
	ro: "Romanian",
	ru: "Russian",
	sk: "Slovak",
	sv: "Swedish",
	th: "Thai",
	tr: "Turkish",
	uk: "Ukrainian",
	vi: "Vietnamese",
	zh: "Chinese",
};

export function languageName(code: string | null | undefined) {
	return code ? (LANGUAGE_NAMES[code.toLowerCase()] ?? null) : null;
}

/** whisper-1 reports the language as a name ("portuguese"); map it back to a code. */
export function languageCodeFromName(name: string | null | undefined) {
	if (!name) return null;
	const lowered = name.trim().toLowerCase();
	if (LANGUAGE_NAMES[lowered]) return lowered;
	const match = Object.entries(LANGUAGE_NAMES).find(
		([, label]) => label.toLowerCase() === lowered,
	);
	return match?.[0] ?? null;
}

/** A custom prompt, or the built-in default when the custom one is blank. */
export function effectivePrompt(custom: string | null | undefined, fallback: string) {
	return custom?.trim() ? custom : fallback;
}

/**
 * Small models drift into English when the prompt is English, so the detected
 * language is restated as the last instruction before the content.
 */
export function withLanguageInstruction(template: string, language: string | null | undefined) {
	const name = languageName(language);
	if (!name) return template;
	const instruction = `Write your answer in ${name}.`;
	const marker = template.lastIndexOf("{transcript}");
	if (marker < 0) return `${template}\n\n${instruction}`;
	const head = template.slice(0, marker);
	const labelStart = head.lastIndexOf("\n\n");
	const insertAt = labelStart >= 0 ? labelStart : marker;
	return `${template.slice(0, insertAt)}\n\n${instruction}${template.slice(insertAt)}`;
}

export function renderPrompt(template: string, values: Record<string, string | number>) {
	let rendered = template;
	for (const [key, value] of Object.entries(values)) {
		rendered = rendered.split(`{${key}}`).join(String(value));
	}
	if (!template.includes("{transcript}") && values.transcript !== undefined) {
		rendered = `${rendered}\n\n${values.transcript}`;
	}
	return rendered;
}

/** Drops sections a model filled with a placeholder instead of leaving them out. */
export function dropEmptySections(notes: string) {
	const isPlaceholder = (body: string) => {
		const text = body
			.replace(/^\s*(?:[>*_-]+\s*)*(?:\[[ xX]\]\s*)?/gm, "")
			.replace(/[.*_\s]+$/g, "")
			.trim()
			.toLowerCase();
		return (
			text === "" ||
			/^(none|n\/a|na|nothing|no \w+( \w+)?|nenhum[a]?|nada|sem \w+|ninguno|ninguna|aucun[e]?)$/.test(
				text,
			)
		);
	};
	const parts = notes.split(/^(?=##\s)/m);
	return parts
		.filter((part) => {
			if (!part.startsWith("##")) return true;
			const body = part.replace(/^##[^\n]*\n?/, "");
			return !isPlaceholder(body);
		})
		.join("")
		.trim();
}

/** Small models wrap checklist items in a second bullet ("*   - [ ] …"). */
export function normalizeChecklists(notes: string) {
	return notes
		.replace(/^(\s*)[*-]\s+(?=[*-] \[[ xX]\])/gm, "$1")
		.replace(/^(\s*)\* (\[[ xX]\])/gm, "$1- $2");
}

/** Clean-up applied to every model answer before it is saved as notes. */
export function tidyNotes(notes: string) {
	return dropEmptySections(normalizeChecklists(notes));
}

/** Strips a reasoning block some models emit before the answer. */
export function stripThinking(text: string) {
	return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function cleanTitle(raw: string) {
	const firstLine = stripThinking(raw)
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	return (firstLine ?? "")
		.replace(/^#+\s*/, "")
		.replace(/^(title|título|titulo)\s*:\s*/i, "")
		.replace(/^["'*`]+|["'*`.]+$/g, "")
		.trim()
		.slice(0, 80);
}

/**
 * Splits a transcript into chunks of at most `maxChars`, breaking only between
 * lines so a speaker turn is never cut in half.
 */
export function chunkTranscript(transcript: string, maxChars: number) {
	if (transcript.length <= maxChars) return [transcript];
	const chunks: string[] = [];
	let current = "";
	for (const line of transcript.split("\n")) {
		if (current && current.length + line.length + 1 > maxChars) {
			chunks.push(current.trim());
			current = "";
		}
		current += `${line}\n`;
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}
