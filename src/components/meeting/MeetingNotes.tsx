import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { MeetingMarkdown } from "./MeetingMarkdown";
import { useMeeting } from "./useMeeting";

type Tab = "notes" | "transcript";

const STAGE_LABEL: Record<NonNullable<MeetingJob["stage"]>, string> = {
	transcribe: "Transcribing",
	summarize: "Writing notes",
	title: "Naming the meeting",
};

function JobStatus({ meeting }: { meeting: ReturnType<typeof useMeeting> }) {
	const { job, busy, files } = meeting;
	if (busy && job) {
		return (
			<div
				className="rounded-xl border border-separator bg-default/30 p-3"
				role="status"
				aria-live="polite"
			>
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<div className="text-[12px] font-medium">
							{job.stage ? STAGE_LABEL[job.stage] : "Waiting to start"}
						</div>
						<div className="truncate text-[12px] text-muted-foreground">
							{job.message}
						</div>
					</div>
					<Button size="sm" variant="ghost" onClick={() => void meeting.cancel()}>
						Cancel
					</Button>
				</div>
				<div className="mt-2 h-1 overflow-hidden rounded-full bg-default">
					<div
						className={`h-full rounded-full bg-accent transition-[width] ${job.progress === null ? "w-1/3 animate-pulse" : ""}`}
						style={job.progress === null ? undefined : { width: `${job.progress}%` }}
					/>
				</div>
			</div>
		);
	}
	const failed =
		job?.status === "failed"
			? job.error
			: files.meta.lastJob?.status === "failed"
				? files.meta.lastJob.error
				: null;
	if (failed || files.interrupted) {
		const mode = job?.mode ?? files.meta.lastJob?.mode ?? "full";
		return (
			<div
				className="flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3"
				role="alert"
			>
				<div className="min-w-0 text-[12px]">
					<div className="font-medium">
						{files.interrupted ? "Processing was interrupted" : "Processing failed"}
					</div>
					{failed && (
						<div className="mt-0.5 break-words text-muted-foreground">{failed}</div>
					)}
				</div>
				<Button size="sm" variant="secondary" onClick={() => void meeting.run(mode)}>
					Retry
				</Button>
			</div>
		);
	}
	return null;
}

/**
 * Transcript and notes of one recording, with the buttons that (re)run each
 * stage. Used by the meeting view and by the video editor's side panel.
 */
export function MeetingNotes({
	mediaPath,
	onSeek,
	className = "",
}: {
	mediaPath: string;
	onSeek?: (seconds: number) => void;
	className?: string;
}) {
	const meeting = useMeeting(mediaPath);
	const { files, busy } = meeting;
	const [tab, setTab] = useState<Tab>("notes");
	const [editing, setEditing] = useState<Tab | null>(null);
	const [draft, setDraft] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: a different recording resets the editor.
	useEffect(() => {
		setEditing(null);
		setTab("notes");
	}, [mediaPath]);

	const content = tab === "notes" ? files.notes : files.transcript;
	const startEdit = () => {
		setDraft(content ?? "");
		setEditing(tab);
	};
	const saveEdit = async () => {
		if (!editing) return;
		if (await meeting.save(editing, draft)) {
			setEditing(null);
			toast.success(editing === "notes" ? "Notes saved" : "Transcript saved");
		}
	};
	const copy = async () => {
		if (!content) return;
		await navigator.clipboard.writeText(content);
		toast.success(tab === "notes" ? "Notes copied" : "Transcript copied");
	};

	const empty =
		tab === "transcript" ? (
			<div className="flex flex-col items-center gap-3 py-10 text-center text-[13px] text-muted-foreground">
				<p>No transcript yet.</p>
				<Button size="sm" disabled={busy} onClick={() => void meeting.run("transcribe")}>
					Transcribe
				</Button>
			</div>
		) : (
			<div className="flex flex-col items-center gap-3 py-10 text-center text-[13px] text-muted-foreground">
				<p>
					{files.transcript
						? "No notes yet."
						: "Transcribe the recording, then write the notes."}
				</p>
				<Button
					size="sm"
					disabled={busy}
					onClick={() => void meeting.run(files.transcript ? "summarize" : "full")}
				>
					{files.transcript ? "Write notes" : "Transcribe and write notes"}
				</Button>
			</div>
		);

	return (
		<div className={`flex min-h-0 flex-col gap-3 ${className}`}>
			<JobStatus meeting={meeting} />
			{meeting.error && !busy && (
				<p className="text-[12px] text-destructive" role="alert">
					{meeting.error}
				</p>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div
					className="flex rounded-lg bg-default/40 p-0.5"
					role="tablist"
					aria-label="Meeting content"
				>
					{(["notes", "transcript"] as const).map((value) => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={tab === value}
							className={`rounded-md px-3 py-1 text-[12px] ${tab === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}
							onClick={() => {
								setTab(value);
								setEditing(null);
							}}
						>
							{value === "notes" ? "Notes" : "Transcript"}
						</button>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-1">
					{editing ? (
						<>
							<Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
								Discard
							</Button>
							<Button size="sm" onClick={() => void saveEdit()}>
								Save
							</Button>
						</>
					) : (
						<>
							{content && (
								<>
									<Button size="sm" variant="ghost" onClick={() => void copy()}>
										Copy
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={startEdit}
									>
										Edit
									</Button>
								</>
							)}
							{tab === "notes" && files.transcript && files.notes && (
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => void meeting.run("summarize")}
								>
									Rewrite notes
								</Button>
							)}
							{tab === "transcript" && files.transcript && (
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => void meeting.run("full")}
								>
									Redo transcript and notes
								</Button>
							)}
						</>
					)}
				</div>
			</div>
			<div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
				{editing ? (
					<textarea
						aria-label={editing === "notes" ? "Edit notes" : "Edit transcript"}
						className="h-full min-h-[320px] w-full resize-none rounded-xl border border-separator bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-accent"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
				) : content ? (
					<MeetingMarkdown source={content} onSeek={onSeek} />
				) : meeting.loading ? null : (
					empty
				)}
			</div>
		</div>
	);
}
