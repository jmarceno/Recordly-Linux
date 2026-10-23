import type { ReactNode } from "react";

/**
 * Renders the small Markdown subset meeting notes and transcripts use:
 * headings, bullets, checklists, bold, italics and inline code. `[HH:MM:SS]`
 * timestamps become buttons that seek the recording.
 */
const TIMESTAMP = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*/;

export function parseTimestampSeconds(text: string) {
	const match = TIMESTAMP.exec(text);
	if (!match) return null;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function renderInline(text: string): ReactNode[] {
	const parts: ReactNode[] = [];
	const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > last) parts.push(text.slice(last, index));
		const token = match[0];
		if (token.startsWith("**")) parts.push(<strong key={index}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("`"))
			parts.push(
				<code key={index} className="rounded bg-default/60 px-1 text-[0.92em]">
					{token.slice(1, -1)}
				</code>,
			);
		else parts.push(<em key={index}>{token.slice(1, -1)}</em>);
		last = index + token.length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}

function Timestamped({ text, onSeek }: { text: string; onSeek?: (seconds: number) => void }) {
	const seconds = parseTimestampSeconds(text);
	if (seconds === null) return <>{renderInline(text)}</>;
	const match = TIMESTAMP.exec(text);
	const label = match ? match[0].trim() : "";
	const rest = text.slice(match?.[0].length ?? 0);
	return (
		<>
			{onSeek ? (
				<button
					type="button"
					className="mr-2 rounded font-mono text-[12px] text-accent hover:underline"
					title="Play from here"
					onClick={() => onSeek(seconds)}
				>
					{label}
				</button>
			) : (
				<span className="mr-2 font-mono text-[12px] text-muted-foreground">{label}</span>
			)}
			{renderInline(rest)}
		</>
	);
}

export function MeetingMarkdown({
	source,
	onSeek,
}: {
	source: string;
	onSeek?: (seconds: number) => void;
}) {
	const blocks: ReactNode[] = [];
	let list: ReactNode[] = [];
	const flushList = () => {
		if (list.length === 0) return;
		blocks.push(
			<ul key={`list-${blocks.length}`} className="my-2 space-y-1 pl-1">
				{list}
			</ul>,
		);
		list = [];
	};
	source.split("\n").forEach((rawLine, index) => {
		const line = rawLine.trimEnd();
		if (!line.trim()) {
			flushList();
			return;
		}
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			flushList();
			const level = heading[1].length;
			const className =
				level <= 2
					? "mt-5 mb-2 text-[15px] font-semibold first:mt-0"
					: "mt-4 mb-1.5 text-[14px] font-semibold first:mt-0";
			blocks.push(
				<div key={index} role="heading" aria-level={level} className={className}>
					{renderInline(heading[2])}
				</div>,
			);
			return;
		}
		const checklist = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
		if (checklist) {
			list.push(
				<li key={index} className="flex gap-2">
					<span aria-hidden className="mt-0.5 select-none text-muted-foreground">
						{checklist[1] === " " ? "☐" : "☑"}
					</span>
					<span>{renderInline(checklist[2])}</span>
				</li>,
			);
			return;
		}
		const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
		if (bullet) {
			list.push(
				<li
					key={index}
					className="flex gap-2"
					style={{ paddingLeft: Math.min(3, Math.floor(bullet[1].length / 2)) * 16 }}
				>
					<span aria-hidden className="select-none text-muted-foreground">
						•
					</span>
					<span>
						<Timestamped text={bullet[2]} onSeek={onSeek} />
					</span>
				</li>,
			);
			return;
		}
		flushList();
		blocks.push(
			<p key={index} className="my-2 leading-relaxed">
				<Timestamped text={line} onSeek={onSeek} />
			</p>,
		);
	});
	flushList();
	return <div className="text-[13px] leading-relaxed text-foreground">{blocks}</div>;
}
