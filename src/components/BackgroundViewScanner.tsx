import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApiFunctions } from "../hooks/useApiFunctions";
import { useAuth } from "../contexts/useAuth";
import {
	getActiveInterestViewsAccount,
	interestViewsStore,
} from "../services/interestViewsStore";
import {
	establishViewAutoBlockBaseline,
	hasViewAutoBlockBaseline,
	isNewViewEvent,
	markViewProcessed,
	normalizeViewTimestamp,
	seedViewAutoBlockBaselineFromLiveView,
} from "../services/interestViewAutoBlockState";
import { findConversationByProfileId } from "../services/chatDb";
import { preserveAndAutoBlockProfile } from "../services/autoBlockConversation";
import { normalizeViews, fromStoredView, toStoredView, PREVIEW_ID_PREFIX, type InterestItem } from "../pages/app/interest/interestUtils";
import type { ProfileDetail } from "../types/grid";
import {
	getMatchedForbiddenWord,
	hasRightNowStatus,
	hasTwitterAccount,
	INTEREST_VIEW_SCAN_EVENT,
	isForbiddenLookingFor,
	isInterestViewAutoBlockEnabled,
	isOutsideAgeLimits,
	isOutsideDistanceLimits,
	notifyAutoBlockBatch,
} from "../utils/autoblock";
import {
	checkAndAutoWhitelistActiveChat,
	isProfileAutoblockWhitelisted,
} from "../utils/privacy";
import { appLog } from "../utils/logger";
import { setUnthrottledTimeout, type UnthrottledTimeout } from "../utils/unthrottledTimeout";
import { readViewScanIntervalSeconds } from "../utils/viewScanInterval";
import { logViewerDistances, markStatsRecording } from "../services/statsLog";
import {
	VIEW_RECEIVED_EVENT,
	type ViewReceivedDetail,
} from "./ChatRealtimeBridge";

/** Backoff after a failed sweep so a rate-limited account stops hammering. */
const ERROR_BACKOFF_SECONDS = 120;
/**
 * How long a block waits for company before it notifies. A lone live view
 * still produces its ordinary per-profile notification a couple of seconds
 * later; a burst of them collapses into one summary instead of one alert per
 * profile. Sweeps don't wait for this at all — they flush when their pass ends.
 */
const NOTIFICATION_BATCH_WINDOW_MS = 2500;
/** Ceiling on the in-memory retry set, so a permanently failing profile can't grow it forever. */
const MAX_RETRY_PROFILES = 200;

type AutoBlockProfile = ProfileDetail & {
	name?: string | null;
	distanceMeters?: number | null;
};

/**
 * One view occurrence to evaluate: who viewed, when (normalised ms, or null
 * when the server never actually said), and their running view count.
 */
type ViewEvent = {
	profileId: string;
	timestamp: number | null;
	viewCount: number | null;
	fallbackName?: string | null;
	fallbackImageHash?: string | null;
};

function isRecoveryEnabled(): boolean {
	return window.localStorage.getItem("fg-view-scanner") !== "false";
}

function getProfileBlockReason(profile: AutoBlockProfile): string | null {
	const age = profile.age;
	const distance = profile.distanceMeters ?? profile.distance;
	const displayName = profile.name || profile.displayName || "";
	const matchedName = getMatchedForbiddenWord(displayName, "name");
	const matchedBio = getMatchedForbiddenWord(profile.aboutMe, "bio");

	if (isOutsideAgeLimits(age)) return age == null ? "No Age Set" : `Age limit (${age})`;
	if (isOutsideDistanceLimits(distance)) return "Distance limit";
	if (hasRightNowStatus(profile)) return "Has active 'Right Now' status";
	if (isForbiddenLookingFor(profile.lookingFor)) return "Forbidden 'Looking For' tag";
	if (hasTwitterAccount(profile)) return "Has an X / Twitter account";
	if (matchedName) return `Name keyword: ${matchedName}`;
	if (matchedBio) return `Bio keyword: ${matchedBio}`;
	return null;
}

/**
 * A row's view time, but only when it is genuinely one.
 *
 * fromStoredView substitutes the cache row's own `updatedAt` whenever the
 * server never reported a view time, flagging it with hasExactTimestamp:false.
 * That value moves every time the recovery store rewrites the row, so feeding
 * it to the auto-blocker would make ordinary cache churn look like a wave of
 * fresh views.
 */
function exactViewTimestamp(item: InterestItem): number | null {
	if (item.hasExactTimestamp === false) return null;
	return normalizeViewTimestamp(item.timestamp);
}

/**
 * Polls the views list on a timer and banks the real profile IDs it finds,
 * so viewers stay openable after the server pushes them behind the paywall's
 * blurred previews. When Interest Views auto-block is enabled, the same sweep
 * applies the profile-based auto-block criteria before a viewer starts a chat.
 *
 * What it deliberately does not do is treat the list itself as a queue of work.
 * The first pass after the feature is switched on records the current list as
 * the baseline (see interestViewAutoBlockState.ts) and blocks nobody; from
 * then on only a genuinely new — or genuinely newer — view is evaluated, and
 * that memory is durable, so restarting the app, saving the block rules or
 * requesting a rescan can never replay history.
 */
export function BackgroundViewScanner() {
	const api = useApiFunctions();
	const { userId } = useAuth();
	const queryClient = useQueryClient();
	// Not a plain setTimeout: hidden, the window held a 30 s wait to a minute.
	const timeoutRef = useRef<UnthrottledTimeout | null>(null);
	const isScanningRef = useRef(false);
	const scanAgainRef = useRef(false);
	const inFlightProfileIdsRef = useRef<Set<string>>(new Set());
	// Profiles whose evaluation threw. The durable state deliberately doesn't
	// record those (a transient failure must stay retryable), but the watermark
	// can move past them in the meantime, so they're kept eligible in memory
	// for the rest of the session.
	const retryProfileIdsRef = useRef<Set<string>>(new Set());
	const knownBlockedIdsRef = useRef<Set<string> | null>(null);
	const blockedIdsRequestRef = useRef<Promise<Set<string>> | null>(null);
	const pendingNotificationsRef = useRef<{ profileName: string; reason: string }[]>([]);
	const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!api) return;

		let isCancelled = false;
		inFlightProfileIdsRef.current.clear();
		retryProfileIdsRef.current.clear();
		knownBlockedIdsRef.current = null;
		blockedIdsRequestRef.current = null;

		const flushBlockNotifications = () => {
			if (notificationTimerRef.current) {
				clearTimeout(notificationTimerRef.current);
				notificationTimerRef.current = null;
			}
			const pending = pendingNotificationsRef.current;
			if (pending.length === 0) return;
			pendingNotificationsRef.current = [];
			// The notification preference is read inside here, never around the
			// block itself — turning Interest alerts off silences the report,
			// not the blocking.
			void notifyAutoBlockBatch(pending, "interest_views");
		};

		const queueBlockNotification = (profileName: string, reason: string) => {
			pendingNotificationsRef.current.push({ profileName, reason });
			// A sweep closes its own batch when it ends, so no timer while one is
			// running — a catch-up pass that takes longer than the window would
			// otherwise fire a partial summary and then a second one for the rest.
			// Otherwise: a fixed delay from the first entry, not a resetting
			// debounce, so a steady trickle can't postpone the report forever.
			if (isScanningRef.current || notificationTimerRef.current) return;
			notificationTimerRef.current = setTimeout(() => {
				notificationTimerRef.current = null;
				flushBlockNotifications();
			}, NOTIFICATION_BATCH_WINDOW_MS);
		};

		const getKnownBlockedIds = async (): Promise<Set<string>> => {
			const cachedByQuery = queryClient.getQueryData<string[]>(["blocked-profile-ids"]);
			if (cachedByQuery) {
				const next = new Set(cachedByQuery.map(String));
				knownBlockedIdsRef.current = next;
				return next;
			}
			if (knownBlockedIdsRef.current) return knownBlockedIdsRef.current;
			if (!blockedIdsRequestRef.current) {
				blockedIdsRequestRef.current = api.getBlockedProfileIds()
					.then((ids) => new Set(ids.map(String)))
					.catch((error) => {
						appLog.warn("[BackgroundViews] Failed to load blocked profiles", error);
						return new Set<string>();
					})
					.then((ids) => {
						knownBlockedIdsRef.current = ids;
						return ids;
					});
			}
			return blockedIdsRequestRef.current;
		};

		const autoBlockViewer = async (event: ViewEvent) => {
			const { profileId } = event;
			if (
				isCancelled
				|| userId == null
				|| !isInterestViewAutoBlockEnabled()
				|| !profileId
				|| profileId.startsWith(PREVIEW_ID_PREFIX)
			) return;

			const account = String(userId);
			if (inFlightProfileIdsRef.current.has(profileId)) return;
			if (
				!retryProfileIdsRef.current.has(profileId)
				&& !isNewViewEvent(account, profileId, event.timestamp, event.viewCount)
			) return;

			// Every settled outcome — blocked, whitelisted, already blocked, or
			// simply not matching — is recorded, so this view is never fetched
			// or evaluated again.
			const settle = () => {
				retryProfileIdsRef.current.delete(profileId);
				markViewProcessed(account, profileId, event.timestamp, event.viewCount);
			};

			if (isProfileAutoblockWhitelisted(profileId)) {
				settle();
				return;
			}

			inFlightProfileIdsRef.current.add(profileId);
			try {
				const [blockedIds, profileDetail] = await Promise.all([
					getKnownBlockedIds(),
					api.getProfileDetail(profileId),
				]);
				if (isCancelled || !isInterestViewAutoBlockEnabled()) return;
				if (blockedIds.has(profileId)) {
					settle();
					return;
				}

				const profile = profileDetail as AutoBlockProfile;
				const displayName = profile.name || profile.displayName || event.fallbackName || `Profile ${profileId}`;
				// The full profile carries a distance even when the views list does not.
				logViewerDistances(
					[{
						profileId,
						timestamp: event.timestamp,
						distanceMeters: profile.distanceMeters ?? profile.distance,
					}],
					"profile",
					PREVIEW_ID_PREFIX,
				);

				// Preserve the existing "Disable Auto-Block for Active Chats" promise
				// for view-triggered blocking too. If the conversation is already local,
				// let the shared helper promote it to the permanent whitelist first.
				const conversation = await findConversationByProfileId(profileId).catch(() => null);
				if (
					conversation
					&& await checkAndAutoWhitelistActiveChat(
						profileId,
						conversation.conversationId,
						displayName,
						profile.profileImageMediaHash ?? event.fallbackImageHash ?? null,
						userId,
					)
				) {
					settle();
					return;
				}

				const reason = getProfileBlockReason(profile);
				if (!reason) {
					settle();
					return;
				}

				await preserveAndAutoBlockProfile({
					profileId,
					userId,
					displayName,
					listMessages: (conversationId) => api.listMessages({ conversationId }),
					getAlbum: (albumId) => api.getAlbum(albumId),
					blockProfile: () => api.blockProfile(profileId),
					stats: { source: "view_scan", reason: { label: reason } },
					// Someone who only ever looked at the profile has no chat to
					// preserve; inventing one would file them under Archived Chats
					// as a conversation that never happened.
					materializeMissingConversation: false,
				});
				blockedIds.add(profileId);
				settle();
				queryClient.setQueryData<string[]>(["blocked-profile-ids"], (old) => {
					if (!old) return [profileId];
					return old.includes(profileId) ? old : [...old, profileId];
				});
				window.dispatchEvent(new Event("fg-refresh-inbox"));
				queueBlockNotification(displayName, reason);
			} catch (error) {
				// Do not settle the view: a later sweep should retry a profile fetch
				// or a preservation attempt that failed transiently.
				if (retryProfileIdsRef.current.size < MAX_RETRY_PROFILES) {
					retryProfileIdsRef.current.add(profileId);
				}
				appLog.warn(`[BackgroundViews] Auto-block check failed for ${profileId}`, error);
			} finally {
				inFlightProfileIdsRef.current.delete(profileId);
			}
		};

		const scanViews = async () => {
			if (isCancelled) return;
			if (isScanningRef.current) {
				scanAgainRef.current = true;
				return;
			}

			isScanningRef.current = true;
			let nextDelaySeconds = readViewScanIntervalSeconds();

			try {
				const recoveryEnabled = isRecoveryEnabled();
				const autoBlockEnabled = isInterestViewAutoBlockEnabled();
				if (recoveryEnabled || autoBlockEnabled) {
					// Snapshot before awaiting — an account switch mid-sweep must
					// not land this account's viewers in the next one's store.
					const account = getActiveInterestViewsAccount();

					const response = await api.getViews();
					if (isCancelled) return;

					const cachedRows = await interestViewsStore.getAll();
					if (isCancelled) return;

					const cachedViews = cachedRows.map(fromStoredView);
					const normalizedViews = normalizeViews(response, cachedViews, (key: string) => key);
					const incomingViews = normalizeViews(response, [], (key: string) => key);
					const realProfiles = normalizedViews.filter(
						(item) => !item.profileId.startsWith(PREVIEW_ID_PREFIX),
					);
					const incomingProfileIds = new Set(
						incomingViews
							.filter((item) => !item.profileId.startsWith(PREVIEW_ID_PREFIX))
							.map((item) => item.profileId),
					);
					const incomingImageHashes = new Set(
						incomingViews.flatMap((item) => item.imageHash ? [item.imageHash] : []),
					);
					const currentViewers = realProfiles.filter(
						(item) => incomingProfileIds.has(item.profileId)
							|| (item.imageHash != null && incomingImageHashes.has(item.imageHash)),
					);

					if (recoveryEnabled) {
						// Only this response's viewers can carry anything new: the rest of
						// realProfiles is the store's own contents read straight back.
						// Handing over the whole merged set cost one IndexedDB read per saved
						// viewer on every sweep — thousands, every 30 seconds, on the thread
						// that scrolls the grid. Same scoping as the auto-block pass below.
						await interestViewsStore.upsertMany(currentViewers.map(toStoredView), account);
						if (isCancelled) return;
						window.localStorage.setItem("fg-view-scanner-last-run", Date.now().toString());
						if (getActiveInterestViewsAccount() === account) {
							markStatsRecording("view_scan");
						}
					}

					if (getActiveInterestViewsAccount() === account) {
						logViewerDistances(currentViewers, "views_list", PREVIEW_ID_PREFIX);
					}

					if (autoBlockEnabled && userId != null) {
						const autoBlockAccount = String(userId);
						if (!hasViewAutoBlockBaseline(autoBlockAccount)) {
							// First pass after the feature was switched on: the list as
							// it stands *is* the baseline. Blocking nothing here is the
							// point — these people viewed us before the rule existed.
							establishViewAutoBlockBaseline(
								autoBlockAccount,
								realProfiles.map(exactViewTimestamp),
							);
							appLog.info(
								`[BackgroundViews] Interest auto-block baseline set from ${realProfiles.length} existing viewer(s)`,
							);
						} else {
							// Only evaluate profiles present in the server's current response, not
							// every historical row in the recovery store (which may hold 10k).
							// Hash matching keeps recovered paywall previews eligible too.
							// isNewViewEvent then drops everything already settled, so a steady
							// list costs no profile fetches at all.
							//
							// Classified in one pass up front, before any of it settles:
							// every settled view pushes the watermark forward, and
							// normalizeViews hands the list back newest-first, so evaluating
							// as we go would let the newest viewer of a catch-up batch close
							// the door on every older one behind it — they'd have no ledger
							// entry and would sit under the watermark forever.
							const pendingViews = currentViewers
								.map((item) => ({ item, timestamp: exactViewTimestamp(item) }))
								.filter(({ item, timestamp }) =>
									retryProfileIdsRef.current.has(item.profileId)
									|| isNewViewEvent(
										autoBlockAccount,
										item.profileId,
										timestamp,
										item.viewCount,
									),
								)
								// Oldest first, so the watermark only ever advances past views
								// this pass actually handled: a sweep cut short by an account
								// switch or the toggle flipping leaves the rest still eligible.
								.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

							// Sequential fetches avoid turning the visible list into a burst.
							for (const { item, timestamp } of pendingViews) {
								if (isCancelled || !isInterestViewAutoBlockEnabled()) break;
								await autoBlockViewer({
									profileId: item.profileId,
									timestamp,
									viewCount: item.viewCount,
									fallbackName: item.displayName,
									fallbackImageHash: item.imageHash,
								});
							}
						}
					}
				}
			} catch (error) {
				// Usually a rate limit or a dropped connection. Back off rather
				// than retrying on the normal (possibly 10s) cadence.
				appLog.error("[BackgroundViews] Sweep failed", error);
				nextDelaySeconds = Math.max(nextDelaySeconds, ERROR_BACKOFF_SECONDS);
			} finally {
				// One summary for the whole pass, however many it blocked — before
				// the scanning flag drops, so a live view arriving right after this
				// can never be folded into a batch that is already closing.
				flushBlockNotifications();
				isScanningRef.current = false;
				if (!isCancelled) {
					timeoutRef.current?.cancel();
					if (scanAgainRef.current) {
						scanAgainRef.current = false;
						timeoutRef.current = setUnthrottledTimeout(() => void scanViews(), 0);
					} else {
						timeoutRef.current = setUnthrottledTimeout(() => void scanViews(), nextDelaySeconds * 1000);
					}
				}
			}
		};

		const handleLiveView = (event: Event) => {
			const detail = (event as CustomEvent<ViewReceivedDetail>).detail;
			if (!detail || !isInterestViewAutoBlockEnabled() || userId == null) return;
			const timestamp = normalizeViewTimestamp(detail.timestamp) ?? Date.now();
			// A pushed view is one that just happened. If no sweep has managed to
			// baseline yet, seed one from it — otherwise the next sweep would find
			// no baseline and take the whole list as new.
			seedViewAutoBlockBaselineFromLiveView(String(userId), timestamp);
			void autoBlockViewer({
				profileId: detail.profileId,
				timestamp,
				viewCount: detail.viewedCount > 0 ? detail.viewedCount : null,
				fallbackImageHash: detail.imageHash,
			});
		};

		const handleRequestedScan = () => {
			// Deliberately does not touch the durable view history: this fires
			// whenever the block rules are saved or the toggle flips, and clearing
			// it here is what used to replay the entire Interest list.
			timeoutRef.current?.cancel();
			void scanViews();
		};

		window.addEventListener(VIEW_RECEIVED_EVENT, handleLiveView);
		window.addEventListener(INTEREST_VIEW_SCAN_EVENT, handleRequestedScan);
		void scanViews();

		return () => {
			isCancelled = true;
			window.removeEventListener(VIEW_RECEIVED_EVENT, handleLiveView);
			window.removeEventListener(INTEREST_VIEW_SCAN_EVENT, handleRequestedScan);
			timeoutRef.current?.cancel();
			// Anything blocked moments before unmount still gets reported.
			flushBlockNotifications();
		};
	}, [api, queryClient, userId]);

	return null;
}
