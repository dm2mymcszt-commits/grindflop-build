import { useEffect, useState } from "react";
import { ArrowUp, Flame, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

type PhotoActionBarProps = {
	onSendText: (text: string) => void | Promise<void>;
	/** Omit to hide the reaction button entirely (e.g. profile photo replies, which have no reaction). */
	onReact?: () => void | Promise<void>;
	placeholder?: string;
};

const GLASS = "bg-white/10 ring-1 ring-inset ring-white/15 backdrop-blur-xl";

/**
 * Reply to (or 🔥-react to) the photo on screen in PhotoViewer. The viewer
 * supplies the bottom shade and safe-area spacing; this is the glass capsule
 * with its send button, and the flame beside it.
 */
export function PhotoActionBar({ onSendText, onReact, placeholder }: PhotoActionBarProps) {
	const { t } = useTranslation();
	const [text, setText] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [isReacting, setIsReacting] = useState(false);
	const [justReacted, setJustReacted] = useState(false);
	const canSend = text.trim().length > 0 && !isSending;

	useEffect(() => {
		if (!justReacted) return;
		const timer = window.setTimeout(() => setJustReacted(false), 1200);
		return () => window.clearTimeout(timer);
	}, [justReacted]);

	const handleSend = async () => {
		const trimmed = text.trim();
		if (!trimmed || isSending) return;
		setIsSending(true);
		try {
			await onSendText(trimmed);
			setText("");
		} finally {
			setIsSending(false);
		}
	};

	const handleReact = async () => {
		if (!onReact || isReacting) return;
		setIsReacting(true);
		try {
			await onReact();
			setJustReacted(true);
		} finally {
			setIsReacting(false);
		}
	};

	return (
		<div className="flex items-center gap-2">
			<form
				className={`flex h-12 min-w-0 flex-1 items-center gap-2 rounded-full pl-4 pr-1.5 transition focus-within:bg-white/15 ${GLASS}`}
				onSubmit={(event) => {
					event.preventDefault();
					void handleSend();
				}}
			>
				<input
					type="text"
					value={text}
					onChange={(event) => setText(event.target.value)}
					disabled={isSending}
					enterKeyHint="send"
					placeholder={placeholder ?? t("photo_viewer.reply_placeholder", { defaultValue: "Reply…" })}
					className="h-full min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-white/60 disabled:opacity-60"
				/>
				{canSend || isSending ? (
					<button
						type="submit"
						disabled={!canSend}
						aria-label={t("chat.send", { defaultValue: "Send" })}
						className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] transition active:scale-90 disabled:opacity-70"
					>
						{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-5 w-5" strokeWidth={2.5} />}
					</button>
				) : null}
			</form>
			{onReact ? (
				<button
					type="button"
					onClick={() => void handleReact()}
					disabled={isReacting}
					aria-label={t("photo_viewer.react", { defaultValue: "React" })}
					className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-orange-400 transition active:scale-90 disabled:opacity-60 ${GLASS} ${
						justReacted ? "bg-orange-500/25 ring-orange-400/50" : ""
					}`}
				>
					{isReacting ? (
						<Loader2 className="h-5 w-5 animate-spin text-white" />
					) : (
						<Flame
							className={`h-6 w-6 transition-transform duration-300 ${justReacted ? "scale-125" : ""}`}
							fill={justReacted ? "currentColor" : "none"}
							style={{ filter: "drop-shadow(0 0 6px rgba(255,140,0,0.7))" }}
						/>
					)}
				</button>
			) : null}
		</div>
	);
}
