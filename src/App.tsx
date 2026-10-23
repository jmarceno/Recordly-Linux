import { Card } from "@heroui/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { HomeLoadingSkeleton } from "./components/video-editor/dashboard/HomeLoadingSkeleton";
import { EditorLoadingSkeleton } from "./components/video-editor/layout/EditorLoadingSkeleton";
import { useI18n } from "./contexts/I18nContext";
import { getStartupView } from "./lib/startupView";

const HudWindow = lazy(() => import("./components/launch/HudWindow"));
const HudMenuWindow = lazy(() =>
	import("./components/launch/HudMenuWindow").then((module) => ({
		default: module.HudMenuWindow,
	})),
);
const SourceSelector = lazy(() =>
	import("./components/launch/SourceSelector").then((module) => ({
		default: module.SourceSelector,
	})),
);
const CountdownOverlay = lazy(() =>
	import("./components/countdown/CountdownOverlay").then((module) => ({
		default: module.CountdownOverlay,
	})),
);
const EditorWindow = lazy(() => import("./components/video-editor/EditorWindow"));
const CapturePicker = lazy(() => import("./components/capture-picker/CapturePicker"));

export default function App() {
	const [windowType] = useState(
		() => new URLSearchParams(window.location.search).get("windowType") || "",
	);
	const { t } = useI18n();
	const appIconSrc = "/app-icons/recordly-128.png";

	useEffect(() => {
		document.documentElement.dataset.windowType = windowType;

		if (
			windowType === "hud-overlay" ||
			windowType === "hud-menu" ||
			windowType === "source-selector" ||
			windowType === "countdown" ||
			windowType === "capture-picker"
		) {
			document.body.style.background = "transparent";
			document.documentElement.style.background = "transparent";
			document.getElementById("root")?.style.setProperty("background", "transparent");
		}

		if (windowType === "hud-overlay") {
			document.documentElement.classList.add("hud-overlay-window");
			document.body.classList.add("hud-overlay-window");
			document.getElementById("root")?.classList.add("hud-overlay-window");
			window.electronAPI?.hudOverlaySetIgnoreMouse?.(true);
		}
	}, [windowType]);

	useEffect(() => {
		document.title =
			windowType === "editor"
				? t("app.editorTitle", "Recordly Editor")
				: t("app.name", "Recordly");
	}, [windowType, t]);

	let content;
	switch (windowType) {
		case "hud-overlay":
			content = <HudWindow />;
			break;
		case "hud-menu":
			content = <HudMenuWindow />;
			break;
		case "source-selector":
			content = <SourceSelector />;
			break;
		case "countdown":
			content = <CountdownOverlay />;
			break;
		case "editor":
			content = <EditorWindow />;
			break;
		case "capture-picker":
			content = <CapturePicker />;
			break;
		default:
			content = (
				<div className="flex h-full w-full items-center justify-center bg-editor-bg text-foreground">
					<Card className="flex-row items-center gap-4 px-6 py-5">
						<img
							src={appIconSrc}
							alt={t("app.name", "Recordly")}
							className="h-12 w-12 rounded-xl"
						/>
						<div>
							<h1 className="text-xl font-semibold tracking-tight">
								{t("app.name", "Recordly")}
							</h1>
							<p className="text-sm text-foreground/65">
								{t("app.subtitle", "Screen recording and editing")}
							</p>
						</div>
					</Card>
				</div>
			);
	}

	return (
		<Suspense
			fallback={
				windowType === "editor" ? (
					getStartupView() === "home" ? (
						<HomeLoadingSkeleton />
					) : (
						<EditorLoadingSkeleton />
					)
				) : null
			}
		>
			{content}
		</Suspense>
	);
}
