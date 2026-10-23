import { Modal } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FolderOpen } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { MeetingNotes } from "./MeetingNotes";

export function meetingTitle(meta: MeetingMeta, fallbackMs?: number) {
	if (meta.title?.trim()) return meta.title.trim();
	const created = meta.createdAt ? Date.parse(meta.createdAt) : fallbackMs;
	if (!created) return "Meeting";
	const date = new Date(created);
	return `Meeting ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function formatMeetingDuration(ms: number | null | undefined) {
	if (!ms) return null;
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function TitleEditor({ mediaPath }: { mediaPath: string }) {
	const [meta, setMeta] = useState<MeetingMeta>({});
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	useEffect(() => {
		let active = true;
		const load = () =>
			void window.electronAPI.meetingGetFiles(mediaPath).then((result) => {
				if (active && result.success) setMeta(result.meta ?? {});
			});
		load();
		const unsubscribe = window.electronAPI.onMeetingJobUpdate((job) => {
			if (job.mediaPath === mediaPath && job.status === "done") load();
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [mediaPath]);

	const title = meetingTitle(meta);
	const submit = async () => {
		setEditing(false);
		if (!draft.trim() || draft.trim() === title) return;
		const result = await window.electronAPI.meetingRename({ mediaPath, title: draft });
		if (result.success) setMeta((current) => ({ ...current, title: result.title }));
		else toast.error(result.error ?? "Could not rename the meeting.");
	};

	return (
		<div className="min-w-0 flex-1">
			{editing ? (
				<input
					autoFocus
					aria-label="Meeting title"
					className="w-full max-w-xl rounded-lg border border-separator bg-background px-2 py-1 text-[15px] font-semibold outline-none focus:border-accent"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => void submit()}
					onKeyDown={(event) => {
						if (event.key === "Enter") void submit();
						if (event.key === "Escape") setEditing(false);
					}}
				/>
			) : (
				<button
					type="button"
					className="max-w-full truncate rounded px-1 text-left text-[15px] font-semibold hover:bg-default/40"
					title="Rename"
					onClick={() => {
						setDraft(title);
						setEditing(true);
					}}
				>
					{title}
				</button>
			)}
			<div className="px-1 text-[12px] text-muted-foreground">
				{[
					meta.createdAt ? new Date(meta.createdAt).toLocaleString() : null,
					formatMeetingDuration(meta.durationMs),
					meta.language ? meta.language.toUpperCase() : null,
				]
					.filter(Boolean)
					.join(" · ")}
			</div>
		</div>
	);
}

/** Full-screen view of one meeting: player, notes and transcript. */
export function MeetingView({
	mediaPath,
	onClose,
}: {
	mediaPath: string | null;
	onClose: () => void;
}) {
	const [url, setUrl] = useState<string | null>(null);
	const [hasVideo, setHasVideo] = useState(false);
	const playerRef = useRef<HTMLMediaElement | null>(null);

	useEffect(() => {
		setUrl(null);
		if (!mediaPath) return;
		let active = true;
		setHasVideo(/\.(mp4|mov|webm|mkv)$/i.test(mediaPath));
		void window.electronAPI.meetingMediaUrl(mediaPath).then((result) => {
			if (active && result.success && result.url) setUrl(result.url);
		});
		return () => {
			active = false;
		};
	}, [mediaPath]);

	const seek = (seconds: number) => {
		const player = playerRef.current;
		if (!player) return;
		player.currentTime = seconds;
		void player.play().catch(() => undefined);
	};

	return (
		<Modal
			isOpen={Boolean(mediaPath)}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Modal.Backdrop>
				<Modal.Container size="full">
					<Modal.Dialog
						aria-label="Meeting"
						className="dashboard-surface flex h-full flex-col gap-0 rounded-none bg-background p-0 text-foreground"
					>
						{mediaPath && (
							<>
								<header className="flex items-center gap-3 border-b border-separator px-4 py-3">
									<Button
										variant="ghost"
										size="icon"
										aria-label="Back to the library"
										title="Back"
										onClick={onClose}
									>
										<ArrowLeft className="size-5" />
									</Button>
									<TitleEditor mediaPath={mediaPath} />
									<Button
										variant="ghost"
										size="sm"
										className="gap-2"
										onClick={() =>
											void window.electronAPI.meetingReveal(mediaPath)
										}
									>
										<FolderOpen className="size-4" />
										Show files
									</Button>
								</header>
								<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 lg:flex-row">
									<section className="flex shrink-0 flex-col gap-3 lg:w-[42%]">
										{url &&
											(hasVideo ? (
												<video
													ref={(node) => {
														playerRef.current = node;
													}}
													controls
													src={url}
													className="max-h-[50vh] w-full rounded-xl bg-black"
												/>
											) : (
												<audio
													ref={(node) => {
														playerRef.current = node;
													}}
													controls
													src={url}
													className="w-full"
												/>
											))}
										<p className="text-[12px] text-muted-foreground">
											Click a timestamp in the transcript to play from there.
										</p>
									</section>
									<MeetingNotes
										mediaPath={mediaPath}
										onSeek={seek}
										className="min-h-0 flex-1"
									/>
								</div>
							</>
						)}
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</Modal>
	);
}
