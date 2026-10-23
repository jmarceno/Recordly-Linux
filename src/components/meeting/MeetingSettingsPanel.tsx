import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceGroup, ChoiceItem } from "@/components/ui/choice-group";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsRow } from "@/components/video-editor/SettingsRow";

type Asset = { id: string; label: string; sizeBytes: number; installed: boolean };

const LANGUAGES: Array<[string, string]> = [
	["auto", "Detect"],
	["pt", "Portuguese"],
	["en", "English"],
	["es", "Spanish"],
	["fr", "French"],
	["de", "German"],
	["it", "Italian"],
];

const fieldClass =
	"h-9 w-full rounded-lg border border-separator bg-background px-3 text-[13px] outline-none focus:border-accent";

function formatSize(bytes: number) {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Text field that saves on blur, so typing does not write the settings file per key. */
function SettingField({
	label,
	value,
	onSave,
	placeholder,
	type = "text",
}: {
	label: string;
	value: string;
	onSave: (value: string) => void;
	placeholder?: string;
	type?: "text" | "password" | "url";
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return (
		<input
			aria-label={label}
			type={type}
			className={fieldClass}
			value={draft}
			placeholder={placeholder}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				if (draft !== value) onSave(draft);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
		/>
	);
}

function PromptField({
	label,
	value,
	onSave,
}: {
	label: string;
	value: string;
	onSave: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return (
		<div className="flex flex-col gap-2">
			<textarea
				aria-label={label}
				className="min-h-28 w-full resize-y rounded-lg border border-separator bg-background p-3 font-mono text-[12px] outline-none focus:border-accent"
				placeholder="Leave empty to use the built-in prompt. Use {transcript} where the text goes."
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (draft !== value) onSave(draft);
				}}
			/>
			{value && (
				<Button size="sm" variant="ghost" className="self-start" onClick={() => onSave("")}>
					Use the built-in prompt
				</Button>
			)}
		</div>
	);
}

/** Meeting services: where transcription and notes run, models and prompts. */
export function MeetingSettingsPanel() {
	const [settings, setSettings] = useState<MeetingSettingsView | null>(null);
	const [assets, setAssets] = useState<Asset[]>([]);
	const [progress, setProgress] = useState<Record<string, number>>({});
	const [apiKeyDraft, setApiKeyDraft] = useState("");

	const loadAssets = useCallback(async () => {
		setAssets(await window.electronAPI.meetingListAssets());
	}, []);

	useEffect(() => {
		void window.electronAPI.meetingGetSettings().then(setSettings);
		void loadAssets();
		return window.electronAPI.onMeetingAssetProgress((payload) =>
			setProgress((current) => ({ ...current, [payload.id]: payload.progress })),
		);
	}, [loadAssets]);

	const save = async (patch: Partial<MeetingSettingsView> & { apiKey?: string | null }) => {
		const result = await window.electronAPI.meetingSetSettings(patch);
		if (result.success && result.settings) setSettings(result.settings);
		else toast.error(result.error ?? "Could not save the setting.");
		return result.success;
	};

	const download = async (asset: Asset) => {
		setProgress((current) => ({ ...current, [asset.id]: 0 }));
		const result = await window.electronAPI.meetingDownloadAsset(asset.id);
		if (!result.success) toast.error(result.error ?? `Could not download ${asset.label}.`);
		setProgress((current) => {
			const { [asset.id]: _, ...rest } = current;
			return rest;
		});
		await loadAssets();
	};

	const remove = async (asset: Asset) => {
		await window.electronAPI.meetingRemoveAsset(asset.id);
		await loadAssets();
	};

	if (!settings) return null;
	const usesApi =
		settings.transcriptionService === "api" || settings.summarizationService === "api";

	return (
		<div className="space-y-6">
			<SettingsRow
				title="Transcription"
				description={
					settings.transcriptionService === "local"
						? "Runs whisper on this computer. Nothing leaves the machine."
						: "Sends the audio to the API below."
				}
				stacked
			>
				<ChoiceGroup
					aria-label="Transcription service"
					size="sm"
					value={settings.transcriptionService}
					onValueChange={(value) =>
						void save({ transcriptionService: value as "local" | "api" })
					}
				>
					<ChoiceItem value="local">On this computer</ChoiceItem>
					<ChoiceItem value="api">API</ChoiceItem>
				</ChoiceGroup>
			</SettingsRow>
			{settings.transcriptionService === "local" && (
				<SettingsRow
					title="Whisper model"
					description="Large turbo is much more accurate outside English; small is about three times faster."
					stacked
				>
					<ChoiceGroup
						aria-label="Whisper model"
						size="sm"
						value={settings.whisperModel}
						onValueChange={(value) =>
							void save({
								whisperModel: value as MeetingSettingsView["whisperModel"],
							})
						}
					>
						<ChoiceItem value="large-v3-turbo-q5_0">Large turbo (574 MB)</ChoiceItem>
						<ChoiceItem value="small">Small (488 MB)</ChoiceItem>
					</ChoiceGroup>
				</SettingsRow>
			)}
			<SettingsRow title="Spoken language" stacked>
				<ChoiceGroup
					aria-label="Spoken language"
					size="sm"
					value={settings.language}
					onValueChange={(value) => void save({ language: value })}
				>
					{LANGUAGES.map(([code, name]) => (
						<ChoiceItem key={code} value={code}>
							{name}
						</ChoiceItem>
					))}
				</ChoiceGroup>
			</SettingsRow>
			<SettingsRow
				title="Meeting notes"
				description={
					settings.summarizationService === "local"
						? "Runs a small model on this computer, started only while it writes notes."
						: "Sends the transcript to the API below."
				}
				stacked
			>
				<ChoiceGroup
					aria-label="Notes service"
					size="sm"
					value={settings.summarizationService}
					onValueChange={(value) =>
						void save({ summarizationService: value as "local" | "api" })
					}
				>
					<ChoiceItem value="local">On this computer</ChoiceItem>
					<ChoiceItem value="api">API</ChoiceItem>
				</ChoiceGroup>
			</SettingsRow>
			{settings.summarizationService === "local" && (
				<SettingsRow
					title="Notes model"
					description="2B fits in about 2 GB of memory; 4B writes better notes but needs about 4 GB."
					stacked
				>
					<ChoiceGroup
						aria-label="Notes model"
						size="sm"
						value={settings.localModel}
						onValueChange={(value) =>
							void save({ localModel: value as MeetingSettingsView["localModel"] })
						}
					>
						<ChoiceItem value="qwen3.5-2b">Qwen3.5 2B (1.3 GB)</ChoiceItem>
						<ChoiceItem value="qwen3.5-4b">Qwen3.5 4B (2.7 GB)</ChoiceItem>
					</ChoiceGroup>
				</SettingsRow>
			)}
			{usesApi && (
				<div className="space-y-4 rounded-xl border border-separator p-4">
					<p className="text-[13px] font-medium">API</p>
					<p className="text-xs text-muted-foreground">
						Any OpenAI-compatible service: OpenAI, OpenRouter, Ollama, LM Studio…
					</p>
					<SettingsRow title="Base URL" stacked>
						<SettingField
							label="API base URL"
							type="url"
							value={settings.apiBaseUrl}
							placeholder="https://api.openai.com/v1"
							onSave={(value) => void save({ apiBaseUrl: value })}
						/>
					</SettingsRow>
					<SettingsRow
						title="API key"
						description={
							settings.hasApiKey
								? "A key is saved in the system keyring."
								: "Stored encrypted in the system keyring. Leave empty for local servers."
						}
						stacked
					>
						<div className="flex gap-2">
							<input
								aria-label="API key"
								type="password"
								className={fieldClass}
								value={apiKeyDraft}
								placeholder={settings.hasApiKey ? "••••••••" : "sk-…"}
								onChange={(event) => setApiKeyDraft(event.target.value)}
							/>
							<Button
								size="sm"
								variant="secondary"
								disabled={!apiKeyDraft.trim()}
								onClick={() =>
									void save({ apiKey: apiKeyDraft }).then((ok) => {
										if (ok) {
											setApiKeyDraft("");
											toast.success("API key saved");
										}
									})
								}
							>
								Save key
							</Button>
							{settings.hasApiKey && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => void save({ apiKey: null })}
								>
									Remove
								</Button>
							)}
						</div>
					</SettingsRow>
					{settings.transcriptionService === "api" && (
						<SettingsRow title="Transcription model" stacked>
							<SettingField
								label="API transcription model"
								value={settings.apiTranscriptionModel}
								placeholder="whisper-1"
								onSave={(value) => void save({ apiTranscriptionModel: value })}
							/>
						</SettingsRow>
					)}
					{settings.summarizationService === "api" && (
						<SettingsRow title="Notes model" stacked>
							<SettingField
								label="API notes model"
								value={settings.apiChatModel}
								placeholder="gpt-4.1-mini"
								onSave={(value) => void save({ apiChatModel: value })}
							/>
						</SettingsRow>
					)}
				</div>
			)}
			<SettingsRow
				title="Process meetings automatically"
				description="Transcribe and write notes as soon as a meeting recording stops."
			>
				<Switch
					aria-label="Process meetings automatically"
					checked={settings.autoProcess}
					onCheckedChange={(autoProcess) => void save({ autoProcess })}
				/>
			</SettingsRow>
			<SettingsRow title="Name meetings from their notes">
				<Switch
					aria-label="Name meetings from their notes"
					checked={settings.autoTitle}
					onCheckedChange={(autoTitle) => void save({ autoTitle })}
				/>
			</SettingsRow>
			<SettingsRow title="Notes prompt" stacked>
				<PromptField
					label="Notes prompt"
					value={settings.summaryPrompt}
					onSave={(summaryPrompt) => void save({ summaryPrompt })}
				/>
			</SettingsRow>
			<SettingsRow
				title="Downloads"
				description="Models are downloaded the first time they are needed."
				stacked
			>
				<ul className="space-y-2">
					{assets.map((asset) => {
						const percent = progress[asset.id];
						return (
							<li
								key={asset.id}
								className="flex items-center justify-between gap-3 text-[13px]"
							>
								<span className="min-w-0 truncate">
									{asset.label}{" "}
									<span className="text-muted-foreground">
										{formatSize(asset.sizeBytes)}
									</span>
								</span>
								{percent !== undefined ? (
									<span className="shrink-0 tabular-nums text-muted-foreground">
										{percent}%
									</span>
								) : asset.installed ? (
									<Button
										size="sm"
										variant="ghost"
										onClick={() => void remove(asset)}
									>
										Remove
									</Button>
								) : (
									<Button
										size="sm"
										variant="secondary"
										onClick={() => void download(asset)}
									>
										Download
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			</SettingsRow>
		</div>
	);
}
