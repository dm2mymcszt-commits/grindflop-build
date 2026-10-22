import { useEffect, useRef, useState } from "react";
import { interestViewsStore } from "../services/interestViewsStore";
import { VIEW_RECEIVED_EVENT, type ViewReceivedDetail } from "../components/ChatRealtimeBridge";

export type ProfileViewedMeInfo = {
	/** How many times this profile has viewed us. Always >= 1 when present. */
	viewCount: number;
	/** When they most recently viewed us, or null if the record has no timestamp. */
	timestamp: number | null;
	/**
	 * Exact times of the individual views we've observed, newest first. The API
	 * only ever reports a total plus the latest view, so this is accumulated
	 * locally and can be shorter than `viewCount` — see the store's
	 * `viewTimestamps` docs.
	 */
	viewTimestamps: number[];
};

/**
 * "How many times has this profile viewed me?" — the same signal the Interest
 * page's Views tab shows, made available anywhere a profile is rendered.
 *
 * Reads from interestViewsStore (IndexedDB) rather than hitting the API:
 * BackgroundViewScanner already refreshes that store app-wide on a timer, so
 * this adds no network cost and still works offline / on a cold Interest tab.
 * Returns null when this profile isn't among our viewers (or the record has
 * aged out of the store's 30-day window).
 */
export function useProfileViewedMe(
	profileId: string | number | null | undefined,
): ProfileViewedMeInfo | null {
	const [info, setInfo] = useState<ProfileViewedMeInfo | null>(null);
	// Live views can arrive well before the background scanner writes them to
	// the store, so a plain re-read would briefly show a stale (lower) count
	// and then jump. Track what we've observed live and never render below it.
	const liveFloorRef = useRef<ProfileViewedMeInfo | null>(null);
	// The latest value handed to setInfo, mirrored synchronously. The effect
	// below binds its listener once per profile, so reading `info` from the
	// closure would pin it to the render the listener was created in — always
	// the initial null. Every live bump then counted up from zero, landed below
	// the stored count, and was swallowed by the floor: a profile already known
	// to have viewed us 5 times stayed at 5 when the 6th view arrived, until
	// the background scanner happened to write it.
	const infoRef = useRef<ProfileViewedMeInfo | null>(null);

	const normalizedId = profileId == null ? null : String(profileId);

	useEffect(() => {
		liveFloorRef.current = null;
		infoRef.current = null;

		if (!normalizedId) {
			setInfo(null);
			return;
		}

		let cancelled = false;

		const applyInfo = (next: ProfileViewedMeInfo | null) => {
			infoRef.current = next;
			setInfo(next);
		};

		const merge = (
			a: ProfileViewedMeInfo | null,
			b: ProfileViewedMeInfo | null,
		): ProfileViewedMeInfo | null => {
			if (!a) return b;
			if (!b) return a;
			return {
				viewCount: Math.max(a.viewCount, b.viewCount),
				timestamp: Math.max(a.timestamp ?? 0, b.timestamp ?? 0) || null,
				viewTimestamps: [...new Set([...a.viewTimestamps, ...b.viewTimestamps])].sort(
					(x, y) => y - x,
				),
			};
		};

		const refresh = () => {
			void interestViewsStore
				.getByProfileId(normalizedId)
				.then((row) => {
					if (cancelled) return;
					const stored = row
						? {
								// A stored row means at least one view happened even if the
								// server never sent a count — mirrors the Interest list's `|| 1`.
								// Floored by the recorded history too: the count is rebuilt from the
								// API while the history accumulates locally, so a row written before
								// the store enforced that floor can claim fewer views than the list
								// of view times sitting right next to it.
								viewCount: Math.max(
									row.viewCount ?? 0,
									row.viewTimestamps?.length ?? 0,
									1,
								),
								timestamp: row.timestamp ?? null,
								viewTimestamps: row.viewTimestamps ?? [],
							}
						: null;
					applyInfo(merge(stored, liveFloorRef.current));
				})
				.catch(() => {});
		};

		const handleViewReceived = (event: Event) => {
			const detail = (event as CustomEvent<ViewReceivedDetail>).detail;
			// The payload's viewedCount is our global viewer total, not this
			// profile's per-viewer count — so derive the bump locally instead.
			if (detail?.profileId === normalizedId) {
				const at = detail.timestamp ?? Date.now();
				// Both refs, not just the floor: a store read since the last live
				// bump may have raised the count above it.
				const current = merge(liveFloorRef.current, infoRef.current);
				const known = current?.viewTimestamps ?? [];
				// A duplicate or replayed delivery of a view we've already counted
				// must not bump the total a second time.
				if (!known.includes(at)) {
					liveFloorRef.current = {
						viewCount: (current?.viewCount ?? 0) + 1,
						timestamp: at,
						viewTimestamps: [at, ...known].sort((x, y) => y - x),
					};
					applyInfo(liveFloorRef.current);
				}
			}
			refresh();
		};

		refresh();
		window.addEventListener(VIEW_RECEIVED_EVENT, handleViewReceived);
		return () => {
			cancelled = true;
			window.removeEventListener(VIEW_RECEIVED_EVENT, handleViewReceived);
		};
	}, [normalizedId]);

	return info;
}
