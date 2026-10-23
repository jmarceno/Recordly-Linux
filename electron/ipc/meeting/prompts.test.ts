import { describe, expect, it } from "vitest";
import {
	chunkTranscript,
	cleanTitle,
	dropEmptySections,
	normalizeChecklists,
	effectivePrompt,
	languageCodeFromName,
	renderPrompt,
	SUMMARY_PROMPT,
	stripThinking,
	withLanguageInstruction,
} from "./prompts";

describe("withLanguageInstruction", () => {
	it("puts the language right before the transcript label", () => {
		const prompt = withLanguageInstruction(SUMMARY_PROMPT, "pt");
		const instruction = prompt.indexOf("Write your answer in Portuguese.");
		expect(instruction).toBeGreaterThan(prompt.indexOf("## Open questions"));
		expect(instruction).toBeLessThan(prompt.indexOf("TRANSCRIPT:"));
		expect(prompt.endsWith("{transcript}\n")).toBe(true);
	});

	it("leaves the prompt alone for unknown languages", () => {
		expect(withLanguageInstruction(SUMMARY_PROMPT, null)).toBe(SUMMARY_PROMPT);
		expect(withLanguageInstruction(SUMMARY_PROMPT, "xx")).toBe(SUMMARY_PROMPT);
	});

	it("appends to prompts without a placeholder", () => {
		expect(withLanguageInstruction("Summarize.", "de")).toBe(
			"Summarize.\n\nWrite your answer in German.",
		);
	});
});

describe("dropEmptySections", () => {
	it("removes placeholder sections and keeps real ones", () => {
		const notes = [
			"## Summary",
			"We planned the release.",
			"",
			"## Decisions",
			"- None",
			"",
			"## Action items",
			"- [ ] Ana: send the budget",
			"",
			"## Open questions",
			"N/A",
			"",
			"## Key points",
			"Nenhum.",
		].join("\n");
		const cleaned = dropEmptySections(notes);
		expect(cleaned).toContain("## Summary");
		expect(cleaned).toContain("## Action items");
		expect(cleaned).not.toContain("## Decisions");
		expect(cleaned).not.toContain("## Open questions");
		expect(cleaned).not.toContain("## Key points");
	});

	it("keeps text before the first heading", () => {
		expect(dropEmptySections("# Notes\n\n## Summary\nDone.")).toBe(
			"# Notes\n\n## Summary\nDone.",
		);
	});
});

describe("normalizeChecklists", () => {
	it("removes the extra bullet small models put around checklist items", () => {
		expect(
			normalizeChecklists("*   - [ ] **Ana:** send it\n* [x] done\n- [ ] fine\n* plain"),
		).toBe("- [ ] **Ana:** send it\n- [x] done\n- [ ] fine\n* plain");
	});
});

describe("chunkTranscript", () => {
	it("keeps short transcripts whole", () => {
		expect(chunkTranscript("a\nb", 100)).toEqual(["a\nb"]);
	});

	it("splits only between lines and respects the limit", () => {
		const lines = Array.from({ length: 50 }, (_, index) => `[00:00:${index}] line ${index}`);
		const chunks = chunkTranscript(lines.join("\n"), 120);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
		expect(chunks.join("\n").split("\n")).toEqual(lines);
	});
});

describe("titles and rendering", () => {
	it("cleans model title answers", () => {
		expect(cleanTitle('Title: "Planejamento do Q3".')).toBe("Planejamento do Q3");
		expect(cleanTitle("<think>hmm</think>\n# Release review\nextra")).toBe("Release review");
	});

	it("renders values and appends content to templates without a placeholder", () => {
		expect(renderPrompt("Part {part}: {transcript}", { part: 2, transcript: "x" })).toBe(
			"Part 2: x",
		);
		expect(renderPrompt("Title this.", { transcript: "notes" })).toBe("Title this.\n\nnotes");
	});

	it("falls back to the default prompt when the custom one is blank", () => {
		expect(effectivePrompt("  ", "default")).toBe("default");
		expect(effectivePrompt("mine", "default")).toBe("mine");
	});

	it("strips reasoning blocks", () => {
		expect(stripThinking("<think>a\nb</think>\n\nAnswer")).toBe("Answer");
	});

	it("maps whisper-1 language names to codes", () => {
		expect(languageCodeFromName("portuguese")).toBe("pt");
		expect(languageCodeFromName("en")).toBe("en");
		expect(languageCodeFromName("klingon")).toBeNull();
	});
});
