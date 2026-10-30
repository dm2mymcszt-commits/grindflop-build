import { useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../utils/cn";

type FilterPillProps = {
	icon?: ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
	onContextMenu?: (e: React.MouseEvent) => void;
	onLongPress?: () => void;
	/** Which brand color this pill tints as — defaults to the app's generic
	 * accent. "right-now" reads in Right Now's own brand color instead (see
	 * RightNowPage.tsx's --right-now), for filters tied to that feature.
	 * Kept as a fixed set (not an arbitrary CSS color) rather than computing
	 * shadow/border colors dynamically — Tailwind's shadow-[...] utilities
	 * only exist for class strings that appear literally in source, and
	 * these two already do (GridPage.tsx, RightNowPage.tsx), so reusing them
	 * verbatim guarantees this matches the same shadow those already use
	 * instead of a hand-rolled approximation. */
	color?: "accent" | "right-now";
	/** "label" (default): icon + visible text, sized to content.
	 * "icon": icon-only square button (aria-label/title carry the label). */
	variant?: "label" | "icon";
	badge?: string | number;
};

/** Shared quick-filter pill used by both GridPage's and the chat inbox's
 * header filter rows, so the same toggle-pill look/behavior (including a
 * per-filter brand color override) isn't reimplemented in each screen. */
export function FilterPill({
	icon,
	label,
	active,
	onClick,
	onContextMenu,
	onLongPress,
	color = "accent",
	variant = "label",
	badge,
}: FilterPillProps) {
	const isIconOnly = variant === "icon";
	const isRightNow = color === "right-now";

	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isLongPressRef = useRef(false);

	const startLongPress = () => {
		if (!onLongPress) return;
		isLongPressRef.current = false;
		if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
		longPressTimerRef.current = setTimeout(() => {
			isLongPressRef.current = true;
			onLongPress();
		}, 500);
	};

	const clearLongPress = () => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	};

	const handleClick = (e: React.MouseEvent) => {
		if (isLongPressRef.current) {
			e.preventDefault();
			e.stopPropagation();
			isLongPressRef.current = false;
			return;
		}
		onClick();
	};

	const handleContextMenu = (e: React.MouseEvent) => {
		if (onContextMenu) {
			e.preventDefault();
			onContextMenu(e);
		} else if (onLongPress) {
			e.preventDefault();
			onLongPress();
		}
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			onContextMenu={handleContextMenu}
			onTouchStart={startLongPress}
			onTouchEnd={clearLongPress}
			onTouchCancel={clearLongPress}
			onMouseDown={startLongPress}
			onMouseUp={clearLongPress}
			onMouseLeave={clearLongPress}
			aria-label={isIconOnly ? label : undefined}
			title={isIconOnly ? label : undefined}
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 text-sm font-bold transition-all active:scale-95 outline-none focus:outline-none focus-visible:outline-none select-none",
				isIconOnly ? "size-9 justify-center" : "px-4 py-2",
				active
					? isRightNow
						? "rounded-full border border-[var(--right-now)] bg-[var(--right-now)] text-white shadow-lg shadow-[var(--right-now)]/40"
						: "rounded-full border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg shadow-[var(--accent)]/40"
					: "glass-pill text-[var(--accent)]",
			)}
			style={!active ? ({ "--pill-color": "var(--accent)" } as CSSProperties) : undefined}
		>
			{icon}
			{!isIconOnly && label}
			{badge != null && badge !== "" && (
				<span className={cn(
					"ml-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold transition-colors",
					active
						? "bg-[var(--accent-contrast)] text-[var(--accent)]"
						: "bg-[var(--accent)] text-[var(--accent-contrast)]"
				)}>
					{badge}
				</span>
			)}
		</button>
	);
}
