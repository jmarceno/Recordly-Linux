/**
 * What a summarizer receives. Only the transcript is filled today; the visual
 * fields exist so a later "screen context" stage (keyframes, or the whole
 * video for models that accept it) can be added without touching callers.
 */
export interface MeetingVisual {
	atMs: number;
	imagePath: string;
	ocrText?: string;
}

export interface MeetingContext {
	transcript: string;
	/** Whisper language code, e.g. "pt". */
	language: string | null;
	durationMs: number | null;
	videoPath?: string;
	visuals?: MeetingVisual[];
}

/** What a summarization provider can take in besides text. */
export type SummarizerCapability = "text" | "images" | "video";

export type MeetingStatusCallback = (message: string, progress?: number) => void;
