import { contextBridge, ipcRenderer } from "electron";
import type { RecordingSessionData } from "./ipc/types";

type NativeVideoExportWriteResult = { success: boolean; error?: string };
type NativeVideoAudioMuxMetrics = {
	tempVideoWriteMs?: number;
	tempEditedAudioWriteMs?: number;
	ffmpegExecMs?: number;
	muxedVideoReadMs?: number;
	tempVideoBytes?: number;
	tempEditedAudioBytes?: number;
	muxedVideoBytes?: number;
};
type WindowsGpuExportSummary = {
	success?: boolean;
	width?: number;
	height?: number;
	fps?: number;
	seconds?: number;
	mediaMs?: number;
	frames?: number;
	cursorOverlay?: boolean;
	zoomOverlay?: boolean;
	adapterVendorId?: number;
	adapterDeviceId?: number;
	adapterDedicatedVideoMemoryMB?: number;
	initializeMs?: number;
	initCoInitializeMs?: number;
	initMfStartupMs?: number;
	initD3DDeviceMs?: number;
	initSourceReaderMs?: number;
	initWebcamReaderMs?: number;
	initVideoProcessorMs?: number;
	initTexturesMs?: number;
	initShaderPipelineMs?: number;
	initSinkWriterMs?: number;
	totalMs?: number;
	readMs?: number;
	clearMs?: number;
	videoProcessMs?: number;
	writeSampleMs?: number;
	finalizeMs?: number;
	realtimeMultiplier?: number;
};
type NativeStaticLayoutChunkMetric = {
	index: number;
	startSec: number;
	durationSec: number;
	backend: "ffmpeg-overlay" | "ffmpeg-pad" | "ffmpeg-precomposite" | "windows-d3d11-compositor";
	elapsedMs: number;
	outputBytes: number;
	fallbackReason?: string;
	windowsGpuSummary?: WindowsGpuExportSummary;
};
type NativeStaticLayoutMetrics = NativeVideoAudioMuxMetrics & {
	chunkCount: number;
	chunkDurationSec: number;
	chunkExecMs: number;
	concatExecMs?: number;
	staticAssetExecMs?: number;
	fallbackChunkCount: number;
	videoOnlyBytes?: number;
	chunks: NativeStaticLayoutChunkMetric[];
};
type NativeStaticLayoutProgress = {
	sessionId?: string;
	backend?: NativeStaticLayoutChunkMetric["backend"];
	stage?: "preparing" | "finalizing";
	elapsedMs?: number;
	averageFps?: number;
	currentFrame: number;
	totalFrames: number;
	percentage: number;
};
type NativeVideoMetadataProbe = {
	width: number;
	height: number;
	duration: number;
	mediaStartTime?: number;
	streamStartTime?: number;
	streamDuration?: number;
	frameRate: number;
	codec: string;
	hasAudio: boolean;
	audioCodec?: string;
	audioSampleRate?: number;
};
type ExportHardwareInfo = {
	platform: NodeJS.Platform;
	release: string;
	arch: string;
	cpuModel: string | null;
	logicalProcessors: number;
	totalMemoryGb: number;
	machineModel: string | null;
	gpus: Array<{
		name: string;
		vendor: string | null;
		active: boolean | null;
	}>;
	gpuFeatures: {
		videoDecode: string | null;
		videoEncode: string | null;
		webgl: string | null;
		webgpu: string | null;
	};
};

const nativeVideoExportWriteRequests = new Map<
	number,
	{
		sessionId: string;
		resolve: (result: NativeVideoExportWriteResult) => void;
	}
>();

let nextNativeVideoExportWriteRequestId = 1;
let nativeVideoExportWriteResultListenerAttached = false;

function ensureNativeVideoExportWriteResultListener() {
	if (nativeVideoExportWriteResultListenerAttached) {
		return;
	}

	nativeVideoExportWriteResultListenerAttached = true;
	ipcRenderer.on(
		"native-video-export-write-frame-result",
		(
			_event,
			payload: {
				sessionId?: string;
				requestId?: number;
				success?: boolean;
				error?: string;
			},
		) => {
			if (typeof payload?.requestId !== "number") {
				return;
			}

			const pendingRequest = nativeVideoExportWriteRequests.get(payload.requestId);
			if (!pendingRequest) {
				return;
			}

			nativeVideoExportWriteRequests.delete(payload.requestId);
			pendingRequest.resolve({
				success: payload.success === true,
				error: payload.error,
			});
		},
	);
}

function settleNativeVideoExportPendingRequests(
	sessionId: string,
	result: NativeVideoExportWriteResult,
) {
	for (const [requestId, pendingRequest] of nativeVideoExportWriteRequests.entries()) {
		if (pendingRequest.sessionId !== sessionId) {
			continue;
		}

		nativeVideoExportWriteRequests.delete(requestId);
		pendingRequest.resolve(result);
	}
}

contextBridge.exposeInMainWorld("electronAPI", {
	hudOverlaySetIgnoreMouse: (ignore: boolean) => {
		ipcRenderer.send("hud-overlay-set-ignore-mouse", ignore);
	},
	hudOverlaySetSourceSelectionActive: (active: boolean) => {
		ipcRenderer.send("hud-overlay-set-source-selection-active", active);
	},
	hudOverlayDrag: (phase: "start" | "move" | "end", screenX: number, screenY: number) => {
		ipcRenderer.send("hud-overlay-drag", phase, screenX, screenY);
	},
	hudOverlayHide: () => {
		ipcRenderer.send("hud-overlay-hide");
	},
	hudOverlayClose: () => {
		ipcRenderer.send("hud-overlay-close");
	},
	getEditorMode: () => ipcRenderer.invoke("get-editor-mode"),
	onEditorModeChanged: (callback: (inEditor: boolean) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, inEditor: boolean) =>
			callback(inEditor);
		ipcRenderer.on("editor-mode-changed", listener);
		return () => ipcRenderer.removeListener("editor-mode-changed", listener);
	},
	hudOverlayRendererReady: () => {
		ipcRenderer.send("hud-overlay-renderer-ready");
	},
	hudMenuOpen: (menuId: "mic" | "webcam" | "countdown") => {
		ipcRenderer.send("hud-menu-open", menuId);
	},
	hudMenuClose: () => {
		ipcRenderer.send("hud-menu-close");
	},
	hudMenuGetCurrent: () => ipcRenderer.invoke("hud-menu-get-current"),
	onHudMenuShow: (callback: (menuId: "mic" | "webcam" | "countdown") => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			menuId: "mic" | "webcam" | "countdown",
		) => callback(menuId);
		ipcRenderer.on("hud-menu-show", listener);
		return () => ipcRenderer.removeListener("hud-menu-show", listener);
	},
	onRecordingPreferencesChanged: (
		callback: (prefs: {
			microphoneEnabled: boolean;
			microphoneDeviceId?: string;
			systemAudioEnabled: boolean;
			webcamEnabled: boolean;
			webcamDeviceId?: string;
		}) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			prefs: {
				microphoneEnabled: boolean;
				microphoneDeviceId?: string;
				systemAudioEnabled: boolean;
				webcamEnabled: boolean;
				webcamDeviceId?: string;
			},
		) => callback(prefs);
		ipcRenderer.on("recording-preferences-changed", listener);
		return () => ipcRenderer.removeListener("recording-preferences-changed", listener);
	},
	onCountdownDelayChanged: (callback: (delay: number) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, delay: number) => callback(delay);
		ipcRenderer.on("countdown-delay-changed", listener);
		return () => ipcRenderer.removeListener("countdown-delay-changed", listener);
	},

	hudOverlaySetWebcamPreviewVisible: (visible: boolean) => {
		ipcRenderer.send("hud-overlay-set-webcam-preview-visible", visible);
	},
	getHudOverlayCaptureProtection: () => {
		return ipcRenderer.invoke("get-hud-overlay-capture-protection");
	},
	getHudOverlayMousePassthroughSupported: () => {
		return ipcRenderer.invoke("get-hud-overlay-mouse-passthrough-supported");
	},
	setHudOverlayCaptureProtection: (enabled: boolean) => {
		return ipcRenderer.invoke("set-hud-overlay-capture-protection", enabled);
	},
	getAssetBasePath: async () => {
		return await ipcRenderer.invoke("get-asset-base-path");
	},
	listAssetDirectory: (relativeDir: string) => {
		return ipcRenderer.invoke("list-asset-directory", relativeDir);
	},
	readLocalFile: (filePath: string) => {
		return ipcRenderer.invoke("read-local-file", filePath);
	},
	generateWallpaperThumbnail: (filePath: string) => {
		return ipcRenderer.invoke("generate-wallpaper-thumbnail", filePath);
	},
	probeNativeVideoMetadata: (filePath: string) => {
		return ipcRenderer.invoke("probe-native-video-metadata", filePath) as Promise<{
			success: boolean;
			metadata?: NativeVideoMetadataProbe;
			error?: string;
		}>;
	},
	getExportHardwareInfo: () => {
		return ipcRenderer.invoke("get-export-hardware-info") as Promise<{
			success: boolean;
			hardware?: ExportHardwareInfo;
			error?: string;
		}>;
	},
	nativeStaticLayoutExport: (options: {
		sessionId?: string;
		inputPath: string;
		width: number;
		height: number;
		frameRate: number;
		bitrate: number;
		encodingMode: "fast" | "balanced" | "quality";
		durationSec: number;
		contentWidth: number;
		contentHeight: number;
		offsetX: number;
		offsetY: number;
		sourceCropX?: number;
		sourceCropY?: number;
		sourceCropWidth?: number;
		sourceCropHeight?: number;
		backgroundColor: string;
		backgroundImagePath?: string | null;
		backgroundBlurPx?: number;
		borderRadius?: number;
		shadowIntensity?: number;
		webcamInputPath?: string | null;
		webcamLeft?: number;
		webcamTop?: number;
		webcamSize?: number;
		webcamRadius?: number;
		webcamShadowIntensity?: number;
		webcamMirror?: boolean;
		webcamTimeOffsetMs?: number;
		cursorTelemetry?: Array<{
			timeMs: number;
			cx: number;
			cy: number;
			cursorTypeIndex?: number;
			bounceScale?: number;
			visible?: boolean;
		}>;
		cursorSize?: number;
		cursorAtlasPngDataUrl?: string | null;
		cursorAtlasEntries?: Array<{
			index: number;
			x: number;
			y: number;
			width: number;
			height: number;
			anchorX: number;
			anchorY: number;
			aspectRatio: number;
		}>;
		zoomTelemetry?: Array<{ timeMs: number; scale: number; x: number; y: number }>;
		timelineSegments?: Array<{
			sourceStartMs: number;
			sourceEndMs: number;
			outputStartMs: number;
			outputEndMs: number;
			speed: number;
		}>;
		chunkDurationSec?: number;
		windowsGpuCompositor?: boolean;
		audioOptions?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		};
	}) => {
		return ipcRenderer.invoke("native-static-layout-export", options) as Promise<{
			success: boolean;
			tempPath?: string;
			encoderName?: string;
			error?: string;
			metrics?: NativeStaticLayoutMetrics;
		}>;
	},
	nativeStaticLayoutExportCancel: (sessionId: string) => {
		return ipcRenderer.invoke("native-static-layout-export-cancel", sessionId) as Promise<{
			success: boolean;
		}>;
	},
	onNativeStaticLayoutExportProgress: (
		callback: (progress: NativeStaticLayoutProgress) => void,
	) => {
		const listener = (_event: Electron.IpcRendererEvent, payload: NativeStaticLayoutProgress) =>
			callback(payload);
		ipcRenderer.on("native-static-layout-export-progress", listener);
		return () => ipcRenderer.removeListener("native-static-layout-export-progress", listener);
	},
	nativeVideoExportStart: (options: {
		width: number;
		height: number;
		frameRate: number;
		bitrate: number;
		encodingMode: "fast" | "balanced" | "quality";
		inputMode?: "rawvideo" | "h264-stream";
	}) => {
		return ipcRenderer.invoke("native-video-export-start", options);
	},
	nativeVideoExportWriteFrame: (sessionId: string, frameData: Uint8Array) => {
		ensureNativeVideoExportWriteResultListener();

		return new Promise<NativeVideoExportWriteResult>((resolve) => {
			const requestId = nextNativeVideoExportWriteRequestId++;
			nativeVideoExportWriteRequests.set(requestId, {
				sessionId,
				resolve,
			});

			ipcRenderer.send("native-video-export-write-frame-async", {
				sessionId,
				requestId,
				frameData,
			});
		});
	},
	nativeVideoExportWriteFrames: (sessionId: string, frameDataList: Uint8Array[]) => {
		ensureNativeVideoExportWriteResultListener();

		return new Promise<NativeVideoExportWriteResult>((resolve) => {
			const requestId = nextNativeVideoExportWriteRequestId++;
			nativeVideoExportWriteRequests.set(requestId, {
				sessionId,
				resolve,
			});

			ipcRenderer.send("native-video-export-write-frames-async", {
				sessionId,
				requestId,
				frameDataList,
			});
		});
	},
	nativeVideoExportFinish: (
		sessionId: string,
		options?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		},
	) => {
		return ipcRenderer
			.invoke("native-video-export-finish", sessionId, options)
			.then((result) => {
				settleNativeVideoExportPendingRequests(
					sessionId,
					result?.success
						? { success: true }
						: {
								success: false,
								error:
									typeof result?.error === "string"
										? result.error
										: "Native video export session finished before all frame writes settled.",
							},
				);

				return result;
			}) as Promise<{
			success: boolean;
			data?: Uint8Array;
			encoderName?: string;
			error?: string;
			metrics?: NativeVideoAudioMuxMetrics;
		}>;
	},
	nativeVideoExportCancel: (sessionId: string) => {
		return ipcRenderer.invoke("native-video-export-cancel", sessionId).finally(() => {
			settleNativeVideoExportPendingRequests(sessionId, {
				success: false,
				error: "Native video export session was cancelled",
			});
		});
	},
	muxExportedVideoAudio: (
		videoData: ArrayBuffer,
		options?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		},
	) => {
		return ipcRenderer.invoke("mux-exported-video-audio", videoData, options) as Promise<{
			success: boolean;
			tempPath?: string;
			error?: string;
			metrics?: NativeVideoAudioMuxMetrics;
		}>;
	},
	muxExportedVideoAudioFromPath: (
		videoPath: string,
		options?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		},
	) => {
		return ipcRenderer.invoke("mux-exported-video-audio-from-path", videoPath, options);
	},
	openExportStream: (options?: { extension?: string }) => {
		return ipcRenderer.invoke("export-stream-open", options);
	},
	writeExportStreamChunk: (streamId: string, position: number, chunk: Uint8Array) => {
		return ipcRenderer.invoke("export-stream-write", streamId, position, chunk);
	},
	closeExportStream: (streamId: string, options?: { abort?: boolean }) => {
		return ipcRenderer.invoke("export-stream-close", streamId, options);
	},
	finalizeExportedVideo: (payload: {
		tempPath: string;
		fileName: string;
		outputPath?: string | null;
		captionSidecar?: {
			format: "srt" | "vtt" | "both";
			cues: Array<{
				startMs: number;
				endMs: number;
				text: string;
			}>;
		};
	}) => {
		return ipcRenderer.invoke("finalize-exported-video", payload);
	},
	discardExportedTemp: (tempPath: string) => {
		return ipcRenderer.invoke("discard-exported-temp", tempPath);
	},
	getVideoAudioFallbackPaths: (videoPath: string) => {
		return ipcRenderer.invoke("get-video-audio-fallback-paths", videoPath);
	},
	getSources: async (opts: Electron.SourcesOptions) => {
		return await ipcRenderer.invoke("get-sources", opts);
	},
	showRecordingPermissions: () => ipcRenderer.invoke("show-recording-permissions"),
	onRecordingPermissionsRequested: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("recording-permissions-requested", listener);
		return () => ipcRenderer.removeListener("recording-permissions-requested", listener);
	},
	showRecordingHud: () => ipcRenderer.invoke("show-recording-hud"),
	createProjectFile: (data: unknown, thumbnail?: string | null) =>
		ipcRenderer.invoke("create-project-file", data, thumbnail),
	renameLibraryProject: (path: string, name: string) =>
		ipcRenderer.invoke("rename-library-project", path, name),
	trashProjectFiles: (paths: string[]) => ipcRenderer.invoke("trash-project-files", paths),
	showProjectDashboard: () => ipcRenderer.invoke("show-project-dashboard"),
	switchToEditor: () => {
		return ipcRenderer.invoke("switch-to-editor");
	},
	openSourceSelector: () => {
		return ipcRenderer.invoke("open-source-selector");
	},
	selectSource: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("select-source", source);
	},
	showSourceHighlight: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("show-source-highlight", source);
	},
	pickCaptureTarget: () => {
		return ipcRenderer.invoke("pick-capture-target");
	},
	completeCapturePick: (pick: CapturePick | null) => {
		return ipcRenderer.invoke("complete-capture-pick", pick);
	},
	getCapturePickerContext: (displayId: number) => {
		return ipcRenderer.invoke("get-capture-picker-context", displayId);
	},
	capturePickerReady: () => {
		ipcRenderer.send("capture-picker-ready");
	},
	getSelectedSource: () => {
		return ipcRenderer.invoke("get-selected-source");
	},
	onSelectedSourceChanged: (callback: (source: ProcessedDesktopSource | null) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: ProcessedDesktopSource | null,
		) => callback(payload);
		ipcRenderer.on("selected-source-changed", listener);
		return () => ipcRenderer.removeListener("selected-source-changed", listener);
	},
	startNativeScreenRecording: (
		source: ProcessedDesktopSource,
		options?: {
			capturesSystemAudio?: boolean;
			capturesMicrophone?: boolean;
			microphoneDeviceId?: string;
			microphoneLabel?: string;
			keepSpeakerTracks?: boolean;
		},
	) => {
		return ipcRenderer.invoke("start-native-screen-recording", source, options);
	},
	stopNativeScreenRecording: () => {
		return ipcRenderer.invoke("stop-native-screen-recording");
	},
	recoverNativeScreenRecording: () => {
		return ipcRenderer.invoke("recover-native-screen-recording");
	},
	getLastNativeCaptureDiagnostics: () => {
		return ipcRenderer.invoke("get-last-native-capture-diagnostics");
	},
	pauseNativeScreenRecording: () => {
		return ipcRenderer.invoke("pause-native-screen-recording");
	},
	resumeNativeScreenRecording: () => {
		return ipcRenderer.invoke("resume-native-screen-recording");
	},
	pauseCursorCapture: (pausedAtMs?: number) => {
		return ipcRenderer.invoke("pause-cursor-capture", pausedAtMs);
	},
	resumeCursorCapture: (resumedAtMs?: number) => {
		return ipcRenderer.invoke("resume-cursor-capture", resumedAtMs);
	},
	startFfmpegRecording: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("start-ffmpeg-recording", source);
	},
	stopFfmpegRecording: () => {
		return ipcRenderer.invoke("stop-ffmpeg-recording");
	},
	storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("store-recorded-video", videoData, fileName);
	},
	storeMicrophoneSidecar: (
		audioData: ArrayBuffer,
		videoPath: string,
		options?: {
			startDelayMs?: number;
			browserMicrophoneProfile?: string;
			requestedBrowserMicrophoneProfile?: string | null;
			requestedConstraints?: unknown;
			mediaTrackSettings?: Record<string, boolean | number | string>;
			audioInputDevices?: Array<{
				deviceId: string;
				groupId?: string;
				label: string;
			}>;
			mediaRecorder?: {
				mimeType?: string;
				audioBitsPerSecond?: number;
				timesliceMs?: number;
			};
			chunkEvents?: Array<{
				index: number;
				size: number;
				elapsedMs: number;
				deltaMs: number | null;
			}>;
		},
	) => {
		return ipcRenderer.invoke("store-microphone-sidecar", audioData, videoPath, options);
	},
	getRecordedVideoPath: () => {
		return ipcRenderer.invoke("get-recorded-video-path");
	},
	setRecordingState: (recording: boolean) => {
		return ipcRenderer.invoke("set-recording-state", recording);
	},
	setCursorScale: (scale: number) => {
		return ipcRenderer.invoke("set-cursor-scale", scale);
	},
	getCursorTelemetry: (videoPath?: string) => {
		return ipcRenderer.invoke("get-cursor-telemetry", videoPath);
	},
	setCursorTelemetry: (videoPath: string | undefined, samples: CursorTelemetryPoint[]) => {
		return ipcRenderer.invoke("set-cursor-telemetry", videoPath, samples);
	},
	getSystemCursorAssets: () => {
		return ipcRenderer.invoke("get-system-cursor-assets");
	},
	onStopRecordingFromTray: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("stop-recording-from-tray", listener);
		return () => ipcRenderer.removeListener("stop-recording-from-tray", listener);
	},
	onRecordingStateChanged: (
		callback: (state: { recording: boolean; sourceName: string }) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { recording: boolean; sourceName: string },
		) => callback(payload);
		ipcRenderer.on("recording-state-changed", listener);
		return () => ipcRenderer.removeListener("recording-state-changed", listener);
	},
	onRecordingInterrupted: (callback: (state: { reason: string; message: string }) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { reason: string; message: string },
		) => callback(payload);
		ipcRenderer.on("recording-interrupted", listener);
		return () => ipcRenderer.removeListener("recording-interrupted", listener);
	},
	onCursorStateChanged: (
		callback: (state: { cursorType: CursorTelemetryPoint["cursorType"] }) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { cursorType: CursorTelemetryPoint["cursorType"] },
		) => callback(payload);
		ipcRenderer.on("cursor-state-changed", listener);
		return () => ipcRenderer.removeListener("cursor-state-changed", listener);
	},
	openExternalUrl: (url: string) => {
		return ipcRenderer.invoke("open-external-url", url);
	},
	getAccessibilityPermissionStatus: () => {
		return ipcRenderer.invoke("get-accessibility-permission-status");
	},
	requestAccessibilityPermission: () => {
		return ipcRenderer.invoke("request-accessibility-permission");
	},
	getScreenRecordingPermissionStatus: () => {
		return ipcRenderer.invoke("get-screen-recording-permission-status");
	},
	openScreenRecordingPreferences: () => {
		return ipcRenderer.invoke("open-screen-recording-preferences");
	},
	openAccessibilityPreferences: () => {
		return ipcRenderer.invoke("open-accessibility-preferences");
	},
	saveExportedVideo: (
		videoData: ArrayBuffer,
		fileName: string,
		captionSidecar?: {
			format: "srt" | "vtt" | "both";
			cues: Array<{
				startMs: number;
				endMs: number;
				text: string;
			}>;
		},
	) => {
		return ipcRenderer.invoke("save-exported-video", videoData, fileName, captionSidecar);
	},
	writeExportedVideoToPath: (
		videoData: ArrayBuffer,
		outputPath: string,
		captionSidecar?: {
			format: "srt" | "vtt" | "both";
			cues: Array<{
				startMs: number;
				endMs: number;
				text: string;
			}>;
		},
	) => {
		return ipcRenderer.invoke(
			"write-exported-video-to-path",
			videoData,
			outputPath,
			captionSidecar,
		);
	},
	openVideoFilePicker: (options?: { includeProjects?: boolean }) => {
		return ipcRenderer.invoke("open-video-file-picker", options);
	},
	openAudioFilePicker: () => {
		return ipcRenderer.invoke("open-audio-file-picker");
	},
	openWhisperExecutablePicker: () => {
		return ipcRenderer.invoke("open-whisper-executable-picker");
	},
	openWhisperModelPicker: () => {
		return ipcRenderer.invoke("open-whisper-model-picker");
	},
	getWhisperSmallModelStatus: () => {
		return ipcRenderer.invoke("get-whisper-small-model-status");
	},
	downloadWhisperSmallModel: () => {
		return ipcRenderer.invoke("download-whisper-small-model");
	},
	deleteWhisperSmallModel: () => {
		return ipcRenderer.invoke("delete-whisper-small-model");
	},
	onWhisperSmallModelDownloadProgress: (
		callback: (state: {
			status: "idle" | "downloading" | "downloaded" | "error";
			progress: number;
			path?: string | null;
			error?: string;
		}) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: {
				status: "idle" | "downloading" | "downloaded" | "error";
				progress: number;
				path?: string | null;
				error?: string;
			},
		) => callback(payload);
		ipcRenderer.on("whisper-small-model-download-progress", listener);
		return () => ipcRenderer.removeListener("whisper-small-model-download-progress", listener);
	},
	generateAutoCaptions: (options: {
		videoPath: string;
		whisperExecutablePath?: string;
		whisperModelPath: string;
		language?: string;
	}) => {
		return ipcRenderer.invoke("generate-auto-captions", options);
	},
	meetingGetSettings: () => ipcRenderer.invoke("meeting-get-settings"),
	meetingList: () => ipcRenderer.invoke("meeting-list"),
	meetingMediaUrl: (mediaPath: string) => ipcRenderer.invoke("meeting-media-url", mediaPath),
	meetingImport: () => ipcRenderer.invoke("meeting-import"),
	meetingRename: (request: { mediaPath: string; title: string }) =>
		ipcRenderer.invoke("meeting-rename", request),
	meetingDelete: (mediaPaths: string[]) => ipcRenderer.invoke("meeting-delete", mediaPaths),
	meetingReveal: (mediaPath: string) => ipcRenderer.invoke("meeting-reveal", mediaPath),
	meetingRequestOpen: (mediaPath: string) =>
		ipcRenderer.invoke("meeting-request-open", mediaPath),
	meetingTakeOpenRequest: () => ipcRenderer.invoke("meeting-take-open-request"),
	onMeetingOpenRequested: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("meeting-open-requested", listener);
		return () => ipcRenderer.removeListener("meeting-open-requested", listener);
	},
	meetingSetSettings: (patch: Record<string, unknown>) =>
		ipcRenderer.invoke("meeting-set-settings", patch),
	meetingStartAudioRecording: (options?: {
		capturesSystemAudio?: boolean;
		capturesMicrophone?: boolean;
		microphoneLabel?: string;
	}) => ipcRenderer.invoke("meeting-start-audio-recording", options),
	meetingRunJob: (request: { mediaPath: string; mode: "full" | "transcribe" | "summarize" }) =>
		ipcRenderer.invoke("meeting-run-job", request),
	meetingCancelJob: (jobId: string) => ipcRenderer.invoke("meeting-cancel-job", jobId),
	meetingListJobs: () => ipcRenderer.invoke("meeting-list-jobs"),
	meetingGetFiles: (mediaPath: string) => ipcRenderer.invoke("meeting-get-files", mediaPath),
	meetingSaveFile: (request: {
		mediaPath: string;
		kind: "transcript" | "notes";
		content: string;
	}) => ipcRenderer.invoke("meeting-save-file", request),
	meetingListAssets: () => ipcRenderer.invoke("meeting-list-assets"),
	meetingDownloadAsset: (assetId: string) =>
		ipcRenderer.invoke("meeting-download-asset", assetId),
	meetingRemoveAsset: (assetId: string) => ipcRenderer.invoke("meeting-remove-asset", assetId),
	onMeetingJobUpdate: (callback: (job: unknown) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, job: unknown) => callback(job);
		ipcRenderer.on("meeting-job-update", listener);
		return () => ipcRenderer.removeListener("meeting-job-update", listener);
	},
	onMeetingAssetProgress: (callback: (payload: { id: string; progress: number }) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { id: string; progress: number },
		) => callback(payload);
		ipcRenderer.on("meeting-asset-progress", listener);
		return () => ipcRenderer.removeListener("meeting-asset-progress", listener);
	},
	setCurrentVideoPath: (
		path: string,
		options?: {
			preserveProjectPath?: boolean;
			hideOverlayCursorByDefault?: boolean;
		},
	) => {
		return ipcRenderer.invoke("set-current-video-path", path, options);
	},
	setCurrentRecordingSession: (
		session: {
			videoPath: string;
			webcamPath?: string | null;
			timeOffsetMs?: number;
			hideOverlayCursorByDefault?: boolean;
		},
		options?: { preserveProjectPath?: boolean },
	) => {
		return ipcRenderer.invoke("set-current-recording-session", session, options);
	},
	onRecordingSessionChanged: (callback: (session: RecordingSessionData | null) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: RecordingSessionData | null,
		) => callback(payload);
		ipcRenderer.on("recording-session-changed", listener);
		return () => ipcRenderer.removeListener("recording-session-changed", listener);
	},
	getCurrentRecordingSession: () => {
		return ipcRenderer.invoke("get-current-recording-session");
	},
	getCurrentVideoPath: () => {
		return ipcRenderer.invoke("get-current-video-path");
	},
	clearCurrentVideoPath: () => {
		return ipcRenderer.invoke("clear-current-video-path");
	},
	getRecordingThumbnail: (filePath: string) =>
		ipcRenderer.invoke("get-recording-thumbnail", filePath),
	finishRecordingImport: (keepPath: string, commit?: boolean) =>
		ipcRenderer.invoke("finish-recording-import", keepPath, commit),
	cancelRecordingImport: () => ipcRenderer.invoke("cancel-recording-import"),
	getProjectPreview: (projectPath: string) =>
		ipcRenderer.invoke("get-project-preview", projectPath),
	listRecordings: (includeSources?: boolean) =>
		ipcRenderer.invoke("list-recordings", includeSources),
	setRecordingsRemoved: (paths: string[], removed: boolean) =>
		ipcRenderer.invoke("set-recordings-removed", paths, removed),
	importRecording: (
		currentPath: string,
		recordingPath: string,
		webcam?: import("../src/types/recordingLibrary").RecordingWebcamSource,
	) => ipcRenderer.invoke("import-recording", currentPath, recordingPath, webcam),
	deleteRecordingFile: (filePath: string) => {
		return ipcRenderer.invoke("delete-recording-file", filePath);
	},
	getLocalMediaUrl: (filePath: string) => {
		return ipcRenderer.invoke("get-local-media-url", filePath) as Promise<
			{ success: true; url: string } | { success: false }
		>;
	},
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
		thumbnailDataUrl?: string | null,
	) => {
		return ipcRenderer.invoke(
			"save-project-file",
			projectData,
			suggestedName,
			existingProjectPath,
			thumbnailDataUrl,
		);
	},
	saveProjectFileNamed: (
		projectData: unknown,
		projectName: string,
		thumbnailDataUrl?: string | null,
		mode?: "rename" | "copy",
	) => {
		return ipcRenderer.invoke(
			"save-project-file-named",
			projectData,
			projectName,
			thumbnailDataUrl,
			mode,
		);
	},
	loadProjectFile: () => {
		return ipcRenderer.invoke("load-project-file");
	},
	loadCurrentProjectFile: () => {
		return ipcRenderer.invoke("load-current-project-file");
	},
	getProjectsDirectory: () => {
		return ipcRenderer.invoke("get-projects-directory");
	},
	onProjectThumbnailReady: (
		callback: (ready: { path: string; thumbnailPath: string; updatedAt: number }) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			ready: { path: string; thumbnailPath: string; updatedAt: number },
		) => callback(ready);
		ipcRenderer.on("project-library-thumbnail-ready", listener);
		return () => ipcRenderer.removeListener("project-library-thumbnail-ready", listener);
	},
	listProjectFiles: () => {
		return ipcRenderer.invoke("list-project-files");
	},
	openProjectFileAtPath: (filePath: string) => {
		return ipcRenderer.invoke("open-project-file-at-path", filePath);
	},
	openProjectsDirectory: () => {
		return ipcRenderer.invoke("open-projects-directory");
	},
	onMenuLoadProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-load-project", listener);
		return () => ipcRenderer.removeListener("menu-load-project", listener);
	},
	onMenuSaveProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project", listener);
		return () => ipcRenderer.removeListener("menu-save-project", listener);
	},
	onMenuSaveProjectAs: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project-as", listener);
		return () => ipcRenderer.removeListener("menu-save-project-as", listener);
	},
	getWindowChrome: () => ipcRenderer.invoke("get-window-chrome"),
	onWindowChromeChanged: (callback: (chrome: { trafficLightsVisible: boolean }) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			chrome: { trafficLightsVisible: boolean },
		) => callback(chrome);
		ipcRenderer.on("window-chrome-changed", listener);
		return () => ipcRenderer.removeListener("window-chrome-changed", listener);
	},
	getPlatform: () => {
		return ipcRenderer.invoke("get-platform");
	},
	isWindowFullscreen: () => {
		return ipcRenderer.invoke("get-window-fullscreen");
	},
	onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) =>
			callback(isFullscreen);
		ipcRenderer.on("window-fullscreen-changed", listener);
		return () => ipcRenderer.removeListener("window-fullscreen-changed", listener);
	},
	getLinuxWindowSystem: () => {
		return ipcRenderer.invoke("get-linux-window-system");
	},
	revealInFolder: (filePath: string) => {
		return ipcRenderer.invoke("reveal-in-folder", filePath);
	},
	openRecordingsFolder: () => {
		return ipcRenderer.invoke("open-recordings-folder");
	},
	getRecordingsDirectory: () => {
		return ipcRenderer.invoke("get-recordings-directory");
	},
	chooseRecordingsDirectory: () => {
		return ipcRenderer.invoke("choose-recordings-directory");
	},
	getShortcuts: () => {
		return ipcRenderer.invoke("get-shortcuts");
	},
	saveShortcuts: (shortcuts: unknown) => {
		return ipcRenderer.invoke("save-shortcuts", shortcuts);
	},
	getEditorStartupView: (): "home" | "editor" => ipcRenderer.sendSync("get-editor-startup-view"),
	getAppSetting: (key: string) => {
		const result = ipcRenderer.sendSync("app-settings:get", key) as {
			success?: boolean;
			value?: unknown;
		};
		return result?.success ? (result.value ?? null) : null;
	},
	setAppSetting: (key: string, value: unknown) => {
		const result = ipcRenderer.sendSync("app-settings:set", key, value) as {
			success?: boolean;
		};
		return result?.success === true;
	},
	setHasUnsavedChanges: (hasChanges: boolean) => {
		ipcRenderer.send("set-has-unsaved-changes", hasChanges);
	},
	onRequestSaveBeforeClose: (callback: () => Promise<boolean>) => {
		const listener = async (_event: Electron.IpcRendererEvent, requestId: unknown) => {
			let saved = false;
			try {
				saved = await callback();
			} catch {
				saved = false;
			}
			ipcRenderer.send("save-before-close-done", saved, requestId);
		};
		ipcRenderer.on("request-save-before-close", listener);
		return () => ipcRenderer.removeListener("request-save-before-close", listener);
	},
	isNativeWindowsCaptureAvailable: () =>
		ipcRenderer.invoke("is-native-windows-capture-available"),
	muxNativeWindowsRecording: (expectedDurationMs?: number) =>
		ipcRenderer.invoke("mux-native-windows-recording", expectedDurationMs),
	hideOsCursor: () => ipcRenderer.invoke("hide-cursor"),
	getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
	getRecordingPreferences: () => ipcRenderer.invoke("get-recording-preferences"),
	getRecordingAudioLabConfig: () => ipcRenderer.invoke("get-recording-audio-lab-config"),
	setRecordingPreferences: (prefs: {
		microphoneEnabled?: boolean;
		microphoneDeviceId?: string;
		systemAudioEnabled?: boolean;
		webcamEnabled?: boolean;
		webcamDeviceId?: string;
	}) => ipcRenderer.invoke("set-recording-preferences", prefs),
	getCountdownDelay: () => ipcRenderer.invoke("get-countdown-delay"),
	setCountdownDelay: (delay: number) => ipcRenderer.invoke("set-countdown-delay", delay),
	finishRecordingStartup: () => ipcRenderer.invoke("finish-recording-startup"),
	startCountdown: (seconds: number) => ipcRenderer.invoke("start-countdown", seconds),
	cancelCountdown: () => ipcRenderer.invoke("cancel-countdown"),
	getActiveCountdown: () => ipcRenderer.invoke("get-active-countdown"),
	onCountdownTick: (callback: (seconds: number) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, seconds: number) => callback(seconds);
		ipcRenderer.on("countdown-tick", listener);
		return () => ipcRenderer.removeListener("countdown-tick", listener);
	},
});
