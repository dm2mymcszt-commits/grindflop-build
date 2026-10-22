/**
 * What to say about when someone was last around.
 *
 * Grindr sends two times: when they were last active (`lastOnline`) and until
 * when they count as online (`onlineUntil`), which is ten minutes later. The
 * label used to count down to the second one ("Online (6m left)"), which
 * reads as if something were about to happen. It now says what the first one
 * means: online, and active now or so many minutes ago.
 */

export type OnlineStatusMeta = {
	isOnline: boolean;
	labelKey: string;
	count?: number;
	/** @deprecated Use labelKey and t() instead */
	label: string;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long Grindr keeps someone online after their last activity. */
export const ONLINE_WINDOW_MS = 10 * MINUTE_MS;

export function getOnlineStatusMeta(
	lastOnline: number | null | undefined,
	onlineUntil: number | null | undefined,
	nowTimestamp: number = Date.now(),
): OnlineStatusMeta {
	// lastOnline/onlineUntil of 0 is the server's "unknown/hidden" sentinel
	// (seen e.g. from Explore mode's privacy mask on cascade responses), not
	// a real epoch timestamp — treat it the same as null/undefined, otherwise
	// it renders as tens of thousands of days ago.
	const hasLastOnline =
		typeof lastOnline === "number" && Number.isFinite(lastOnline) && lastOnline > 0;
	const hasOnlineUntil =
		typeof onlineUntil === "number" && Number.isFinite(onlineUntil) && onlineUntil > 0;

	if (!hasLastOnline && !hasOnlineUntil) {
		return { isOnline: false, labelKey: "browse_page.status_offline", label: "Offline" };
	}

	if (hasOnlineUntil && (onlineUntil as number) > nowTimestamp) {
		// Without the time of their last activity, it is worked back from the
		// end of the window. A time in the future (a clock that is off) counts
		// as now, and so does anything past the window's own length.
		const lastActive = hasLastOnline
			? (lastOnline as number)
			: (onlineUntil as number) - ONLINE_WINDOW_MS;
		const idleMinutes = Math.floor(Math.max(0, nowTimestamp - lastActive) / MINUTE_MS);
		if (idleMinutes < 1 || idleMinutes > ONLINE_WINDOW_MS / MINUTE_MS) {
			return { isOnline: true, labelKey: "browse_page.status_online_now", label: "Online · active now" };
		}
		return {
			isOnline: true,
			labelKey: "browse_page.status_online_idle",
			count: idleMinutes,
			label: `Online · active ${idleMinutes} min ago`,
		};
	}

	const referenceTimestamp = hasLastOnline
		? (lastOnline as number)
		: (onlineUntil as number);
	const diffMs = Math.max(0, nowTimestamp - referenceTimestamp);

	if (diffMs < HOUR_MS) {
		const minutes = Math.max(1, Math.floor(diffMs / MINUTE_MS));
		return {
			isOnline: false,
			labelKey: "browse_page.status_minutes_ago",
			count: minutes,
			label: `${minutes}m ago`,
		};
	}

	if (diffMs < DAY_MS) {
		const hours = Math.max(1, Math.floor(diffMs / HOUR_MS));
		return {
			isOnline: false,
			labelKey: "browse_page.status_hours_ago",
			count: hours,
			label: `${hours}h ago`,
		};
	}

	const days = Math.max(1, Math.floor(diffMs / DAY_MS));
	return {
		isOnline: false,
		labelKey: "browse_page.status_days_ago",
		count: days,
		label: `${days}d ago`,
	};
}
