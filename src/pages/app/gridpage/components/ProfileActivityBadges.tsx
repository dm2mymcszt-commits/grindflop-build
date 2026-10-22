import { Eye, Flame } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../../utils/relativeTime";
import { formatDateTime24 } from "../../chat/chatUtils";
import type { ProfileViewedMeInfo } from "../../../../hooks/useProfileViewedMe";

/**
 * How long after someone views us the eye keeps its "just now" pulse. Long
 * enough that opening their profile moments after the view still shows it,
 * short enough that the badge is calm again by the time it stops being news.
 */
const JUST_VIEWED_MS = 60_000;

type ProfileActivityBadgesProps = {
	/** Whose profile this is — used to collapse the panel when it changes. */
	profileId: string | number | null | undefined;
	/** When this profile last tapped us, or null/undefined if they never did. */
	tapTimestamp: number | null | undefined;
	/** How often this profile has viewed us, or null if they never did. */
	viewedMe: ProfileViewedMeInfo | null;
};

/**
 * The overlay pills sitting in the bottom-left corner of a profile's photo:
 * "they tapped you" and "they viewed you N times". Both are incoming-interest
 * signals, so they share one row and sit side by side (never stacked or
 * overlapping) when a profile has done both.
 *
 * The view pill expands on click into the individual view times we know about
 * — hovering any of them shows the exact date and time.
 */
export function ProfileActivityBadges({
	profileId,
	tapTimestamp,
	viewedMe,
}: ProfileActivityBadgesProps) {
	const { t } = useTranslation();
	const [isViewListOpen, setIsViewListOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	// Hover drives the panel on pointer devices. Touch screens have no hover,
	// so there tap toggles it instead — otherwise the history would be
	// unreachable on mobile.
	const [canHover, setCanHover] = useState(true);

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const query = window.matchMedia("(hover: hover)");
		const sync = () => setCanHover(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);

	const showTap = tapTimestamp != null;
	const showViews = viewedMe != null;

	// Drives the eye's "they just looked at you" pulse. Keyed off the view's own
	// timestamp rather than a live-event callback, so it covers both cases with
	// one rule: a view landing while this profile is open re-arms it, and opening
	// a profile that viewed us seconds ago still shows it for the remainder of
	// the window. Re-runs whenever the latest view time changes, and clears
	// itself when the window lapses.
	const latestViewAt = viewedMe?.timestamp ?? null;
	const [isJustViewed, setIsJustViewed] = useState(false);

	useEffect(() => {
		if (latestViewAt == null) {
			setIsJustViewed(false);
			return;
		}
		const remainingMs = JUST_VIEWED_MS - (Date.now() - latestViewAt);
		if (remainingMs <= 0) {
			setIsJustViewed(false);
			return;
		}
		setIsJustViewed(true);
		const timeoutId = window.setTimeout(() => setIsJustViewed(false), remainingMs);
		return () => window.clearTimeout(timeoutId);
	}, [latestViewAt]);

	// Collapse when switching to a different profile, so the panel never lingers
	// showing the previous person's history. Deliberately keyed on identity and
	// not on the counts — a live view landing while the list is open should add
	// a row, not yank the panel shut mid-read.
	useEffect(() => {
		setIsViewListOpen(false);
	}, [profileId]);

	useEffect(() => {
		if (!isViewListOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setIsViewListOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setIsViewListOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [isViewListOpen]);

	if (!showTap && !showViews) {
		return null;
	}

	const knownTimestamps = viewedMe?.viewTimestamps ?? [];
	// The API only reports a running total plus the latest view, so older views
	// that happened before we started tracking have no recoverable timestamp.
	const untrackedCount = Math.max(0, (viewedMe?.viewCount ?? 0) - knownTimestamps.length);

	return (
		<div
			ref={containerRef}
			className="pointer-events-none absolute bottom-3 left-3 z-20 flex flex-row items-end gap-1.5"
		>
			{showTap && (
				<div className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur-sm">
					<Flame className="h-3.5 w-3.5 shrink-0 text-orange-400" />
					<span className="text-xs font-medium text-white">
						{formatRelativeTime(tapTimestamp as number)}
					</span>
				</div>
			)}
			{showViews && (
				<div
					className="relative"
					onPointerEnter={(event) => {
						if (canHover && event.pointerType !== "touch") setIsViewListOpen(true);
					}}
					onPointerLeave={(event) => {
						if (canHover && event.pointerType !== "touch") setIsViewListOpen(false);
					}}
				>
					{isViewListOpen && (
						// pb-1.5 rather than mb-1.5: padding keeps the panel's hover
						// area touching the pill, so moving the cursor up into the list
						// doesn't cross a dead gap and dismiss it.
						<div
							onPointerDown={(e) => e.stopPropagation()}
							className="pointer-events-auto absolute bottom-full left-0 pb-1.5"
						>
							<div className="max-h-56 w-max min-w-40 max-w-64 overflow-y-auto overscroll-contain rounded-2xl bg-black/80 p-2 shadow-xl backdrop-blur-md">
								<p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
									{t("profile_details.viewed_you_times", {
										defaultValue: "Viewed you {{count}}x",
										count: viewedMe.viewCount,
									})}
								</p>
								{knownTimestamps.length > 0 ? (
									<ul className="flex flex-col">
										{knownTimestamps.map((at, index) => (
											<li key={`${at}-${index}`}>
												<span
													title={formatDateTime24(at)}
													className="block cursor-default rounded-lg px-2 py-1 text-xs text-white/90 transition-colors hover:bg-white/10 hover:text-white"
												>
													{formatRelativeTime(at)}
												</span>
											</li>
										))}
									</ul>
								) : (
									<p className="px-2 py-1 text-xs text-white/60">
										{t("profile_details.viewed_you_no_history", {
											defaultValue: "No view times recorded yet.",
										})}
									</p>
								)}
								{untrackedCount > 0 && knownTimestamps.length > 0 && (
									<p className="mt-1 border-t border-white/10 px-2 pt-1.5 text-[10px] leading-snug text-white/45">
										{t("profile_details.viewed_you_untracked", {
											defaultValue_one:
												"{{count}} earlier view time wasn't recorded.",
											defaultValue_other:
												"{{count}} earlier view times weren't recorded.",
											count: untrackedCount,
										})}
									</p>
								)}
							</div>
						</div>
					)}
					<button
						type="button"
						onClick={(event) => {
							// The photo-viewer trigger sits underneath this overlay.
							event.stopPropagation();
							// On hover-capable devices the pointer handlers already own
							// the open state; toggling here too would fight them.
							if (!canHover) setIsViewListOpen((open) => !open);
						}}
						onFocus={() => setIsViewListOpen(true)}
						onBlur={() => setIsViewListOpen(false)}
						aria-expanded={isViewListOpen}
						// The pulse is the only cue that a view is fresh, so say it
						// outright for anyone who can't perceive the animation.
						aria-label={[
							t("profile_details.viewed_you_times", {
								defaultValue: "Viewed you {{count}}x",
								count: viewedMe.viewCount,
							}),
							isJustViewed
								? t("profile_details.viewed_you_just_now", {
										defaultValue: "viewed you just now",
									})
								: null,
						]
							.filter(Boolean)
							.join(" — ")}
						className={`pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 backdrop-blur-sm transition-colors ${
							isViewListOpen ? "bg-black/75" : "bg-black/50 hover:bg-black/65"
						}`}
					>
						<span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
							{isJustViewed && (
								<span
									aria-hidden="true"
									className="absolute inset-0 rounded-full bg-[var(--accent)] animate-viewed-now-ring motion-reduce:hidden"
								/>
							)}
							<Eye
								className={`relative h-3.5 w-3.5 shrink-0 transition-colors ${
									isJustViewed
										? "text-[var(--accent)] animate-viewed-now-eye motion-reduce:animate-none"
										: "text-white/80"
								}`}
							/>
						</span>
						<span className="text-xs font-medium tabular-nums text-white">
							{viewedMe.viewCount}
						</span>
					</button>
				</div>
			)}
		</div>
	);
}
