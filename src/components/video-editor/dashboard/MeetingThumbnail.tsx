import { DocumentText, MusicNotes, VideoCamera } from "@/components/ui/icons";
import { formatMeetingDuration } from "@/components/meeting/MeetingView";

const STATUS_LABEL: Record<MeetingLibraryEntry["status"], string | null> = {
	idle: null,
	queued: "Waiting",
	running: "Processing…",
	failed: "Failed",
	interrupted: "Interrupted",
};

export function MeetingThumbnail({ meeting }: { meeting: MeetingLibraryEntry }) {
	const status = STATUS_LABEL[meeting.status];
	const duration = formatMeetingDuration(meeting.durationMs);
	const Icon = meeting.hasVideo ? VideoCamera : MusicNotes;
	return (
		<div className="relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-default/60">
			<Icon weight="fill" className="size-8 text-muted-foreground/40" />
			<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				{meeting.hasNotes ? (
					<>
						<DocumentText weight="fill" className="size-3.5" />
						Notes ready
					</>
				) : meeting.hasTranscript ? (
					"Transcript ready"
				) : (
					"Not transcribed"
				)}
			</div>
			{duration && (
				<span className="absolute bottom-2 right-2 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] tabular-nums">
					{duration}
				</span>
			)}
			{status && (
				<span
					className={`absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${meeting.status === "failed" || meeting.status === "interrupted" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent"}`}
				>
					{status}
				</span>
			)}
		</div>
	);
}
