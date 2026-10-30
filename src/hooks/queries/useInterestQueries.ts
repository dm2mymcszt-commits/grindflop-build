import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiFunctions } from "../useApiFunctions";
import { useEffect } from "react";
import { TAP_RECEIVED_EVENT, VIEW_RECEIVED_EVENT, type ViewReceivedDetail } from "../../components/ChatRealtimeBridge";
import {
	getActiveInterestViewsAccount,
	interestViewsStore,
} from "../../services/interestViewsStore";
import { logViewerDistances, markStatsRecording } from "../../services/statsLog";
import {
	fromStoredView,
	toStoredView,
	normalizeViews,
	normalizeTaps,
	PREVIEW_ID_PREFIX,
	type InterestItem,
} from "../../pages/app/interest/interestUtils";
import { overlayLiveViews, type LiveView } from "../../pages/app/interest/liveViews";
import { useTranslation } from "react-i18next";
import { DEFAULT_STALE_TIME_MS } from "../../config/ui-constants";
import { readViewScanIntervalSeconds } from "../../utils/viewScanInterval";

// Views Grindr announced live and its views list does not show yet, kept until
// the list catches up (usually a few minutes) or for this long at most.
const LIVE_VIEW_KEEP_MS = 15 * 60_000;
const pendingLiveViews = new Map<string, LiveView & { account: string | null; receivedAt: number }>();

function currentLiveViews(account: string | null): LiveView[] {
	const now = Date.now();
	for (const [profileId, live] of pendingLiveViews) {
		if (now - live.receivedAt > LIVE_VIEW_KEEP_MS) pendingLiveViews.delete(profileId);
	}
	return [...pendingLiveViews.values()].filter((live) => live.account === account);
}

export function useInterestData() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	const { t } = useTranslation();

	const query = useQuery({
		queryKey: ["interest", "list"],
		queryFn: async () => {
			// Snapshot the account before any awaiting, so a switch mid-fetch
			// discards this result rather than filing it under the new account.
			const account = getActiveInterestViewsAccount();

			// 1. Parallel fetch from API
			const [tapsResponse, viewsResponse] = await Promise.all([
				api.getTaps(),
				api.getViews(),
			]);

			// 2. Load cached views from IndexedDB (persistence)
			const cachedRows = await interestViewsStore.getAll();
			const cachedViews = cachedRows.map(fromStoredView);

			// 3. Normalize & Merge
			const mergedViews = normalizeViews(viewsResponse, cachedViews, t);
			// Viewers announced live that Grindr's list does not show yet stay on
			// top until it does; the store below never sees them (see overlayLiveViews).
			const live = overlayLiveViews(mergedViews, currentLiveViews(account));
			for (const profileId of live.settled) pendingLiveViews.delete(profileId);
			const normalizedViews = live.views;
			const normalizedTaps = normalizeTaps(tapsResponse, t);

			// 4. Update persistence store with merged views.
			//    Previews are excluded deliberately: they're locked placeholders
			//    with no recoverable profile ID, and an unhashed one keys off its
			//    position in the list, so its synthetic ID changes as the list
			//    reorders. Persisting them minted new rows on every refresh and
			//    inflated the saved-profile count with entries nothing could open.
			//    Only rows this response lists can carry anything new; the rest of
			//    normalizedViews is the store read straight back, and rewriting it
			//    cost one IndexedDB read per saved viewer on every fetch. Hash
			//    matching keeps recovered previews in.
			const listedNow = normalizeViews(viewsResponse, [], t);
			const listedProfileIds = new Set(listedNow.map((item) => item.profileId));
			const listedImageHashes = new Set(
				listedNow.flatMap((item) => (item.imageHash ? [item.imageHash] : [])),
			);
			// From the list before the live overlay: a live time must never reach the store.
			const listedViewers = mergedViews
				.filter((item) => !item.profileId.startsWith(PREVIEW_ID_PREFIX))
				.filter(
					(item) =>
						listedProfileIds.has(item.profileId) ||
						(item.imageHash != null && listedImageHashes.has(item.imageHash)),
				);
			await interestViewsStore.upsertMany(
				listedViewers.map((item) => toStoredView(item)),
				account,
			);
			if (getActiveInterestViewsAccount() === account) {
				markStatsRecording("interest_page");
				logViewerDistances(listedViewers, "views_list", PREVIEW_ID_PREFIX);
			}

			// What the server itself is still listing this fetch. `normalizedViews`
			// above deliberately keeps viewers the server has dropped — that is
			// the whole point of the recovery store — so telling "Grindr no longer
			// counts them" from "merely merged in from cache" needs the raw
			// response's own ids. Hash matching mirrors the background sweep's: a
			// viewer the server now shows only as a locked preview is still inside
			// totalViewers, and must not be counted a second time.
			const incomingViews = normalizeViews(viewsResponse, [], t);

			return {
				taps: normalizedTaps,
				views: normalizedViews,
				// Extract viewedCount from the raw response for the UI
				viewedCount: (viewsResponse as any)?.totalViewers || (viewsResponse as any)?.data?.totalViewers || 0,
				serverProfileIds: incomingViews
					.filter((item) => !item.profileId.startsWith(PREVIEW_ID_PREFIX))
					.map((item) => item.profileId),
				serverImageHashes: incomingViews.flatMap((item) =>
					item.imageHash ? [item.imageHash] : [],
				),
			};
		},
		staleTime: DEFAULT_STALE_TIME_MS,
		refetchOnWindowFocus: true, // Auto-sync when app returns to foreground
		// While the page is open it follows the views sweep's pace; before, it
		// only moved on a live view or a return to the window.
		refetchInterval: () => readViewScanIntervalSeconds() * 1000,
	});

	// Handle WebSocket updates
	useEffect(() => {
		const handleUpdate = () => {
			// Invalidate query to trigger a background refetch
			queryClient.invalidateQueries({ queryKey: ["interest", "list"] });
		};

		// Shown at once rather than after the refetch: Grindr's views list
		// takes minutes to include a view its websocket announced right away.
		const handleLiveView = (event: Event) => {
			const detail = (event as CustomEvent<ViewReceivedDetail>).detail;
			if (detail && /^\d+$/.test(detail.profileId)) {
				const timestamp = detail.timestamp < 100_000_000_000 ? detail.timestamp * 1000 : detail.timestamp;
				const live: LiveView = { profileId: detail.profileId, imageHash: detail.imageHash, timestamp };
				pendingLiveViews.set(detail.profileId, {
					...live,
					account: getActiveInterestViewsAccount(),
					receivedAt: Date.now(),
				});
				queryClient.setQueryData<{ views: InterestItem[] }>(["interest", "list"], (old) =>
					old ? { ...old, views: overlayLiveViews(old.views, [live]).views } : old,
				);
			}
			handleUpdate();
		};

		window.addEventListener(TAP_RECEIVED_EVENT, handleUpdate);
		window.addEventListener(VIEW_RECEIVED_EVENT, handleLiveView);

		return () => {
			window.removeEventListener(TAP_RECEIVED_EVENT, handleUpdate);
			window.removeEventListener(VIEW_RECEIVED_EVENT, handleLiveView);
		};
	}, [queryClient]);

	return query;
}
