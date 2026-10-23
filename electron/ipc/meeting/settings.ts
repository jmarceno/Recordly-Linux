import { safeStorage } from "electron";
import { readAppSetting, writeAppSetting } from "../../appSettingsStore";
import {
	LOCAL_LLM_MODELS,
	type LocalLlmModelId,
	WHISPER_MODELS,
	type WhisperModelId,
} from "./assets";
import type { SummarizerCapability } from "./context";

export type MeetingService = "local" | "api";

export interface MeetingSettings {
	transcriptionService: MeetingService;
	whisperModel: WhisperModelId;
	/** Whisper language code or "auto". */
	language: string;
	summarizationService: MeetingService;
	localModel: LocalLlmModelId;
	apiBaseUrl: string;
	apiTranscriptionModel: string;
	apiChatModel: string;
	/** What the configured API chat model accepts besides text (for screen context later). */
	apiChatCapabilities: SummarizerCapability[];
	apiTimeoutMinutes: number;
	/** Empty means the built-in prompt. */
	summaryPrompt: string;
	titlePrompt: string;
	autoProcess: boolean;
	autoTitle: boolean;
}

/** What the renderer sees: the API key itself never leaves the main process. */
export interface MeetingSettingsView extends MeetingSettings {
	hasApiKey: boolean;
}

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
	transcriptionService: "local",
	whisperModel: "large-v3-turbo-q5_0",
	language: "auto",
	summarizationService: "local",
	localModel: "qwen3.5-2b",
	apiBaseUrl: "https://api.openai.com/v1",
	apiTranscriptionModel: "whisper-1",
	apiChatModel: "gpt-4.1-mini",
	apiChatCapabilities: ["text"],
	apiTimeoutMinutes: 5,
	summaryPrompt: "",
	titlePrompt: "",
	autoProcess: true,
	autoTitle: true,
};

const SETTINGS_KEY = "meetingSettings";
const API_KEY_KEY = "meetingApiKey";
const CAPABILITIES: SummarizerCapability[] = ["text", "images", "video"];

/** Keeps only known keys with valid values, so a bad file never breaks a job. */
export function normalizeMeetingSettings(raw: unknown): MeetingSettings {
	const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const pick = <K extends keyof MeetingSettings>(
		key: K,
		valid: (value: unknown) => boolean,
	): MeetingSettings[K] =>
		valid(input[key]) ? (input[key] as MeetingSettings[K]) : DEFAULT_MEETING_SETTINGS[key];
	const isService = (value: unknown) => value === "local" || value === "api";
	const isString = (value: unknown) => typeof value === "string";
	const isNonEmpty = (value: unknown) => typeof value === "string" && value.trim() !== "";
	const isBool = (value: unknown) => typeof value === "boolean";
	return {
		transcriptionService: pick("transcriptionService", isService),
		whisperModel: pick(
			"whisperModel",
			(value) => typeof value === "string" && value in WHISPER_MODELS,
		),
		language: pick("language", isNonEmpty),
		summarizationService: pick("summarizationService", isService),
		localModel: pick(
			"localModel",
			(value) => typeof value === "string" && value in LOCAL_LLM_MODELS,
		),
		apiBaseUrl: pick(
			"apiBaseUrl",
			(value) => isNonEmpty(value) && /^https?:\/\//.test(String(value)),
		),
		apiTranscriptionModel: pick("apiTranscriptionModel", isNonEmpty),
		apiChatModel: pick("apiChatModel", isNonEmpty),
		apiChatCapabilities: pick(
			"apiChatCapabilities",
			(value) =>
				Array.isArray(value) &&
				value.includes("text") &&
				value.every((entry) => CAPABILITIES.includes(entry as SummarizerCapability)),
		),
		apiTimeoutMinutes: pick(
			"apiTimeoutMinutes",
			(value) => typeof value === "number" && value >= 1 && value <= 60,
		),
		summaryPrompt: pick("summaryPrompt", isString),
		titlePrompt: pick("titlePrompt", isString),
		autoProcess: pick("autoProcess", isBool),
		autoTitle: pick("autoTitle", isBool),
	};
}

export function readMeetingSettings(): MeetingSettings {
	return normalizeMeetingSettings(readAppSetting(SETTINGS_KEY));
}

export function readMeetingSettingsView(): MeetingSettingsView {
	return { ...readMeetingSettings(), hasApiKey: readMeetingApiKey() !== null };
}

export function writeMeetingSettings(patch: Partial<MeetingSettings>) {
	const next = normalizeMeetingSettings({ ...readMeetingSettings(), ...patch });
	writeAppSetting(SETTINGS_KEY, next);
	return next;
}

/** The key is stored encrypted with the OS keyring via safeStorage. */
export function readMeetingApiKey(): string | null {
	const stored = readAppSetting(API_KEY_KEY);
	if (typeof stored !== "string" || !stored) return null;
	try {
		return safeStorage.decryptString(Buffer.from(stored, "base64"));
	} catch (error) {
		console.warn("[meeting] Could not decrypt the stored API key:", error);
		return null;
	}
}

export function writeMeetingApiKey(apiKey: string | null) {
	const trimmed = apiKey?.trim();
	if (!trimmed) {
		writeAppSetting(API_KEY_KEY, null);
		return;
	}
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("No system keyring is available to store the API key securely.");
	}
	writeAppSetting(API_KEY_KEY, safeStorage.encryptString(trimmed).toString("base64"));
}
