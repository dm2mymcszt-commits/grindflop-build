/**
 * ChatRealtimeBridge — runs the chat WebSocket app-wide while the user is
 * authenticated, so incoming messages always trigger an in-app toast
 * regardless of the current route.
 *
 * Architecture:
 * - Owns the singleton ChatRealtimeManager (previously owned by ChatPage).
 * - Re-broadcasts envelopes and status changes via window CustomEvents
 *   (`fg:chat-realtime-event`, `fg:chat-realtime-status`) so ChatPage can
 *   keep its live UI in sync without holding its own connection.
 * - Persists incoming messages to chatLog and shows a toast — suppressed
 *   when the user is already viewing the conversation in the foreground or
 *   when the message was sent by the current user.
 * - Foreground system notifications: since this WebSocket delivers events
 *   instantly while FCM always carries relay delay, incoming messages/taps
 *   trigger an OS notification right here (only while the document is
 *   visible — backgrounded delivery stays on FCM). Desktop/iOS go through
 *   `notifyLocal()`; Android goes through the native `FreeGrindBridge`, whose
 *   `NotificationPoster` dedupes against the later FCM push for the same
 *   message/tap so it never shows twice.
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { useAuth } from "../contexts/useAuth";
import { useApi } from "../hooks/useApi";
import { ChatRealtimeManager, setActiveRealtimeManager } from "../services/chatRealtime";
import { TauriWebSocket, isTauriRuntime } from "../services/tauriWebSocket";
import * as chatLog from "../services/chatLog";
import {
	incrementUnreadCountForProfile,
	clearUnreadCountForProfile,
} from "../services/chatContactIndex";
import {
	toggleArchiveOnConversationDelete,
	reconcileArchivedConversationForProfile,
	reconcileBlockStateWithBlockedList,
	restoreDroppedBlock,
	deriveOtherProfileIdFromConversationId,
	CHAT_SYSTEM_MESSAGE_EVENT,
	CHAT_ARCHIVE_STATE_EVENT,
	SELF_BLOCK_EVENT,
	type ChatArchiveStateChangeDetail,
	type SelfBlockDetail,
} from "../services/conversationArchive";
import * as chatDb from "../services/chatDb";
import { messageSchema, type ConversationEntry, type Message } from "../types/messages";
import type { RealtimeEnvelope, RealtimeStatus } from "../types/chat-realtime";
import { appLog } from "../utils/logger";
import {
	getMediaCaptureTarget,
	getOtherParticipant,
	getMessagePreviewLabel,
} from "../pages/app/chat/chatUtils";
import { fetchAndStoreMedia } from "../services/mediaStore";
import { captureAlbumsForMessages } from "../services/albumStore";
import { captureReplyPreviewsForMessages } from "../services/replyMediaStore";
import { getConversation, getDisplayName } from "../services/conversationDirectory";
import { runAutomationRulesForSender } from "../utils/automationRules";
import { 
	getMatchedForbiddenWord,
	getMatchedFirstMessageWord, 
	notifyAutoBlock, 
	isOutsideAgeLimits, 
	isOutsideDistanceLimits, 
	hasRightNowStatus, 
	hasTwitterAccount,
	isForbiddenLookingFor 
} from "../utils/autoblock";
import { isProfileAutoblockWhitelisted, checkAndAutoWhitelistActiveChat } from "../utils/privacy";
import { useApiFunctions } from "../hooks/useApiFunctions";
import { useBlockedProfileIds } from "../hooks/queries/useProfileQueries";
import { isReadReceiptsHidden } from "../utils/privacy";
import { classifyProfileAccess } from "../utils/profileAccessStatus";
import {
	traceMessages,
	traceNotification,
	traceSocketEvent,
	traceSocketStatus,
} from "../utils/backgroundTrace";
import { recordRealtimeStatus } from "../services/connectionLog";
import {
	isChatNotificationsEnabled,
	isForegroundNotificationsEnabled,
	isTapNotificationsEnabled,
} from "../utils/notificationSettings";
import { clearChatNotifications, notifyLocal } from "../services/localNotify";
import {
	followWindowFocus,
	isAppForeground,
	onReturnToForeground,
} from "../services/appForeground";
import { getOpenConversationId } from "../services/openConversation";
import {
	preserveAndAutoBlockConversation,
	withPreservingBlock,
} from "../services/autoBlockConversation";
import { logBlockEvent, type StatsBlockReason } from "../services/statsLog";
import { isExplicitBlockEnabled, isExplicitProfileBlockEnabled, scoresOf } from "../services/contentCheck";
import {
	checkLiveMessageMedia,
	decideLiveExplicitBlock,
	explicitReasonFor,
	explicitStatsReason,
	releaseLiveMessage,
	startExplicitMediaGuard,
} from "../services/explicitMediaGuard";
import { findExplicitProfilePhoto } from "../services/profilePhotoCheck";
import { logDetectorDecision } from "../services/detectorLog";
import { EXPLICIT_PROFILE_PHOTO_REASON, explicitNotice } from "../utils/explicitContentRules";
import { LINK_BOT_REASON, isLinkBotRuleEnabled, isLinkOnlyMessage } from "../utils/linkBotMessage";
import { isLinkBotConversation, removeChatIfLinkBot, sweepArchivedLinkBots } from "../services/linkBots";
import { getCachedProfileDetail } from "../pages/app/gridpage/cache";

let cachedIsAndroid: boolean | null = null;

/**
 * One block by someone reaches counter-block twice within milliseconds: from
 * the handler that archived the chat and from the "they blocked you" note it
 * left. Both used to run, so the person was looked up, blocked and written to
 * the block log twice. The first one in claims the profile for a minute.
 */
const COUNTER_BLOCK_CLAIM_MS = 60_000;
const counterBlockClaims = new Map<string, number>();

/**
 * Name and photo of people who wrote, as their profile gave them. A first
 * message comes from a conversation the app does not have yet, so without
 * this its notification had neither ("Someone", no photo).
 */
type NotificationSender = { name: string; photoHash: string | null };
const NOTIFICATION_SENDERS_KEPT = 200;
const notificationSenders = new Map<string, NotificationSender>();

function rememberNotificationSender(
	profileId: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	profile: any,
): NotificationSender | null {
	if (!profile) return null;
	const name = String(profile.displayName || profile.name || "").trim();
	const photoHash = typeof profile.profileImageMediaHash === "string" ? profile.profileImageMediaHash : null;
	// The "4"/"3" stub of a blocked or deleted profile says nothing about them.
	if (!photoHash && (name === "" || name === "3" || name === "4")) return null;
	const sender = { name, photoHash };
	notificationSenders.delete(profileId);
	notificationSenders.set(profileId, sender);
	if (notificationSenders.size > NOTIFICATION_SENDERS_KEPT) {
		const oldest = notificationSenders.keys().next().value;
		if (oldest !== undefined) notificationSenders.delete(oldest);
	}
	return sender;
}

/** The reason given when a block is put back rather than made (restoreDroppedBlock). */
const DROPPED_BLOCK_NOTICE = "Grindr had dropped your block. Blocked again.";

function conversationEntryFromRealtimeMessage(
	message: Message,
	profileId: string,
	displayName?: string | null,
	primaryMediaHash?: string | null,
): ConversationEntry {
	const body = message.body as Record<string, unknown> | null | undefined;
	return {
		type: "Conversation",
		data: {
			conversationId: message.conversationId,
			name: displayName?.trim() ?? "",
			participants: [
				{ profileId: Number(profileId), ...(primaryMediaHash ? { primaryMediaHash } : {}) },
			],
			lastActivityTimestamp: message.timestamp,
			unreadCount: 1,
			muted: false,
			pinned: false,
			favorite: false,
			preview: {
				conversationId: { value: message.conversationId },
				messageId: message.messageId,
				senderId: message.senderId,
				type: message.type,
				chat1Type: message.chat1Type,
				text: typeof body?.text === "string" ? body.text : null,
			},
		},
	};
}

function isAndroidRuntime(): boolean {
	if (cachedIsAndroid != null) return cachedIsAndroid;
	if (!isTauriRuntime()) {
		cachedIsAndroid = false;
		return false;
	}
	try {
		cachedIsAndroid = platform() === "android";
	} catch {
		cachedIsAndroid = false;
	}
	return cachedIsAndroid;
}

export const CHAT_REALTIME_EVENT = "fg:chat-realtime-event";
export const CHAT_REALTIME_STATUS = "fg:chat-realtime-status";
export const TAP_RECEIVED_EVENT = "fg:tap-received";
export const VIEW_RECEIVED_EVENT = "fg:view-received";
export const TYPING_STATUS_EVENT = "fg:typing-status";
// Re-exported so existing importers (e.g. ChatPage.tsx) don't need to change
// where they pull this from — conversationArchive.ts is now the source of
// truth since it also dispatches this event from applySelfBlockAction.
export { CHAT_SYSTEM_MESSAGE_EVENT };

export type TypingStatusDetail = {
	conversationId: string;
	profileId: string;
	status: "Typing" | "Cleared" | "Sent";
};

// Global cache to allow late-mounting components (like ChatPage) to see the
// current connection status immediately.
let lastKnownStatus: RealtimeStatus = "idle";
export function getChatRealtimeStatus(): RealtimeStatus {
	return lastKnownStatus;
}

function dispatchStatus(status: RealtimeStatus) {
	// appLog.debug("[chat-ws:bridge] dispatchStatus", { status });
	lastKnownStatus = status;
	window.dispatchEvent(
		new CustomEvent<RealtimeStatus>(CHAT_REALTIME_STATUS, {
			detail: status,
		}),
	);
}

export type TapReceivedDetail = {
	profileId: string;
	displayName: string;
	imageHash: string | null;
	timestamp: number;
	tapType: number | null;
	isMutual: boolean;
};

function parseTapPayload(payload: unknown): TapReceivedDetail | null {
	if (!payload || typeof payload !== "object") return null;
	const r = payload as Record<string, unknown>;
	const sender = r.senderId;
	const profileId =
		typeof sender === "string"
			? sender
			: typeof sender === "number"
				? String(sender)
				: null;
	if (!profileId) return null;
	const ts = r.timestamp;
	const timestamp =
		typeof ts === "number"
			? ts
			: typeof ts === "string" && ts !== ""
				? Number(ts)
				: Date.now();
	const display =
		typeof r.senderDisplayName === "string" && r.senderDisplayName.trim()
			? r.senderDisplayName.trim()
			: "";
	const image =
		typeof r.senderProfileImageHash === "string" && r.senderProfileImageHash
			? r.senderProfileImageHash
			: null;
	const tapType =
		typeof r.tapType === "number"
			? r.tapType
			: typeof r.tapType === "string" && r.tapType !== ""
				? Number(r.tapType)
				: null;
	return {
		profileId,
		displayName: display,
		imageHash: image,
		timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
		tapType: Number.isFinite(tapType as number) ? (tapType as number) : null,
		isMutual: r.isMutual === true,
	};
}

export type ViewReceivedDetail = {
	profileId: string;
	imageHash: string | null;
	timestamp: number;
	viewedCount: number;
};

function parseViewPayload(payload: unknown): ViewReceivedDetail | null {
	if (!payload || typeof payload !== "object") return null;
	const r = payload as Record<string, unknown>;
	const mostRecent = r.mostRecent as Record<string, unknown> | undefined;
	if (!mostRecent) return null;

	return {
		profileId: String(mostRecent.profileId),
		imageHash: (mostRecent.photoHash as string) || null,
		timestamp: Number(mostRecent.timestamp) || Date.now(),
		viewedCount: Number(r.viewedCount) || 0,
	};
}

function extractMessages(envelope: RealtimeEnvelope): Message[] {
	const candidates: Message[] = [];

	const direct = messageSchema.safeParse(envelope.payload);
	if (direct.success) {
		candidates.push(direct.data);
	}

	for (const payload of [envelope.payload, envelope.data, envelope]) {
		if (!payload || typeof payload !== "object") continue;
		const record = payload as Record<string, unknown>;
		if (record.message) {
			const parsed = messageSchema.safeParse(record.message);
			if (parsed.success) candidates.push(parsed.data);
		}
		if (Array.isArray(record.messages)) {
			for (const candidate of record.messages) {
				const parsed = messageSchema.safeParse(candidate);
				if (parsed.success) candidates.push(parsed.data);
			}
		}
	}

	const seen = new Set<string>();
	return candidates.filter((m) => {
		if (seen.has(m.messageId)) return false;
		seen.add(m.messageId);
		return true;
	});
}

function extractTextFromMessage(m: Message): string {
	if (typeof m.body === "string") return m.body;
	if (m.body && typeof m.body === "object") {
		const b = m.body as Record<string, unknown>;
		if (typeof b.text === "string") return b.text;
		if (typeof b.content === "string") return b.content;
		if (typeof b.body === "string") return b.body;
	}
	return "";
}

export function ChatRealtimeBridge() {
	const { userId, settingsReady } = useAuth();
	const { callMethod } = useApi();
    const apiFunctions = useApiFunctions();
	const queryClient = useQueryClient();
	const location = useLocation();
	const { t } = useTranslation();

	const callMethodRef = useRef(callMethod);
	useEffect(() => {
		callMethodRef.current = callMethod;
	}, [callMethod]);

	const tRef = useRef(t);
	useEffect(() => {
		tRef.current = t;
	}, [t]);

	const pathRef = useRef(location.pathname);
	useEffect(() => {
		pathRef.current = location.pathname;
	}, [location.pathname]);

	// A desktop window that is minimised or covered is not being looked at,
	// whatever its page reports, so its focus is followed. And coming back to
	// a conversation that was open all along is reading it: the notifications
	// it raised in the meantime have done their job.
	useEffect(() => {
		followWindowFocus();
		return onReturnToForeground(() => {
			void clearChatNotifications(getOpenConversationId());
		});
	}, []);

	const userIdRef = useRef<number | null>(userId);
	useEffect(() => {
		userIdRef.current = userId;
	}, [userId]);

	// Link bots blocked before their chats were deleted automatically (or
	// while the app was closed) are still in the archive: clear them once per
	// session, after the start-up work has settled.
	useEffect(() => {
		if (!settingsReady || userId == null) return;
		const timer = setTimeout(() => {
			// No toast: link bots are removed without a word, like the new ones.
			void sweepArchivedLinkBots(userId);
		}, 20000);
		return () => clearTimeout(timer);
	}, [settingsReady, userId]);

	// Grindr is moving taps from tap.v1.tap_sent to tap.v2.tap_sent and both
	// can fire for one real tap while the rollout is on, so a sender seen
	// twice inside ten seconds is counted once. Without this the second
	// event would notify, unarchive and run the tap automation rules again.
	const recentTapSendersRef = useRef<Map<string, number>>(new Map());
	const shouldProcessIncomingTap = (profileId: string): boolean => {
		const now = Date.now();
		const seen = recentTapSendersRef.current;
		for (const [key, seenAt] of seen) {
			if (now - seenAt > 10_000) {
				seen.delete(key);
			}
		}
		if (seen.has(profileId)) {
			return false;
		}
		seen.set(profileId, now);
		return true;
	};

	// A profile still existing (isProfileFound) doesn't mean a conversation
	// archived by *our own* block should reopen — we chose that, and merely
	// receiving a stray/in-flight WS event for them (e.g. a read receipt
	// that was already in transit when the block landed) shouldn't undo it.
	// Only reconcile activity for profiles we haven't blocked ourselves.
	const { data: blockedProfileIdsData } = useBlockedProfileIds(userId != null);
	const blockedProfileIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		blockedProfileIdsRef.current = new Set(blockedProfileIdsData ?? []);
	}, [blockedProfileIdsData]);

	// Catches a block or unblock made on another device while this device's
	// app wasn't running at all, or otherwise missed here (so no WS event or
	// 403 ever had a chance to tell it) — see reconcileBlockStateWithBlockedList.
	// Runs whenever the blocked-profile-ids data actually changes (a new
	// array reference only happens on genuine query success), typically once
	// at app start and again on any later refetch. Gated on settingsReady,
	// not just userId, so this can't run against the previous account's
	// chatDb file (or the pre-login legacy one) while setActiveChatDbUser is
	// still switching — it would read/write the wrong conversations table.
	useEffect(() => {
		if (userId == null || !settingsReady || !blockedProfileIdsData) {
			return;
		}
		void reconcileBlockStateWithBlockedList(blockedProfileIdsData);
	}, [userId, settingsReady, blockedProfileIdsData]);

	// A conversation getting unarchived anywhere (this component's own WS
	// handling, ChatPage's foreground reappearance check, or inboxSync's
	// background walk) can mean a block cleared on another device — refresh
	// the blocked-profile-ids cache so the chat header's unblock button
	// (isBlockedBySelf in ChatPage) doesn't keep showing stale state that
	// nothing else would otherwise think to refetch for up to its 10-minute
	// staleTime.
	useEffect(() => {
		const handleArchiveStateChange = (event: Event) => {
			const detail = (event as CustomEvent<ChatArchiveStateChangeDetail>).detail;
			if (detail?.archived === false) {
				void queryClient.invalidateQueries({ queryKey: ["blocked-profile-ids"] });
			}
		};
		window.addEventListener(CHAT_ARCHIVE_STATE_EVENT, handleArchiveStateChange);
		return () => {
			window.removeEventListener(CHAT_ARCHIVE_STATE_EVENT, handleArchiveStateChange);
		};
	}, [queryClient]);

	// An auto-block or counter-block goes straight to the block endpoint, so
	// unlike the manual block mutation nothing adds it to the cached blocked
	// list — and for up to its 10-minute staleTime the Interest list showed the
	// person without a blocked badge and still opened their (now empty) profile.
	useEffect(() => {
		const handleSelfBlock = (event: Event) => {
			const profileId = (event as CustomEvent<SelfBlockDetail>).detail?.profileId;
			if (!profileId) return;
			// A list that hasn't loaded yet is left alone rather than seeded with
			// this one id: the fetch still to come already includes the block.
			queryClient.setQueryData<string[]>(["blocked-profile-ids"], (old) => {
				if (!old || old.includes(profileId)) return old;
				return [...old, profileId];
			});
		};
		window.addEventListener(SELF_BLOCK_EVENT, handleSelfBlock);
		return () => {
			window.removeEventListener(SELF_BLOCK_EVENT, handleSelfBlock);
		};
	}, [queryClient]);

	// Someone else blocking or unblocking us is not worth a notification —
	// the user asked for those to go. This still listens for the same
	// "SystemBlocked" message, because that is what tells counter-block there
	// is somebody to block back.
	useEffect(() => {
		const handleSystemMessage = async (event: Event) => {
			const messages = (event as CustomEvent<Message[]>).detail;
			if (!Array.isArray(messages)) return;
			for (const message of messages) {
				if (message.type !== "SystemBlocked" && message.type !== "SystemUnblocked") {
					continue;
				}
				if (message.type === "SystemBlocked") {
					const counterBlockEnabled = window.localStorage.getItem("fg-autoblock-counter-block") === "true";
					if (counterBlockEnabled && message.conversationId) {
						const conv = getConversation(message.conversationId);
						const otherP = conv ? getOtherParticipant(conv, userIdRef.current) : null;
						let pidStr: string | null = otherP?.profileId ? String(otherP.profileId) : null;

						if (!pidStr) {
							pidStr = deriveOtherProfileIdFromConversationId(message.conversationId, userIdRef.current);
						}

						if (!pidStr) {
							const dbConv = await chatDb.getConversation(message.conversationId).catch(() => null);
							pidStr = dbConv?.otherProfileId ? String(dbConv.otherProfileId) : null;
						}

						if (pidStr) {
							window.dispatchEvent(
								new CustomEvent("fg:trigger-counter-block", {
									detail: { profileId: pidStr, conversationId: message.conversationId },
								})
							);
						}
					}
				}
			}
		};
		window.addEventListener(CHAT_SYSTEM_MESSAGE_EVENT, handleSystemMessage as EventListener);
		return () => {
			window.removeEventListener(CHAT_SYSTEM_MESSAGE_EVENT, handleSystemMessage as EventListener);
		};
	}, [queryClient]);

	useEffect(() => {
		const handleCounterBlockEvent = async (event: Event) => {
			const detail = (event as CustomEvent<{ profileId: string; conversationId?: string }>).detail;
			if (!detail?.profileId) return;
			const pidStr = String(detail.profileId);
			if (blockedProfileIdsRef.current.has(pidStr)) return;
			const claimedAt = counterBlockClaims.get(pidStr);
			if (claimedAt != null && Date.now() - claimedAt < COUNTER_BLOCK_CLAIM_MS) return;
			counterBlockClaims.set(pidStr, Date.now());

			// Only block back someone who has actually blocked this account. What
			// dispatches this can be acting on a profile lookup that failed — a
			// deleted or banned account, or a dropped request — and treating that
			// as a block is how "Unknown" profiles were being blocked. A fresh
			// lookup has to say "blocked"; anything else leaves them alone.
			let status: "accessible" | "not_found" | "blocked";
			try {
				status = classifyProfileAccess(await apiFunctions.getProfileDetail(pidStr));
			} catch (error) {
				appLog.warn(`[CounterBlock] Could not confirm ${pidStr} blocked us; not blocking back`, error);
				// Nothing was decided: a later signal may try again.
				counterBlockClaims.delete(pidStr);
				return;
			}
			if (status !== "blocked") {
				appLog.info(`[CounterBlock] ${pidStr} is ${status}, not blocked; not blocking back`);
				counterBlockClaims.delete(pidStr);
				return;
			}

			const name = detail.conversationId
				? (getDisplayName(detail.conversationId, userIdRef.current) ?? `Profile ${pidStr}`)
				: `Profile ${pidStr}`;

			try {
				await apiFunctions.blockProfile(pidStr);
				logBlockEvent({
					eventType: "block",
					profileId: pidStr,
					method: "auto",
					source: "counter_block",
					reason: { kind: "counter_block", label: "They blocked you" },
				});
				toast.success(
					tRef.current("chat.counter_blocked", { name }),
					{ id: `counter-block-${pidStr}` }
				);
				void queryClient.invalidateQueries({ queryKey: ["blocked-profile-ids"] });
			} catch (err) {
				console.warn(`[CounterBlock] Failed to block ${pidStr}:`, err);
				counterBlockClaims.delete(pidStr);
			}
		};

		window.addEventListener("fg:trigger-counter-block", handleCounterBlockEvent as EventListener);
		return () => {
			window.removeEventListener("fg:trigger-counter-block", handleCounterBlockEvent as EventListener);
		};
	}, [apiFunctions, queryClient]);

	// Blocks whoever sent an explicit photo that was found outside the live
	// message path below: a thread being opened, the scanner catching up.
	// Waits for settingsReady so it cannot read the previous account's chatDb.
	useEffect(() => {
		if (userId == null || !settingsReady) {
			return;
		}
		return startExplicitMediaGuard(apiFunctions, userId);
	}, [apiFunctions, userId, settingsReady]);

	// Boot the realtime manager whenever the user is authenticated.
	// getToken is called fresh on every (re)connect so an expired token
	// never blocks reconnection.
	useEffect(() => {
		if (!userId) {
			if (lastKnownStatus !== "idle") {
				dispatchStatus("idle");
			}
			return;
		}

		/*
		appLog.debug("[chat-ws:bridge] starting manager", {
			transport: isTauriRuntime() ? "tauri" : "browser",
		});
		*/

		// Shared by both the conversation.delete handling below and the
		// "any activity from an archived profile" recheck: deleted/banned
		// profiles are simply missing from this response instead of
		// erroring, same as the stale-share cleanup on the albums page.
		const isProfileFound = async (profileId: string): Promise<boolean> => {
			try {
				const raw = await apiFunctions.getProfilesByIds([profileId]);
				const profiles =
					raw && typeof raw === "object" && Array.isArray((raw as { profiles?: unknown }).profiles)
						? (raw as { profiles: unknown[] }).profiles
						: [];
				return profiles.some(
					(p) =>
						p &&
						typeof p === "object" &&
						String((p as { profileId?: unknown }).profileId) === profileId,
				);
			} catch {
				return true;
			}
		};

		// A fresh chat.v1.conversation.delete that isn't self-attributed could
		// mean either "they blocked us" or "their profile was deleted/banned" —
		// isProfileFound (a bulk profile lookup) can't reliably tell those apart.
		// classifyProfileAccess reads GET /v7/profiles/:id's stub-response quirk
		// (see its own doc comment) — an immediate and reliable signal (confirmed
		// live right after a block, no propagation delay), unlike attempting to
		// load the conversation's messages, which can lag behind the block being
		// enacted server-side.
		const checkConversationAccessible = async (
			profileId: string,
		): Promise<"accessible" | "not_found" | "blocked"> => {
			try {
				const profile = await apiFunctions.getProfileDetail(profileId);
				return classifyProfileAccess(profile);
			} catch {
				return "accessible";
			}
		};

		// Fallback for toggleArchiveOnConversationDelete's self/other
		// disambiguation: the local self-action marker only exists when the
		// block came from this device, so blocking the same profile from
		// another device would otherwise show as "You were blocked" here.
		// Fetches fresh (bypassing the cached blockedProfileIdsRef/query
		// staleTime) rather than risking a stale answer — this only runs on an
		// actual chat.v1.conversation.delete event, rare enough that a live
		// network round trip here is cheap, and correctness matters more than
		// saving one request for exactly this decision.
		const isBlockedByMe = async (profileId: string): Promise<boolean> => {
			try {
				const blockedIds = await apiFunctions.getBlockedProfileIds();
				// Seed the "blocked-profile-ids" query cache with this fresh
				// result — it's what ChatPage's unblock button (and every other
				// consumer) reads, and its 10-minute staleTime would otherwise
				// leave a block made on another device invisible here until the
				// next unrelated refetch, even after reopening the inbox.
				queryClient.setQueryData<string[]>(["blocked-profile-ids"], blockedIds);
				return blockedIds.includes(profileId);
			} catch {
				return false;
			}
		};

		// Any incoming activity from a profile whose conversation is
		// currently archived (typing, a read receipt, a tap, a view, a
		// message) is a live signal they might be reachable again — recheck
		// and pull it out of archive instead of waiting for the next
		// chat.v1.conversation.delete, inbox reload, or profile-page visit.
		const maybeUnarchiveOnActivity = (profileId: string | number | null | undefined) => {
			if (profileId == null) return;
			const id = String(profileId);
			if (blockedProfileIdsRef.current.has(id)) return;
			void reconcileArchivedConversationForProfile(id, isProfileFound);
		};

		// Foreground-only: fires the OS notification straight from the
		// WebSocket event so it shows up instantly, before FCM's delayed
		// push would otherwise be the only source. Android routes through
		// the native bridge (which dedupes against that later FCM push);
		// desktop/iOS have no competing push channel, so they go straight
		// to notifyLocal().
		// Who wrote, for a notification: the conversation when the app has it,
		// otherwise their profile, read at most once and briefly waited on.
		const findNotificationSender = async (m: Message): Promise<NotificationSender> => {
			const conv = getConversation(m.conversationId);
			const other = conv ? getOtherParticipant(conv, userIdRef.current) : null;
			const fromConversation = {
				name: conv?.data.name?.trim() ?? "",
				photoHash: other?.primaryMediaHash ?? null,
			};
			if (fromConversation.name && fromConversation.photoHash) return fromConversation;
			const profileId = String(m.senderId);
			let fromProfile =
				notificationSenders.get(profileId) ??
				rememberNotificationSender(profileId, getCachedProfileDetail(profileId));
			if (!fromProfile) {
				const profile = await Promise.race([
					apiFunctions.getProfileDetail(profileId).catch(() => null),
					new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
				]);
				fromProfile = rememberNotificationSender(profileId, profile);
			}
			return {
				name: fromConversation.name || fromProfile?.name || "",
				photoHash: fromConversation.photoHash ?? fromProfile?.photoHash ?? null,
			};
		};

		const triggerIncomingMessageNotification = async (m: Message) => {
			if (!isChatNotificationsEnabled()) {
				traceNotification("chat notifications off");
				return;
			}
			if (isAppForeground() && !isForegroundNotificationsEnabled()) return;

			const sender = await findNotificationSender(m);
			const senderName = sender.name || tRef.current("chat.notifications.someone");
			const bodyText = getMessagePreviewLabel(m, tRef.current);

			if (isAndroidRuntime()) {
				const payload = {
					event: "received",
					source: "realtime",
					receivedAt: Date.now(),
					senderName,
					bodyText,
					isTap: false,
					action: `chat:${m.conversationId}`,
					conversationId: m.conversationId,
					senderId: String(m.senderId),
					messageType: m.type,
					rawData: {
						senderProfileImageMediaHash: sender.photoHash,
					},
				};
				try {
					window.FreeGrindBridge?.postLocalNotification?.(JSON.stringify(payload));
				} catch (error) {
					appLog.warn("[chat-ws:bridge] postLocalNotification failed", error);
				}
				return;
			}

			void notifyLocal({
				title: senderName,
				body: bodyText,
				group: m.conversationId,
				sender: {
					id: String(m.senderId),
					name: senderName,
					photoHash: sender.photoHash,
					conversationId: m.conversationId,
				},
			});
		};

		const triggerTapNotification = (tap: TapReceivedDetail) => {
			if (!isTapNotificationsEnabled()) return;
			if (isAppForeground() && !isForegroundNotificationsEnabled()) return;

			const senderName = tap.displayName || tRef.current("chat.notifications.someone");
			const bodyText = tap.isMutual
				? tRef.current("chat.notifications.tapped_you_back")
				: tRef.current("chat.notifications.tapped_you");

			if (isAndroidRuntime()) {
				const payload = {
					event: "received",
					source: "realtime",
					receivedAt: Date.now(),
					senderName,
					bodyText,
					isTap: true,
					action: "taps",
					conversationId: null,
					senderId: tap.profileId,
					messageType: null,
					rawData: {
						senderProfileId: tap.profileId,
						senderProfileImageMediaHash: tap.imageHash ?? null,
					},
				};
				try {
					window.FreeGrindBridge?.postLocalNotification?.(JSON.stringify(payload));
				} catch (error) {
					appLog.warn("[chat-ws:bridge] postLocalNotification failed (tap)", error);
				}
				return;
			}

			const onTapsRoute =
				pathRef.current === "/interest" || pathRef.current.startsWith("/interest/");
			if (onTapsRoute) return;
			void notifyLocal({
				title: senderName,
				body: bodyText,
				group: "taps",
				sender: {
					id: tap.profileId,
					name: senderName,
					photoHash: tap.imageHash ?? null,
					conversationId: `tap:${tap.profileId}`,
				},
			});
		};

		const manager = new ChatRealtimeManager({
			url: "wss://grindr.mobi/v1/ws",
			getToken: async () => {
				try {
					const tok = await callMethodRef.current("websocket_token");
					return typeof tok === "string" ? tok : null;
				} catch {
					appLog.warn("[chat-ws:bridge] token fetch failed");
					return null;
				}
			},
			onStatusChange: (status, reason) => {
				traceSocketStatus(status);
				dispatchStatus(status);
				recordRealtimeStatus(status, reason);
			},
			onEvent: async (envelope) => {
				traceSocketEvent();
				appLog.debug(`[chat-ws:bridge] onEvent type=${envelope.type} payload=${JSON.stringify(envelope.payload)}`);

				// Dispatch event AFTER potential DB updates if we want consistency,
				// or BEFORE if we want speed. Let's do DB updates first for critical stuff.

				// tap.v1.tap_sent / tap.v2.tap_sent — fire on both sender +
				// recipient. We only surface incoming taps (where we are the
				// recipient). v2 carries isMutual in its payload, v1 does not.
				if (envelope.type === "tap.v1.tap_sent" || envelope.type === "tap.v2.tap_sent") {
					const tap = parseTapPayload(envelope.payload);
					const currentUserId = userIdRef.current;
					if (
						tap &&
						currentUserId != null &&
						Number(tap.profileId) !== Number(currentUserId) &&
						shouldProcessIncomingTap(tap.profileId)
					) {
						appLog.debug(`[chat-ws:bridge] Incoming tap received from profileId: ${tap.profileId}`);
						window.dispatchEvent(
							new CustomEvent<TapReceivedDetail>(TAP_RECEIVED_EVENT, {
								detail: tap,
							}),
						);
						triggerTapNotification(tap);
						maybeUnarchiveOnActivity(tap.profileId);
						runAutomationRulesForSender(
							tap.profileId,
							"tap_received",
							withPreservingBlock(apiFunctions, userIdRef.current),
						).catch(() => {});
					}
				}

				if (envelope.type === "viewed_me.v1.new_view_received") {
					const view = parseViewPayload(envelope.payload);
					if (view) {
						appLog.debug(`[chat-ws:bridge] Incoming view received. Total views: ${view.viewedCount}`);
						window.dispatchEvent(
							new CustomEvent<ViewReceivedDetail>(VIEW_RECEIVED_EVENT, {
								detail: view,
							}),
						);
						maybeUnarchiveOnActivity(view.profileId);
					}
				}

				if (envelope.type === "chat.v1.typing_status") {
					const record = envelope.payload as Record<string, unknown> | undefined;
					if (record) {
						const conversationId = record.conversationId as string | undefined;
						const profileId = record.profileId as string | undefined;
						const status = record.status as string | undefined;
						if (conversationId && profileId && status) {
							window.dispatchEvent(
								new CustomEvent<TypingStatusDetail>(TYPING_STATUS_EVENT, {
									detail: { conversationId, profileId, status: status as TypingStatusDetail["status"] },
								}),
							);
							if (userIdRef.current != null && Number(profileId) !== Number(userIdRef.current)) {
								maybeUnarchiveOnActivity(profileId);
							}
						}
					}
				}

				if (envelope.type === "chat.v1.conversation_read") {
					const record = envelope.payload as Record<string, unknown> | undefined;
					if (record) {
						const cid = record.conversationId as string | undefined;
						const ts = Number(record.timestamp); // already milliseconds per API spec
						const senderId = Number(record.profileId);

						if (cid && !Number.isNaN(ts) && !Number.isNaN(senderId) && userIdRef.current != null) {
							if (senderId !== userIdRef.current) {
								await chatLog.appendMessages(cid, [], ts);
								maybeUnarchiveOnActivity(senderId);
							} else {
								// Grindr echoing back that we read this conversation,
								// here or on another device. Either way a notification
								// still up for it is out of date.
								void clearChatNotifications(cid);

								const conv = getConversation(cid);
								if (conv && !isReadReceiptsHidden(cid)) {
									const other = getOtherParticipant(conv, userIdRef.current);
									if (other?.profileId) {
										await clearUnreadCountForProfile(String(other.profileId)).catch(() => {});
									}
								}
							}
						}
					}
				}

				// chat.v1.conversation.delete — fires both when we're blocked/deleted
				// and on unblock, with nothing in the payload to tell which. Toggle
				// based on current archived state instead: never delete, and never
				// archive an already-archived conversation again. Runs before the
				// forwarded CustomEvent below so any mounted ChatPage listener sees
				// DB-consistent state.
				if (
					envelope.type === "chat.v1.conversation.delete" &&
					envelope.payload &&
					typeof envelope.payload === "object"
				) {
					const record = envelope.payload as Record<string, unknown>;
					const ids = Array.isArray(record.conversationIds)
						? (record.conversationIds as unknown[]).filter(
								(id): id is string => typeof id === "string",
							)
						: [];
					if (ids.length > 0) {
						const notificationId =
							typeof envelope.notificationId === "string" ? envelope.notificationId : null;
						const { systemMessages } = await toggleArchiveOnConversationDelete(
							ids,
							notificationId,
							isProfileFound,
							isBlockedByMe,
							checkConversationAccessible,
							userIdRef.current,
						);
						if (systemMessages.length > 0) {
							window.dispatchEvent(
								new CustomEvent<Message[]>(CHAT_SYSTEM_MESSAGE_EVENT, {
									detail: systemMessages,
								}),
							);
						}
					}
				}

				const messages = extractMessages(envelope);
				if (messages.length > 0) {
					traceMessages(messages.length);
					const byConv = new Map<string, Message[]>();
					for (const m of messages) {
						const messageText = extractTextFromMessage(m);
						const isIncoming = userIdRef.current != null && Number(m.senderId) !== Number(userIdRef.current);
						// Set when the rules said to block this sender and the block did
						// not go through here. Usually another device of the user's
						// blocked them a moment earlier (the PC is quicker), and the
						// conversation was already gone; otherwise the block waits for
						// the next pass. Either way the message is not announced.
						let blockLeftUndone = false;

						// --- FORBIDDEN KEYWORDS & CUSTOM AUTOMATION RULES ---
						if (isIncoming && m.senderId) {
							const pidStr = String(m.senderId);
							const knownDisplayName =
								getDisplayName(m.conversationId, userIdRef.current) ?? "";
							const realtimeConversation = conversationEntryFromRealtimeMessage(
								m,
								pidStr,
								knownDisplayName,
							);
							const autoBlockRunner = {
								...apiFunctions,
								blockProfile: (targetProfileId: string, reason?: StatsBlockReason) =>
									preserveAndAutoBlockConversation({
										conversation: realtimeConversation,
										profileId: targetProfileId,
										displayName: knownDisplayName,
										fetchMessages: () =>
											apiFunctions.listMessages({ conversationId: m.conversationId }),
										additionalMessages: [m],
										userId: userIdRef.current,
										getAlbum: (albumId) => apiFunctions.getAlbum(albumId),
										blockProfile: () => apiFunctions.blockProfile(targetProfileId),
										// Automation rules mark a sender seen before acting, so a
										// deferred block here would never be retried.
										mayDeferOnIncompleteCapture: false,
										stats: { source: "automation", reason },
									}),
							};
							const isWhitelisted = isProfileAutoblockWhitelisted(pidStr) ||
								(await checkAndAutoWhitelistActiveChat(pidStr, m.conversationId, undefined, undefined, userIdRef.current));
							const isBlockEnabled = window.localStorage.getItem("fg-block-chat") !== "false";

							let blockReason = "";
							// Set by a rule that knows more than its sentence; the others are read from the sentence.
							let blockStatsReason: StatsBlockReason | null = null;
							// What the notification says, when that is more than the reason.
							let blockNotice = "";
							let detectedDisplayName = knownDisplayName;
							let detectedPhotoHash: string | null = null;
							// Whether the profile was read while deciding. A rule decided from
							// the message alone has not, and has to read it before blocking.
							let profileRead = false;
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							let senderProfile: any = null;

							if (isBlockEnabled && !isWhitelisted) {
								const matchedMessage = messageText ? getMatchedForbiddenWord(messageText, "message") : null;
								// Openers are only judged when this really is the first thing this
								// person has said. chatDb is the record of what they sent before —
								// the bridge has not persisted the current message yet, so an empty
								// result here means this one is their opener. A failed read counts as
								// "not the first", since blocking on a message that merely looks like
								// an opener is the mistake worth avoiding.
								const matchedOpener = messageText && !matchedMessage
									? await chatDb
											.getMessages(m.conversationId)
											.then((stored) =>
												stored.some((entry) => String(entry.senderId) === pidStr)
													? null
													: getMatchedFirstMessageWord(messageText),
											)
											.catch(() => null)
									: null;
								if (matchedMessage) {
									blockReason = `Message keyword: "${matchedMessage}"`;
								} else if (matchedOpener) {
									blockReason = `First message: "${matchedOpener}"`;
								} else if (
									isLinkBotRuleEnabled() &&
									isLinkOnlyMessage(messageText) &&
									(await isLinkBotConversation(m.conversationId, [m], userIdRef.current))
								) {
									blockReason = LINK_BOT_REASON;
								} else {
									try {
										const profile = await apiFunctions.getProfileDetail(pidStr).catch(() => null) as any;
										if (profile) {
											profileRead = true;
											senderProfile = profile;
											rememberNotificationSender(pidStr, profile);
											const name = profile.name || profile.displayName || "";
											detectedDisplayName = name || detectedDisplayName;
											detectedPhotoHash = profile.profileImageMediaHash ?? null;
											const bio = profile.aboutMe || "";
											const age = profile.age;
											const distance = profile.distanceMeters ?? profile.distance;
											const lookingForTags = profile.lookingFor || [];

											const matchedName = getMatchedForbiddenWord(name, "name");
											const matchedBio = getMatchedForbiddenWord(bio, "bio");

											if (isOutsideAgeLimits(age)) {
												blockReason = age == null ? "No Age Set" : `Age limit (${age})`;
											} else if (isOutsideDistanceLimits(distance)) {
												blockReason = "Distance limit";
											} else if (hasRightNowStatus(profile)) {
												blockReason = "Has active 'Right Now' status";
											} else if (isForbiddenLookingFor(lookingForTags)) {
												blockReason = "Forbidden 'Looking For' tag";
											} else if (hasTwitterAccount(profile)) {
												blockReason = "Has an X / Twitter account";
											} else if (matchedName) {
												blockReason = `Name keyword: "${matchedName}"`;
											} else if (matchedBio) {
												blockReason = `Bio keyword: "${matchedBio}"`;
											}
										}
									} catch {}
								}
							}

							// An explicit photo or video. Has its own switch rather than the
							// chat auto-block one above, and is waited for here — before the
							// message is counted as unread or announced — so a block means the
							// photo never reached a notification or the inbox. A check that
							// fails or runs out of time blocks nobody: the message goes
							// through with its photo covered.
							if (!blockReason && isExplicitBlockEnabled()) {
								const explicitCheck = await checkLiveMessageMedia(m, (albumId) => apiFunctions.getAlbum(albumId));
								if (
									explicitCheck &&
									decideLiveExplicitBlock(m, explicitCheck, userIdRef.current, isWhitelisted).block
								) {
									blockReason = explicitReasonFor(explicitCheck);
									blockStatsReason = explicitStatsReason(explicitCheck);
									blockNotice = explicitNotice(blockReason, scoresOf(explicitCheck));
								}
							}

							// The same for their profile photos: someone can open with
							// nothing but "hey" while the explicit thing is the photo on
							// their profile. Read once per person and remembered, so a run
							// of messages does not keep fetching the profile.
							if (!blockReason && isExplicitProfileBlockEnabled() && !isWhitelisted) {
								const explicitProfilePhoto = await findExplicitProfilePhoto(
									apiFunctions,
									pidStr,
									senderProfile,
								);
								if (
									explicitProfilePhoto &&
									decideLiveExplicitBlock(m, explicitProfilePhoto, userIdRef.current, isWhitelisted, true).block
								) {
									blockReason = EXPLICIT_PROFILE_PHOTO_REASON;
									blockStatsReason = explicitStatsReason(explicitProfilePhoto, EXPLICIT_PROFILE_PHOTO_REASON);
									blockNotice = explicitNotice(blockReason, scoresOf(explicitProfilePhoto));
								}
							}

							if (blockReason) {
								appLog.info(`[ChatRealtimeBridge] Instant auto-blocking ${pidStr} due to: ${blockReason}`);
								// A match decided without the profile still needs it, and this
								// is the last moment it can be read: after the block the archived
								// chat would keep no name and no photo.
								if (!profileRead) {
									const profileForArchive = (await apiFunctions
										.getProfileDetail(pidStr)
										.catch(() => null)) as {
										name?: string | null;
										displayName?: string | null;
										profileImageMediaHash?: string | null;
									} | null;
									if (profileForArchive) {
										detectedDisplayName =
											profileForArchive.name || profileForArchive.displayName || detectedDisplayName;
										detectedPhotoHash = profileForArchive.profileImageMediaHash ?? null;
									}
								}
								try {
									await preserveAndAutoBlockConversation({
										conversation: conversationEntryFromRealtimeMessage(
											m,
											pidStr,
											detectedDisplayName,
											detectedPhotoHash,
										),
										profileId: pidStr,
										displayName: detectedDisplayName,
										fetchMessages: () =>
											apiFunctions.listMessages({ conversationId: m.conversationId }),
										additionalMessages: [m],
										userId: userIdRef.current,
										getAlbum: (albumId) => apiFunctions.getAlbum(albumId),
										blockProfile: () => apiFunctions.blockProfile(pidStr),
										stats: { source: "live_chat", reason: blockStatsReason ?? { label: blockReason } },
									});
									// Whatever rule caught them, a link bot's chat does not stay in the
									// archive, and the block goes unannounced: the user asked to never
									// hear of link bots at all.
									const removedAsLinkBot = await removeChatIfLinkBot(
										m.conversationId,
										pidStr,
										[m],
										userIdRef.current,
									);
									if (!removedAsLinkBot) {
										void notifyAutoBlock(detectedDisplayName || pidStr, blockNotice || blockReason);
									}
									if (blockStatsReason?.kind === "explicit_media") {
										logDetectorDecision({
											profileId: pidStr,
											name: detectedDisplayName,
											outcome: "blocked",
											detail: blockNotice || blockReason,
										});
									}
									releaseLiveMessage(m.messageId);
									continue;
								} catch (error) {
									appLog.warn("[ChatRealtimeBridge] preserving auto-blocked conversation failed", error);
									blockLeftUndone = true;
								}
							}
							// Not blocked here, so whatever reports this photo's verdict next
							// (the thread opening, the scanner) may act on it.
							releaseLiveMessage(m.messageId);

							const { blocked: blockedByNewChat } = await runAutomationRulesForSender(
								String(m.senderId),
								"new_chat",
								autoBlockRunner,
								undefined,
								messageText,
							).catch(() => ({ blocked: false, matchedRuleNames: [] }));
							if (blockedByNewChat) continue; // A rule blocked the sender — skip processing this message.

							// Dedupes per messageId rather than per sender — the custom-rule
							// equivalent of the forbidden keyword check above (e.g. a
							// "message contains keyword" rule), evaluated once per message.
							const { blocked: blockedByMessage } = await runAutomationRulesForSender(
								String(m.senderId),
								"message_received",
								autoBlockRunner,
								undefined,
								messageText,
								m.messageId,
							).catch(() => ({ blocked: false, matchedRuleNames: [] }));
							if (blockedByMessage) continue;

							// No rule blocked them, but this account already had. A
							// message from someone it blocked can only arrive once Grindr
							// has dropped that block, so the block is put back before the
							// message is counted as unread or announced. The whitelist
							// still means "never block this person automatically".
							if (!isWhitelisted) {
								const restored = await restoreDroppedBlock({
									profileId: pidStr,
									evidenceAt: m.timestamp < 100_000_000_000 ? m.timestamp * 1000 : m.timestamp,
									blockProfile: () =>
										preserveAndAutoBlockConversation({
											conversation: realtimeConversation,
											profileId: pidStr,
											displayName: knownDisplayName,
											fetchMessages: () =>
												apiFunctions.listMessages({ conversationId: m.conversationId }),
											additionalMessages: [m],
											userId: userIdRef.current,
											getAlbum: (albumId) => apiFunctions.getAlbum(albumId),
											blockProfile: () => apiFunctions.blockProfile(pidStr),
											// One chance only: the next message may never come.
											mayDeferOnIncompleteCapture: false,
											stats: null,
										}),
								});
								if (restored === "restored") {
									void notifyAutoBlock(knownDisplayName || pidStr, DROPPED_BLOCK_NOTICE);
									continue;
								}
							}
						}
						// -----------------------------

						const list = byConv.get(m.conversationId) ?? [];
						list.push(m);
						byConv.set(m.conversationId, list);

						if (isIncoming) {
							maybeUnarchiveOnActivity(m.senderId);
						}

						// Update local contact index for unread badge persistence
						if (isIncoming) {
							// The chat page says which conversation is on screen.
							// The address cannot: on a desktop, picking a chat from
							// the list leaves it as it was. (The check that stood
							// here compared against an address the app never has,
							// so it never held and the open chat was treated like
							// any other.) A chat open in a window nobody is looking
							// at is not being read either.
							const isViewingThisChat =
								isAppForeground() && getOpenConversationId() === m.conversationId;
							if (!isViewingThisChat) {
								await incrementUnreadCountForProfile(
									String(m.senderId),
									m.conversationId,
									m.timestamp,
								).catch((err) => {
									appLog.warn("[chat-ws:bridge] failed to increment unread", err);
								});
								if (blockLeftUndone) {
									traceNotification("sender matched a block rule");
								} else {
									void triggerIncomingMessageNotification(m);
								}
							}
						}
					}
					
					for (const [cid, msgs] of byConv) {
						await chatLog.appendMessages(cid, msgs);
						for (const msg of msgs) {
							const target = getMediaCaptureTarget(msg);
							if (!target) continue;
							void fetchAndStoreMedia({
								mediaKey: target.mediaKey,
								kind: target.kind,
								url: target.url,
								conversationId: cid,
								messageId: msg.messageId,
								viewOnce: target.viewOnce,
								isOwnMessage:
									userIdRef.current != null && Number(msg.senderId) === Number(userIdRef.current),
								sender: { senderId: msg.senderId, timestamp: msg.timestamp },
							});
						}
						captureAlbumsForMessages(msgs, cid, (id) => apiFunctions.getAlbum(id));
						captureReplyPreviewsForMessages(msgs, cid);
					}
				}

				// Dispatch AFTER DB/Log persistence so listeners see updated state in DB
				window.dispatchEvent(
					new CustomEvent<RealtimeEnvelope>(CHAT_REALTIME_EVENT, {
						detail: envelope,
					}),
				);
			},
			onRawMessage: (_raw) => {
				// appLog.debug(`[chat-ws:bridge:raw] ${JSON.stringify(raw)}`);
			},
			onParseError: (raw, error) => {
				appLog.warn("[chat-ws:bridge:parse-error]", { raw, error });
			},
			buildSocket: isTauriRuntime()
				? (url) => new TauriWebSocket(url) as unknown as WebSocket
				: undefined,
		});

		manager.start();
		setActiveRealtimeManager(manager);

		// Handle Foreground/Background shifts on Android
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				// appLog.debug("[chat-ws:bridge] app visible; checking connection...");
				// Restarting the manager is the safest way to ensure a fresh,
				// functional socket after a potentially long background sleep.
				manager.stop({ suppressStatus: true });
				manager.start();
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			// appLog.debug("[chat-ws:bridge] stopping manager");
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			setActiveRealtimeManager(null);
			manager.stop({ suppressStatus: true });
		};
	}, [userId]);

	return null;
}
