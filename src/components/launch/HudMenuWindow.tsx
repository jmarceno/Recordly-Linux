import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	MicrophoneSlashIcon,
	SpeakerHighIcon,
	SpeakerXIcon,
	TimerIcon,
	VideoCamera as Video,
	VideoCameraSlash as VideoOff,
	XIcon,
} from "@/components/ui/icons";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import { useVideoDevices } from "@/hooks/useVideoDevices";
import type { DeviceOption } from "./popovers/launchPopoverTypes";
import { DropdownItem, MicDeviceRow } from "./popovers/PopoverScaffold";
import "./launchTheme.css";

type HudMenuId = "mic" | "webcam" | "countdown";

interface HudMenuPreferences {
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
	systemAudioEnabled: boolean;
	webcamEnabled: boolean;
	webcamDeviceId?: string;
}

const DEFAULT_PREFERENCES: HudMenuPreferences = {
	microphoneEnabled: false,
	microphoneDeviceId: undefined,
	systemAudioEnabled: false,
	webcamEnabled: false,
	webcamDeviceId: undefined,
};

const COUNTDOWN_OPTIONS = [0, 3, 5, 10];

export function HudMenuWindow() {
	const t = useScopedT("launch");
	const { t: tRoot } = useI18n();
	const [menuId, setMenuId] = useState<HudMenuId | null>(null);
	const [preferences, setPreferences] = useState<HudMenuPreferences>(DEFAULT_PREFERENCES);
	const [countdownDelay, setCountdownDelay] = useState(3);
	const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
	const [previewError, setPreviewError] = useState(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);

	const refresh = useCallback(async () => {
		const [prefsResult, delayResult] = await Promise.all([
			window.electronAPI.getRecordingPreferences(),
			window.electronAPI.getCountdownDelay(),
		]);
		if (prefsResult.success) {
			setPreferences({
				microphoneEnabled: prefsResult.microphoneEnabled,
				microphoneDeviceId: prefsResult.microphoneDeviceId,
				systemAudioEnabled: prefsResult.systemAudioEnabled,
				webcamEnabled: prefsResult.webcamEnabled,
				webcamDeviceId: prefsResult.webcamDeviceId,
			});
		}
		if (delayResult.success) {
			setCountdownDelay(delayResult.delay);
		}
	}, []);

	useEffect(() => {
		const removeShowListener = window.electronAPI.onHudMenuShow((nextMenuId) => {
			setMenuId(nextMenuId);
			setPreviewError(false);
			void refresh();
		});
		const removePreferencesListener = window.electronAPI.onRecordingPreferencesChanged(
			(nextPreferences) => {
				setPreferences(nextPreferences);
			},
		);
		const removeCountdownListener = window.electronAPI.onCountdownDelayChanged((delay) => {
			setCountdownDelay(delay);
		});

		// The main process may have sent the menu id before React subscribed.
		void window.electronAPI.hudMenuGetCurrent().then((currentMenuId) => {
			if (currentMenuId) {
				setMenuId(currentMenuId);
				setPreviewError(false);
				void refresh();
			}
		});

		return () => {
			removeShowListener();
			removePreferencesListener();
			removeCountdownListener();
		};
	}, [refresh]);

	const close = useCallback(() => {
		setMenuId(null);
		setPreviewStream(null);
		window.electronAPI.hudMenuClose();
	}, []);

	useEffect(() => {
		if (!menuId) {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				close();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [menuId, close]);

	const microphone = useMicrophoneDevices(menuId === "mic", preferences.microphoneDeviceId);
	const webcam = useVideoDevices(menuId === "webcam");

	useEffect(() => {
		if (menuId !== "webcam" || !preferences.webcamEnabled) {
			return;
		}

		let cancelled = false;
		let stream: MediaStream | null = null;
		setPreviewError(false);

		void navigator.mediaDevices
			.getUserMedia({
				video: preferences.webcamDeviceId
					? {
							deviceId: { exact: preferences.webcamDeviceId },
							width: { ideal: 640 },
							height: { ideal: 480 },
						}
					: {
							width: { ideal: 640 },
							height: { ideal: 480 },
						},
				audio: false,
			})
			.then((nextStream) => {
				if (cancelled) {
					nextStream.getTracks().forEach((track) => track.stop());
					return;
				}
				stream = nextStream;
				setPreviewStream(nextStream);
			})
			.catch(() => {
				if (!cancelled) {
					setPreviewError(true);
				}
			});

		return () => {
			cancelled = true;
			stream?.getTracks().forEach((track) => track.stop());
			setPreviewStream(null);
		};
	}, [menuId, preferences.webcamEnabled, preferences.webcamDeviceId]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !previewStream) {
			return;
		}

		video.srcObject = previewStream;
		void video.play().catch(() => undefined);
		return () => {
			video.srcObject = null;
		};
	}, [previewStream]);

	const updatePreferences = useCallback((patch: Partial<HudMenuPreferences>) => {
		setPreferences((current) => ({ ...current, ...patch }));
		void window.electronAPI.setRecordingPreferences(patch);
	}, []);

	if (!menuId) {
		return null;
	}

	const title =
		menuId === "mic"
			? t("recording.microphone")
			: menuId === "webcam"
				? t("recording.webcam")
				: t("recording.countdownDelay");

	const selectedMicrophoneId = preferences.microphoneDeviceId ?? microphone.selectedDeviceId;
	const selectedWebcamId = preferences.webcamDeviceId ?? webcam.selectedDeviceId;

	return (
		<div
			className="fixed inset-0 flex items-center justify-center bg-black/45 p-6"
			onClick={close}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="launch-theme w-[520px] max-w-[calc(100vw-48px)] max-h-[min(82vh,720px)] overflow-y-auto rounded-2xl border border-[var(--launch-border)] bg-[var(--launch-panel)] p-3 text-[var(--launch-text)] shadow-2xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-center justify-between gap-3 px-1 pb-2 pt-1">
					<div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--launch-label)]">
						{title}
					</div>
					<Button
						variant="ghost"
						size="icon"
						onClick={close}
						title={tRoot("common.close", "Close")}
					>
						<XIcon className="size-5" />
					</Button>
				</div>

				{menuId === "mic" && (
					<>
						<DropdownItem
							icon={
								preferences.systemAudioEnabled ? (
									<SpeakerHighIcon size={16} />
								) : (
									<SpeakerXIcon size={16} />
								)
							}
							selected={preferences.systemAudioEnabled}
							onClick={() =>
								updatePreferences({
									systemAudioEnabled: !preferences.systemAudioEnabled,
								})
							}
						>
							{preferences.systemAudioEnabled
								? t("recording.disableSystemAudio")
								: t("recording.enableSystemAudio")}
						</DropdownItem>
						{preferences.microphoneEnabled && (
							<DropdownItem
								icon={<MicrophoneSlashIcon size={16} />}
								onClick={() => {
									updatePreferences({ microphoneEnabled: false });
									close();
								}}
							>
								{t("recording.turnOffMicrophone")}
							</DropdownItem>
						)}
						{!preferences.microphoneEnabled && (
							<div className="px-3 py-2 text-xs text-[var(--launch-text-muted)]">
								{t("recording.selectMicToEnable")}
							</div>
						)}
						{((microphone.devices as DeviceOption[]) ?? []).map((device) => (
							<MicDeviceRow
								key={device.deviceId}
								device={device}
								selected={
									preferences.microphoneEnabled &&
									(selectedMicrophoneId === device.deviceId ||
										preferences.microphoneDeviceId === device.deviceId)
								}
								onSelect={() => {
									microphone.setSelectedDeviceId(device.deviceId);
									updatePreferences({
										microphoneEnabled: true,
										microphoneDeviceId: device.deviceId,
									});
								}}
							/>
						))}
						{microphone.devices.length === 0 && (
							<div className="py-4 text-center text-xs text-[var(--launch-text-muted)]">
								{t("recording.noMicrophonesFound")}
							</div>
						)}
					</>
				)}

				{menuId === "webcam" && (
					<>
						{preferences.webcamEnabled && (
							<DropdownItem
								icon={<VideoOff size={16} />}
								onClick={() => {
									updatePreferences({ webcamEnabled: false });
									close();
								}}
							>
								{t("recording.turnOffWebcam")}
							</DropdownItem>
						)}
						{!preferences.webcamEnabled && (
							<div className="px-3 py-2 text-xs text-[var(--launch-text-muted)]">
								{t("recording.selectWebcamToEnable")}
							</div>
						)}
						{preferences.webcamEnabled && (
							<div className="flex justify-center px-3 py-3">
								<div className="aspect-[4/3] w-full max-w-[420px] overflow-hidden rounded-2xl bg-[var(--launch-hover)] ring-1 ring-[var(--launch-border-strong)]">
									{previewError ? (
										<div className="flex h-full w-full items-center justify-center text-xs text-[var(--launch-text-muted)]">
											{t("recording.noWebcamsFound")}
										</div>
									) : (
										<video
											ref={videoRef}
											className="h-full w-full object-cover"
											muted
											playsInline
											style={{ transform: "scaleX(-1)" }}
										/>
									)}
								</div>
							</div>
						)}
						{((webcam.devices as DeviceOption[]) ?? []).map((device) => (
							<DropdownItem
								key={device.deviceId}
								icon={
									preferences.webcamEnabled &&
									(selectedWebcamId === device.deviceId ||
										preferences.webcamDeviceId === device.deviceId) ? (
										<Video size={16} />
									) : (
										<VideoOff size={16} />
									)
								}
								selected={
									preferences.webcamEnabled &&
									(selectedWebcamId === device.deviceId ||
										preferences.webcamDeviceId === device.deviceId)
								}
								onClick={() => {
									webcam.setSelectedDeviceId(device.deviceId);
									updatePreferences({
										webcamEnabled: true,
										webcamDeviceId: device.deviceId,
									});
								}}
							>
								{device.label}
							</DropdownItem>
						))}
						{webcam.devices.length === 0 && (
							<div className="py-4 text-center text-xs text-[var(--launch-text-muted)]">
								{t("recording.noWebcamsFound")}
							</div>
						)}
					</>
				)}

				{menuId === "countdown" && (
					<>
						{COUNTDOWN_OPTIONS.map((delay) => (
							<DropdownItem
								key={delay}
								icon={<TimerIcon size={16} />}
								selected={countdownDelay === delay}
								onClick={() => {
									setCountdownDelay(delay);
									void window.electronAPI.setCountdownDelay(delay);
									close();
								}}
							>
								{delay === 0 ? t("recording.noDelay") : `${delay}s`}
							</DropdownItem>
						))}
					</>
				)}
			</div>
		</div>
	);
}
