import { ImageOff, VideoOff } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Stands in for a photo or video that cannot be shown: one that expired, or
 * one this device never saved whose link has since stopped working. It is
 * deliberately not clickable — there is nothing to open in the viewer.
 */
export function UnavailableMediaCard({
	kind,
	expired,
	fillsBubble,
	roundedClassName,
	timeLabel,
}: {
	kind: "image" | "video";
	expired: boolean;
	/** The media is the whole bubble, so the card carries the time too. */
	fillsBubble: boolean;
	roundedClassName: string;
	timeLabel: string;
}) {
	const { t } = useTranslation();
	const Icon = kind === "video" ? VideoOff : ImageOff;
	const title = expired
		? t(kind === "video" ? "chat.thread.video_expired" : "chat.thread.image_expired")
		: kind === "video"
			? t("chat.thread.video_not_saved", { defaultValue: "Video not saved" })
			: t("chat.thread.image_not_saved", { defaultValue: "Photo not saved" });
	const detail = expired
		? t("chat.thread.media_expired_detail", { defaultValue: "It can no longer be opened." })
		: t("chat.thread.media_not_saved_detail", {
				defaultValue: "It was never saved on this device, so it can't be recovered.",
			});

	return (
		<div
			role="img"
			aria-label={`${title}. ${detail}`}
			className={`flex select-none flex-col items-center justify-center gap-1.5 border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-5 py-5 text-center ${
				fillsBubble ? `w-full ${roundedClassName}` : "mb-2 w-60 max-w-full rounded-xl"
			}`}
			style={fillsBubble ? { minWidth: "14rem" } : undefined}
		>
			<div className="mb-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--text-muted)]">
				<Icon className="h-5 w-5" />
			</div>
			<p className="text-sm font-semibold text-[var(--text)]">{title}</p>
			<p className="max-w-[15rem] text-[11px] leading-snug text-[var(--text-muted)]">{detail}</p>
			{fillsBubble ? <span className="mt-1 text-[10px] text-[var(--text-muted)]">{timeLabel}</span> : null}
		</div>
	);
}
