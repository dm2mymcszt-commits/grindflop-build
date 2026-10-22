import { useEffect, useRef } from "react";
import { useApiFunctions } from "../hooks/useApiFunctions";
import { useAuth } from "../contexts/useAuth";
import { 
    isOutsideAgeLimits, 
    isOutsideDistanceLimits, 
    isForbiddenLookingFor,
    hasRightNowStatus,
    hasTwitterAccount,
    notifyAutoBlock,
    getMatchedForbiddenWord,
    getMatchedFirstMessageWord
} from "../utils/autoblock";
import { getMediaCaptureTarget, getOtherParticipant } from "../pages/app/chat/chatUtils";
import { isProfileAutoblockWhitelisted, checkAndAutoWhitelistActiveChat, getSentMessagesThreshold } from "../utils/privacy";
import type { ConversationEntry, MessagesResponse } from "../types/messages";
import { preserveAndAutoBlockConversation } from "../services/autoBlockConversation";
import * as chatDb from "../services/chatDb";
import { getExplicitFilterSince, isExplicitBlockEnabled } from "../services/contentCheck";
import { fetchAndStoreMedia } from "../services/mediaStore";
import { captureAlbumsForMessagesNow } from "../services/albumStore";
import { findExplicitProfilePhoto, profileFaceVerdictFor } from "../services/profilePhotoCheck";
import { explicitStatsReason } from "../services/explicitMediaGuard";
import { isExplicitProfileBlockEnabled, scoresOf, verdictOf } from "../services/contentCheck";
import { sentMediaFaceFor } from "../services/sentMediaFace";
import { logDetectorDecision } from "../services/detectorLog";
import {
    decideExplicitBlock,
    EXPLICIT_PROFILE_PHOTO_REASON,
    explicitNotice,
    sentMediaSaves,
    type SentMediaFace,
} from "../utils/explicitContentRules";
import {
    getNeedFaceSince,
    getNoFacePhotoDelayMinutes,
    getNoFacePhotoSince,
    getNoPhotoDelayMinutes,
    isNeedFaceEnabled,
    isNoFacePhotoRuleEnabled,
    isNoPhotoRuleEnabled,
} from "../utils/facelessSettings";
import type { StatsBlockReason } from "../services/statsLog";
import { LINK_BOT_REASON, isLinkBotRuleEnabled, isLinkOnlyMessage } from "../utils/linkBotMessage";
import { isLinkBotConversation, removeChatIfLinkBot } from "../services/linkBots";
import {
    earliestTimestamp,
    NO_EARLIER_HISTORY,
    summarizeEarlierHistory,
    type EarlierHistory,
} from "../utils/autoBlockHistory";

/**
 * What GrindFlop's own history holds from before Grindr's copy of this chat
 * begins. The scanner's "first message" rules read Grindr's copy, and deleting
 * a conversation restarts that copy while keeping ours — so whatever someone
 * sent next looked like their opener. The live message path already checks
 * chatDb for the same reason. A failed read counts as prior history: a rule
 * that blocks on someone's first message should not act on a guess.
 */
async function readEarlierHistory(
    conversationId: string,
    serverMessages: readonly { timestamp?: number | null }[],
    userId: number | string | null | undefined,
): Promise<EarlierHistory> {
    const before = earliestTimestamp(serverMessages);
    if (before == null) return NO_EARLIER_HISTORY;
    const earlier = await chatDb
        .getMessagesPage(conversationId, { beforeTimestamp: before, limit: 50 })
        .catch(() => null);
    if (earlier == null) {
        return { hasOutgoing: true, hasIncoming: true, hasIncomingText: true };
    }
    return summarizeEarlierHistory(earlier, userId);
}

/** Whether the newest message in a conversation, as the inbox shows it, is a photo, video or album. */
function previewIsMedia(conversation: ConversationEntry): boolean {
    const type = conversation.data?.preview?.type?.toLowerCase() || "";
    const chat1Type = conversation.data?.preview?.chat1Type?.toLowerCase() || "";
    return (
        type === "image" ||
        type === "expiringimage" ||
        type === "video" ||
        type === "nonexpiringvideo" ||
        type === "privatevideo" ||
        type.includes("album") ||
        chat1Type === "image" ||
        chat1Type === "expiring_image" ||
        chat1Type === "video" ||
        chat1Type === "private_video" ||
        chat1Type === "expiring_video"
    );
}

/** Whether a message is a photo, video or album, going by its type alone. */
function isMediaTypeMessage(message: { type?: string | null; chat1Type?: string | null }): boolean {
    const type = message.type?.toLowerCase() || "";
    const chat1Type = message.chat1Type?.toLowerCase() || "";
    return (
        type === "image" ||
        type === "expiringimage" ||
        type === "video" ||
        type === "nonexpiringvideo" ||
        type.includes("album") ||
        chat1Type === "image" ||
        chat1Type === "expiring_image" ||
        chat1Type === "video" ||
        chat1Type === "private_video" ||
        chat1Type === "expiring_video"
    );
}

/** Below this, a message time is in seconds rather than milliseconds. */
const SECONDS_THRESHOLD = 100_000_000_000;

/**
 * How long to gather "settings changed" events before sweeping. The keyword
 * editor saves on every tag added, removed or switched, and each save used to
 * start its own full inbox scan.
 */
const SCAN_TRIGGER_DEBOUNCE_MS = 2000;

export function BackgroundInboxScanner() {
    const api = useApiFunctions();
    const { userId } = useAuth();
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const triggerScanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scannedProfilesRef = useRef<Map<string, { lastActivityTimestamp: number; unreadCount: number }>>(new Map());
    const isScanningRef = useRef(false);
    const pendingMediaBlocksRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    // Seen/Read auto-block: maps conversationId -> timestamp when "seen but not replied" was first detected
    const seenStartTimesRef = useRef<Map<string, number>>(new Map());
    // Explicit-photo catch-up: conversationId -> the last activity its photos were checked up to
    const explicitCheckedRef = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        if (!api || userId == null) return;

        let isCancelled = false;

        const blockConversation = async ({
            conversation,
            profileId,
            displayName,
            reason,
            statsReason,
            notice,
            messageSnapshot,
        }: {
            conversation: ConversationEntry;
            profileId: string;
            displayName: string;
            reason: string;
            /** For a rule that knows more than its sentence says. */
            statsReason?: StatsBlockReason;
            /** What the notification says, when that is more than the reason. */
            notice?: string;
            messageSnapshot?: MessagesResponse;
        }): Promise<boolean> => {
            try {
                await preserveAndAutoBlockConversation({
                    conversation,
                    profileId,
                    displayName,
                    messageSnapshot,
                    fetchMessages: () => api.listMessages({
                        conversationId: conversation.data.conversationId,
                    }),
                    userId,
                    getAlbum: (albumId) => api.getAlbum(albumId),
                    blockProfile: () => api.blockProfile(profileId),
                    stats: { source: "inbox_scan", reason: statsReason ?? { label: reason } },
                });
                // Whatever rule caught them, a link bot's chat does not stay in the
                // archive, and the block goes unannounced: the user asked to never
                // hear of link bots at all.
                const removedAsLinkBot = await removeChatIfLinkBot(
                    conversation.data.conversationId,
                    profileId,
                    messageSnapshot?.messages ?? [],
                    userId,
                );
                if (!removedAsLinkBot) {
                    void notifyAutoBlock(displayName, notice ?? reason);
                }
                window.dispatchEvent(new Event("fg-refresh-inbox"));
                return true;
            } catch (error) {
                console.warn(
                    `[BackgroundInboxScanner] Preserving/blocking ${conversation.data.conversationId} failed; leaving it available for retry:`,
                    error,
                );
                return false;
            }
        };

        const scanInbox = async () => {
            if (isCancelled || isScanningRef.current) return;
            
            const isScannerEnabled = window.localStorage.getItem("fg-inbox-scanner-enabled") === "true";
            const isBotEvasionEnabled = window.localStorage.getItem("fg-block-first-media") === "true";
            const isSeenBlockEnabled = window.localStorage.getItem("fg-block-seen-enabled") === "true";
            const isFacelessBlockEnabled = isNoPhotoRuleEnabled() || isNoFacePhotoRuleEnabled();
            const isExplicitMediaCatchUpEnabled = isExplicitBlockEnabled();
            const isExplicitProfileCatchUpEnabled = isExplicitProfileBlockEnabled();
            const isExplicitCatchUpEnabled = isExplicitMediaCatchUpEnabled || isExplicitProfileCatchUpEnabled;
            const isLinkBotEnabled = isLinkBotRuleEnabled();
            if (!isScannerEnabled && !isBotEvasionEnabled && !isSeenBlockEnabled && !isFacelessBlockEnabled && !isExplicitCatchUpEnabled && !isLinkBotEnabled) {
                // Check again in 30 seconds
                if (!isCancelled) {
                    timeoutRef.current = setTimeout(scanInbox, 30000);
                }
                return;
            }

            try {
                isScanningRef.current = true;
                const response = await api.listConversations({ page: 1 });
                const conversations = response?.entries || [];
                
                const toScan = conversations
                    .filter((c: any) => {
                        const otherId = getOtherParticipant(c, userId)?.profileId?.toString();
                        if (!otherId) return false;
                        
                        const unreadCount = c.data?.unreadCount ?? 0;
                        const lastSenderId = c.data?.preview?.senderId;
                        const isLastMessageFromThem = lastSenderId != null && Number(lastSenderId) !== Number(userId);
                        
                        const previewType = c.data?.preview?.type?.toLowerCase() || "";
                        const previewChat1 = c.data?.preview?.chat1Type?.toLowerCase() || "";
                        const isPreviewMedia =
                            previewType === "image" ||
                            previewType === "expiringimage" ||
                            previewType === "video" ||
                            previewType === "nonexpiringvideo" ||
                            previewType.includes("album") ||
                            previewChat1 === "image" ||
                            previewChat1 === "expiring_image" ||
                            previewChat1 === "video" ||
                            previewChat1 === "private_video" ||
                            previewChat1 === "expiring_video";

                        // A link bot that wrote while the app was closed never met the live check.
                        const isPreviewLinkOnly = isLastMessageFromThem && isLinkOnlyMessage(c.data?.preview?.text);
                        const shouldScan = isScannerEnabled ||
                            (isBotEvasionEnabled && (unreadCount > 0 || (isLastMessageFromThem && isPreviewMedia))) ||
                            (isLinkBotEnabled && isPreviewLinkOnly);
                        if (!shouldScan) return false;
                        
                        const cached = scannedProfilesRef.current.get(otherId);
                        if (!cached) return true; // Not scanned yet
                        
                        const lastTs = c.data?.lastActivityTimestamp ?? 0;
                        if (cached.lastActivityTimestamp !== lastTs || cached.unreadCount !== unreadCount) {
                            return true; // Info changed, need to re-scan
                        }
                        
                        return false;
                    })
                    .map((c: any) => ({
                        profileId: getOtherParticipant(c, userId)!.profileId!.toString(),
                        unreadCount: c.data?.unreadCount ?? 0,
                        lastActivityTimestamp: c.data?.lastActivityTimestamp ?? 0,
                        conversationId: c.data?.conversationId,
                        conversation: c,
                    }));

                if (toScan.length > 0) {
                    console.log(`[BackgroundInboxScanner] Found ${toScan.length} unscanned/updated profiles in inbox:`, toScan);
                    for (const item of toScan) {
                        if (isCancelled) break;
                        const { profileId, unreadCount, lastActivityTimestamp, conversationId, conversation } = item;
                        scannedProfilesRef.current.set(profileId, { unreadCount, lastActivityTimestamp });

                        try {
                            const profileDetail = await api.getProfileDetail(profileId);
                            const p = profileDetail as any;

                            const age = p.age;
                            const distance = p.distanceMeters ?? p.distance;
                            const name = p.name || p.displayName || "Unknown";
                            const bio = p.aboutMe;
                            const lookingForTags = p.lookingFor || [];

                            let blockReason = "";
                            let messages: any[] = [];
                            let fetchedMessages = false;
                            let messageSnapshot: MessagesResponse | undefined;
                            let outgoingCount = 0;

                            if (isProfileAutoblockWhitelisted(profileId)) {
                                continue;
                            }

                            const skipActiveChatsEnabled = window.localStorage.getItem("fg-autoblock-skip-after-two") === "true";
                            const thresholdCount = getSentMessagesThreshold();

                            if (skipActiveChatsEnabled) {
                                try {
                                    const msgRes = await api.listMessages({ conversationId });
                                    messages = msgRes.messages || [];
                                    fetchedMessages = true;
                                    messageSnapshot = msgRes;
                                    for (const msg of messages) {
                                        const msgIsMine = userId != null && Number(msg.senderId) === Number(userId);
                                        if (msgIsMine) {
                                            outgoingCount++;
                                        }
                                    }
                                } catch {}

                                if (outgoingCount >= thresholdCount) {
                                    await checkAndAutoWhitelistActiveChat(profileId, conversationId, name, p.primaryMediaHash, userId);
                                    continue;
                                }
                            }

                            if (isScannerEnabled) {
                                    const matchedName = getMatchedForbiddenWord(name, "name");
                                    const matchedBio = getMatchedForbiddenWord(bio, "bio");

                                    if (isOutsideAgeLimits(age)) {
                                        blockReason = age == null ? "No Age Set" : `Age limit (${age})`;
                                    } else if (isOutsideDistanceLimits(distance)) {
                                        blockReason = "Distance limit";
                                    } else if (hasRightNowStatus(p)) {
                                        blockReason = "Has active 'Right Now' status";
                                    } else if (isForbiddenLookingFor(lookingForTags)) {
                                        blockReason = "Forbidden 'Looking For' tag";
                                    } else if (hasTwitterAccount(p)) {
                                        blockReason = "Has an X / Twitter account";
                                    } else if (matchedName) {
                                        blockReason = `Name keyword: ${matchedName}`;
                                    } else if (matchedBio) {
                                        blockReason = `Bio keyword: ${matchedBio}`;
                                    }

                                    if (!blockReason) {
                                        if (!fetchedMessages) {
                                            try {
                                                const msgRes = await api.listMessages({ conversationId });
                                                messages = msgRes.messages || [];
                                                fetchedMessages = true;
                                                messageSnapshot = msgRes;
                                            } catch {}
                                        }
                                        // The openers list is checked against the first message this
                                        // person ever sent, and only that one: a word like "hot" is
                                        // unremarkable later in a conversation, which is the whole
                                        // reason it is not on the forbidden-keywords list.
                                        let seenFirstIncoming = false;

                                        for (const msg of messages) {
                                            const msgIsMine = userId != null && Number(msg.senderId) === Number(userId);
                                            if (!msgIsMine) {
                                                if (!seenFirstIncoming) {
                                                    seenFirstIncoming = true;
                                                    const openerBody: any = msg.body;
                                                    const openerText = openerBody && typeof openerBody.text === "string" ? openerBody.text : (typeof msg.body === "string" ? msg.body : "");
                                                    const matchedOpener = getMatchedFirstMessageWord(openerText);
                                                    // An opener only if they had said nothing before Grindr's copy of the chat.
                                                    if (matchedOpener && !(await readEarlierHistory(conversationId, messages, userId)).hasIncoming) {
                                                        blockReason = `First message: "${matchedOpener}"`;
                                                        break;
                                                    }
                                                }
                                                const msgBody: any = msg.body;
                                                const text = msgBody && typeof msgBody.text === "string" ? msgBody.text : (typeof msg.body === "string" ? msg.body : "");
                                                const matchedMsg = getMatchedForbiddenWord(text, "message");
                                                if (matchedMsg) {
                                                    blockReason = `Message keyword: ${matchedMsg}`;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }

                                if (!blockReason && window.localStorage.getItem("fg-block-first-media") === "true") {
                                    try {
                                        if (!fetchedMessages) {
                                            const msgRes = await api.listMessages({ conversationId });
                                            messages = msgRes.messages || [];
                                            fetchedMessages = true;
                                            messageSnapshot = msgRes;
                                        }
                                        
                                        let hasOutgoing = false;
                                        let hasIncomingText = false;
                                        let firstMsgIsMedia = false;
                                        let firstMsgTimestamp = 0;
                                        
                                        for (let i = 0; i < messages.length; i++) {
                                            const msg = messages[i];
                                            const msgIsMine = userId != null && Number(msg.senderId) === Number(userId);
                                            if (msgIsMine) {
                                                hasOutgoing = true;
                                            } else {
                                                const msgBody: any = msg.body;
                                                const text = msgBody && typeof msgBody.text === "string" ? msgBody.text : "";
                                                if (text && text.trim() !== "") {
                                                    hasIncomingText = true;
                                                }
                                                
                                                const typeLower = msg.type?.toLowerCase() || "";
                                                const chat1Lower = msg.chat1Type?.toLowerCase() || "";
                                                const isMedia =
                                                    typeLower === "image" ||
                                                    typeLower === "expiringimage" ||
                                                    typeLower === "video" ||
                                                    typeLower === "nonexpiringvideo" ||
                                                    typeLower.includes("album") ||
                                                    chat1Lower === "image" ||
                                                    chat1Lower === "expiring_image" ||
                                                    chat1Lower === "video" ||
                                                    chat1Lower === "private_video" ||
                                                    chat1Lower === "expiring_video";
                                                    
                                                if (isMedia && (!text || text.trim() === "")) {
                                                    if (i === 0) {
                                                        firstMsgIsMedia = true;
                                                        firstMsgTimestamp = msg.timestamp || Date.now();
                                                    }
                                                }
                                            }
                                        }
                                        
                                        // After a delete, Grindr's copy can begin mid-conversation; ours still holds the rest.
                                        const earlier = firstMsgIsMedia && !hasOutgoing && !hasIncomingText
                                            ? await readEarlierHistory(conversationId, messages, userId)
                                            : null;
                                        if (earlier && !earlier.hasOutgoing && !earlier.hasIncomingText) {
                                        const delayEnabled = window.localStorage.getItem("fg-block-media-delay-enabled") === "true";
                                        if (delayEnabled) {
                                            const elapsedMs = Date.now() - firstMsgTimestamp;
                                            const delayMin = parseInt(window.localStorage.getItem("fg-block-media-delay-minutes") || "2", 10);
                                            const delayMs = Math.max(1, Math.min(5, delayMin)) * 60000;
                                            
                                            if (elapsedMs >= delayMs) {
                                                blockReason = "First message was media (Bot evasion)";
                                            } else {
                                                if (!pendingMediaBlocksRef.current.has(conversationId)) {
                                                    const remainingMs = delayMs - elapsedMs;
                                                    console.log(`[BackgroundInboxScanner] Scheduling delayed block for ${conversationId} in ${Math.round(remainingMs / 1000)}s`);
                                                    const timer = setTimeout(async () => {
                                                        try {
                                                            const msgRes2 = await api.listMessages({ conversationId });
                                                            const messages2 = msgRes2.messages || [];
                                                            let hasOutgoingNow = false;
                                                            let hasIncomingTextNow = false;
                                                            for (const msg of messages2) {
                                                                const msgIsMine = userId != null && Number(msg.senderId) === Number(userId);
                                                                if (msgIsMine) {
                                                                    hasOutgoingNow = true;
                                                                } else {
                                                                    const msgBody: any = msg.body;
                                                                    const text = msgBody && typeof msgBody.text === "string" ? msgBody.text : "";
                                                                    if (text && text.trim() !== "") {
                                                                        hasIncomingTextNow = true;
                                                                    }
                                                                }
                                                            }
                                                            const earlierNow = !hasOutgoingNow && !hasIncomingTextNow
                                                                ? await readEarlierHistory(conversationId, messages2, userId)
                                                                : null;
                                                            if (earlierNow && !earlierNow.hasOutgoing && !earlierNow.hasIncomingText) {
                                                                console.log(`[BackgroundInboxScanner] Delayed block: Blocking ${profileId} (${name})`);
                                                                const delayedBlocked = await blockConversation({
                                                                    conversation,
                                                                    profileId,
                                                                    displayName: name,
                                                                    reason: "Scanner: First message was media (Bot evasion)",
                                                                    messageSnapshot: msgRes2,
                                                                });
                                                                if (!delayedBlocked) {
                                                                    // Preserving failed (e.g. an album share we couldn't
                                                                    // fully download yet) — forget the scan cache entry so
                                                                    // the next inbox pass re-evaluates and retries.
                                                                    scannedProfilesRef.current.delete(profileId);
                                                                }
                                                            }
                                                        } catch (err) {
                                                            console.warn("[BackgroundInboxScanner] Delayed block error:", err);
                                                        } finally {
                                                            pendingMediaBlocksRef.current.delete(conversationId);
                                                        }
                                                    }, remainingMs);
                                                    pendingMediaBlocksRef.current.set(conversationId, timer);
                                                }
                                            }
                                        } else {
                                            blockReason = "First message was media (Bot evasion)";
                                        }
                                    }
                                } catch (msgErr) {
                                    console.warn(`[BackgroundInboxScanner] Failed to fetch/analyze messages for conversation ${conversationId}:`, msgErr);
                                }
                            }

                            if (!blockReason && isLinkBotEnabled && isLinkOnlyMessage(conversation.data?.preview?.text)) {
                                try {
                                    if (!fetchedMessages) {
                                        const msgRes = await api.listMessages({ conversationId });
                                        messages = msgRes.messages || [];
                                        fetchedMessages = true;
                                        messageSnapshot = msgRes;
                                    }
                                    if (await isLinkBotConversation(conversationId, messages, userId)) {
                                        blockReason = LINK_BOT_REASON;
                                    }
                                } catch (linkErr) {
                                    console.warn(`[BackgroundInboxScanner] Could not check ${conversationId} for a link bot:`, linkErr);
                                }
                            }

                            if (blockReason) {
                                console.log(`[BackgroundInboxScanner] Blocking ${profileId} (${name}) for: ${blockReason}`);
                                const blocked = await blockConversation({
                                    conversation,
                                    profileId,
                                    displayName: name,
                                    reason: `Scanner: ${blockReason}`,
                                    messageSnapshot,
                                });
                                if (!blocked) {
                                    scannedProfilesRef.current.delete(profileId);
                                }
                            }
                        } catch (err) {
                            // The profile was marked scanned before its detail was
                            // fetched, so leaving the cache entry in place would
                            // retire it until its unread count or last activity
                            // changed — one failed profile request and the rules
                            // never get to look at that person again.
                            scannedProfilesRef.current.delete(profileId);
                            console.warn(`[BackgroundInboxScanner] Failed to scan profile ${profileId}; will retry on the next pass:`, err);
                        }

                        // Throttle between fetches
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                    }
                }

                // --- SEEN/READ AUTO-BLOCK PASS ---
                if (isSeenBlockEnabled) {
                    const seenTimeoutMs = parseInt(window.localStorage.getItem("fg-block-seen-time") || "5", 10) * 60 * 1000;
                    const now = Date.now();

                    for (const c of conversations) {
                        if (isCancelled) break;
                        const conversationId = c.data?.conversationId;
                        if (!conversationId) continue;

                        const otherParticipant = getOtherParticipant(c, userId);
                        const profileId = otherParticipant?.profileId?.toString();
                        if (!profileId) continue;

                        // Skip whitelisted profiles
                        if (isProfileAutoblockWhitelisted(profileId)) {
                            seenStartTimesRef.current.delete(conversationId);
                            continue;
                        }

                        const unreadCount = c.data?.unreadCount ?? 0;
                        const lastSenderId = c.data?.preview?.senderId;
                        const isLastMessageFromMe = lastSenderId != null && Number(lastSenderId) === Number(userId);

                        // Only process conversations where:
                        // 1. The last message is from us (we sent it)
                        // 2. There are no unread messages (they haven't sent anything new)
                        if (!isLastMessageFromMe || unreadCount > 0) {
                            // They replied or the last message isn't ours — clear any tracker
                            seenStartTimesRef.current.delete(conversationId);
                            continue;
                        }

                        try {
                            // Fetch messages to get lastReadTimestamp
                            const msgRes = await api.listMessages({ conversationId });
                            const lastReadTs = msgRes.lastReadTimestamp ?? null;
                            const msgs = msgRes.messages || [];

                            // Find our most recent outgoing message
                            let lastOutgoingTs = 0;
                            for (let i = msgs.length - 1; i >= 0; i--) {
                                if (Number(msgs[i].senderId) === Number(userId)) {
                                    lastOutgoingTs = msgs[i].timestamp;
                                    break;
                                }
                            }

                            if (lastOutgoingTs === 0) {
                                // No outgoing message found
                                seenStartTimesRef.current.delete(conversationId);
                                continue;
                            }

                            // Normalize timestamps: API can return seconds or milliseconds
                            const normalizedReadTs = lastReadTs
                                ? (lastReadTs < 100_000_000_000 ? lastReadTs * 1000 : lastReadTs)
                                : null;
                            const normalizedOutTs = lastOutgoingTs < 100_000_000_000 ? lastOutgoingTs * 1000 : lastOutgoingTs;

                            // Check if they have read our last message
                            if (normalizedReadTs != null && normalizedReadTs >= normalizedOutTs) {
                                // They've read it! Start or continue the countdown
                                if (!seenStartTimesRef.current.has(conversationId)) {
                                    seenStartTimesRef.current.set(conversationId, now);
                                    console.log(`[BackgroundInboxScanner] Seen detected for ${conversationId} (${c.data?.name || profileId}), starting countdown (${seenTimeoutMs / 1000}s)`);
                                }

                                const seenSince = seenStartTimesRef.current.get(conversationId)!;
                                const elapsed = now - seenSince;

                                if (elapsed >= seenTimeoutMs) {
                                    // Time's up — block them
                                    const displayName = c.data?.name || profileId;
                                    const minutesElapsed = Math.round(elapsed / 60000);
                                    console.log(`[BackgroundInboxScanner] Blocking ${profileId} (${displayName}) for: Left on seen for ${minutesElapsed}min`);
                                    const blocked = await blockConversation({
                                        conversation: c,
                                        profileId,
                                        displayName,
                                        reason: `Left on seen for ${minutesElapsed}min`,
                                        messageSnapshot: msgRes,
                                    });
                                    if (blocked) {
                                        seenStartTimesRef.current.delete(conversationId);
                                    }
                                }
                            } else {
                                // They haven't read it yet — no countdown
                                seenStartTimesRef.current.delete(conversationId);
                            }
                        } catch (err) {
                            console.warn(`[BackgroundInboxScanner] Seen check failed for ${conversationId}:`, err);
                        }

                        // Throttle between API calls
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    }
                }

                // --- FACELESS AUTO-BLOCK PASS ---
                // Two rules with one outcome. Someone with no profile picture is
                // blocked a few minutes after their first message; someone whose
                // pictures show no face gets a longer wait of its own, because
                // that is where the detector is most likely to be wrong. Either
                // way, what they send in the meantime can save them.
                if (isFacelessBlockEnabled) {
                    const noPhotoRule = isNoPhotoRuleEnabled();
                    const noFacePhotoRule = isNoFacePhotoRuleEnabled();
                    const noPhotoDelayMs = getNoPhotoDelayMinutes() * 60 * 1000;
                    const noFacePhotoDelayMs = getNoFacePhotoDelayMinutes() * 60 * 1000;
                    const needFaceEnabled = isNeedFaceEnabled();
                    const needFaceSince = getNeedFaceSince();
                    const noFacePhotoSince = getNoFacePhotoSince();
                    const now = Date.now();

                    for (const c of conversations) {
                        if (isCancelled) break;
                        const conversationId = c.data?.conversationId;
                        if (!conversationId) continue;

                        const otherParticipant = getOtherParticipant(c, userId);
                        const profileId = otherParticipant?.profileId?.toString();
                        if (!profileId) continue;

                        // Skip whitelisted profiles
                        if (isProfileAutoblockWhitelisted(profileId)) {
                            continue;
                        }

                        // Which rule this person falls under, if either is on.
                        const primaryHash = otherParticipant.primaryMediaHash?.trim() ?? "";
                        const hasPhoto = primaryHash.length > 0;
                        if (hasPhoto ? !noFacePhotoRule : !noPhotoRule) {
                            continue;
                        }
                        const blockDelayMs = hasPhoto ? noFacePhotoDelayMs : noPhotoDelayMs;
                        const displayName = c.data?.name || profileId;

                        try {
                            const msgRes = await api.listMessages({ conversationId });
                            const messages = msgRes.messages || [];

                            let firstIncomingMsgTimestamp = 0;
                            let outgoingCount = 0;
                            const incoming: typeof messages = [];
                            for (const msg of messages) {
                                if (userId != null && Number(msg.senderId) === Number(userId)) {
                                    outgoingCount++;
                                    continue;
                                }
                                if (firstIncomingMsgTimestamp === 0) {
                                    firstIncomingMsgTimestamp = msg.timestamp || Date.now();
                                }
                                incoming.push(msg);
                            }
                            const firstIncomingAt = firstIncomingMsgTimestamp < SECONDS_THRESHOLD
                                ? firstIncomingMsgTimestamp * 1000
                                : firstIncomingMsgTimestamp;

                            // Worked out step by step, cheapest first, and stopping at
                            // the first thing that spares them. No `continue` in here:
                            // it would skip the throttle below.
                            let blockReason = "";

                            // Skip active chats protection if enabled and we sent 2+ messages
                            const isActiveChat =
                                window.localStorage.getItem("fg-autoblock-skip-after-two") === "true" &&
                                outgoingCount >= 2;
                            // Nothing from them yet, or their wait is not over.
                            const waitIsOver =
                                firstIncomingMsgTimestamp !== 0 && now - firstIncomingAt >= blockDelayMs;
                            // The no-face-photo rule only covers chats that began after
                            // it was switched on, so switching it on never goes back
                            // through the inbox.
                            const ruleCoversThisChat =
                                !hasPhoto || (noFacePhotoSince != null && firstIncomingAt >= noFacePhotoSince);

                            if (!isActiveChat && waitIsOver && ruleCoversThisChat) {
                                // "Only a face saves them" likewise only for chats that
                                // began after it was switched on; older ones keep the old
                                // rule, where any media saves.
                                const needFace =
                                    needFaceEnabled && needFaceSince != null && firstIncomingAt >= needFaceSince;
                                const mediaKinds: SentMediaFace[] = [];
                                for (const msg of incoming) {
                                    // Without the face option the first piece of media
                                    // settles it, and nothing needs downloading to know.
                                    const isMedia = isMediaTypeMessage(msg);
                                    if (!isMedia) continue;
                                    if (!needFace) {
                                        mediaKinds.push("unknown");
                                        break;
                                    }
                                    const face = await sentMediaFaceFor(msg, conversationId);
                                    if (face) mediaKinds.push(face);
                                    if (face && face !== "no_face") break;
                                }
                                const savedByMedia = sentMediaSaves(mediaKinds, needFace);

                                // This is a "first message" rule, and the messages above are
                                // Grindr's copy of the chat — which restarts when a
                                // conversation is deleted, while GrindFlop keeps its own.
                                // Without this, deleting a chat and letting someone write
                                // again turned their reply into a fresh opener with a fresh
                                // clock, and the photos they had already sent were invisible
                                // to the media check above. Exactly the guard the opener rule
                                // already uses.
                                const hasEarlierIncoming =
                                    !savedByMedia &&
                                    (await readEarlierHistory(conversationId, messages, userId)).hasIncoming;

                                if (savedByMedia) {
                                    if (needFace && !mediaKinds.includes("face")) {
                                        logDetectorDecision({
                                            profileId,
                                            name: displayName,
                                            outcome: "left_alone",
                                            detail: "Could not tell whether what they sent shows a face, so they were not blocked.",
                                        });
                                    }
                                } else if (!hasEarlierIncoming) {
                                    if (!hasPhoto) {
                                        blockReason = mediaKinds.length > 0
                                            ? "Faceless profile: No face in the photos they sent"
                                            : "Faceless profile: No media sent 5min after first message";
                                    } else {
                                        // Only a definite "no face in any photo" goes on. A
                                        // photo that could not be checked, or a face the
                                        // detector is unsure about, is not evidence of
                                        // anything. The answer is remembered, so this costs
                                        // nothing on later passes.
                                        const profileFace = await profileFaceVerdictFor(api, profileId, primaryHash);
                                        if (profileFace === "no_face") {
                                            blockReason = "Faceless profile: No face in profile photos";
                                        } else if (profileFace === "unsure") {
                                            logDetectorDecision({
                                                profileId,
                                                name: displayName,
                                                outcome: "left_alone",
                                                detail: "Could not tell whether their profile photos show a face, so they were not blocked.",
                                            });
                                        }
                                    }
                                }
                            }

                            if (blockReason) {
                                console.log(`[BackgroundInboxScanner] Blocking faceless profile ${profileId} (${displayName}) - ${blockReason}`);
                                const blocked = await blockConversation({
                                    conversation: c,
                                    profileId,
                                    displayName,
                                    reason: blockReason,
                                    messageSnapshot: msgRes,
                                });
                                if (blocked) {
                                    logDetectorDecision({
                                        profileId,
                                        name: displayName,
                                        outcome: "blocked",
                                        detail: blockReason,
                                    });
                                }
                            }

                        } catch (err) {
                            console.warn(`[BackgroundInboxScanner] Faceless check failed for ${conversationId}:`, err);
                        }

                        // Throttle between API calls
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    }
                }

                // --- EXPLICIT PHOTO CATCH-UP PASS ---
                // A photo that arrives while the app is open is checked as it
                // arrives. This is for what arrived while it was closed. Profile
                // photos are checked and blocked on here. Photos sent in unread
                // chats are downloaded, which checks them, and an explicit one is
                // blocked by the explicit-media guard before the chat is opened.
                if (isExplicitCatchUpEnabled) {
                    const since = getExplicitFilterSince();
                    for (const c of conversations) {
                        if (isCancelled) break;
                        const conversationId = c.data?.conversationId;
                        const profileId = getOtherParticipant(c, userId)?.profileId?.toString();
                        if (!conversationId || !profileId || since == null) continue;

                        if (isProfileAutoblockWhitelisted(profileId)) continue;
                        const unreadCount = c.data?.unreadCount ?? 0;
                        const lastActivity = c.data?.lastActivityTimestamp ?? 0;

                        // Their profile photos, for anyone whose message is the latest
                        // in the chat, read or not: someone can open with nothing but
                        // "hey" while the explicit thing is the photo on their profile.
                        // Remembered per person, so later passes cost nothing.
                        const lastSenderId = c.data?.preview?.senderId;
                        if (
                            isExplicitProfileCatchUpEnabled &&
                            lastSenderId != null &&
                            Number(lastSenderId) !== Number(userId)
                        ) {
                            const startedAt = Date.now();
                            const explicitProfilePhoto = await findExplicitProfilePhoto(api, profileId);
                            const decision = decideExplicitBlock({
                                blockingEnabled: true,
                                verdict: verdictOf(explicitProfilePhoto),
                                senderId: profileId,
                                userId,
                                messageTimestamp: lastActivity,
                                filterEnabledAt: since,
                                whitelisted: false,
                                conversationArchived: false,
                            });
                            if (explicitProfilePhoto && decision.block) {
                                const displayName = c.data?.name || profileId;
                                console.log(`[BackgroundInboxScanner] Blocking ${profileId} (${displayName}) for: ${EXPLICIT_PROFILE_PHOTO_REASON}`);
                                const notice = explicitNotice(EXPLICIT_PROFILE_PHOTO_REASON, scoresOf(explicitProfilePhoto));
                                const blocked = await blockConversation({
                                    conversation: c,
                                    profileId,
                                    displayName,
                                    reason: EXPLICIT_PROFILE_PHOTO_REASON,
                                    statsReason: explicitStatsReason(explicitProfilePhoto, EXPLICIT_PROFILE_PHOTO_REASON),
                                    notice,
                                });
                                if (blocked) {
                                    logDetectorDecision({
                                        profileId,
                                        name: displayName,
                                        outcome: "blocked",
                                        detail: notice,
                                    });
                                }
                                await new Promise((resolve) => setTimeout(resolve, 1000));
                                continue;
                            }
                            // Throttle only when the profile was actually read just now.
                            if (Date.now() - startedAt > 50) {
                                await new Promise((resolve) => setTimeout(resolve, 1000));
                            }
                        }

                        if (!isExplicitMediaCatchUpEnabled) continue;
                        // A chat with nothing unread has been opened, and opening a
                        // chat checks the photos sent in it.
                        if (unreadCount === 0) continue;
                        if (explicitCheckedRef.current.get(conversationId) === lastActivity) continue;
                        // One unread message that is not a photo has no photo to check.
                        if (unreadCount === 1 && !previewIsMedia(c)) {
                            explicitCheckedRef.current.set(conversationId, lastActivity);
                            continue;
                        }

                        try {
                            const msgRes = await api.listMessages({ conversationId });
                            for (const msg of msgRes.messages || []) {
                                if (isCancelled) break;
                                if (Number(msg.senderId) === Number(userId)) continue;
                                const sentAt = msg.timestamp < SECONDS_THRESHOLD ? msg.timestamp * 1000 : msg.timestamp;
                                if (sentAt < since) continue;
                                if (msg.type?.toLowerCase().includes("album")) {
                                    // Downloads the album, which checks every item in it.
                                    await captureAlbumsForMessagesNow([msg], conversationId, (albumId) => api.getAlbum(albumId));
                                    continue;
                                }
                                const target = getMediaCaptureTarget(msg);
                                if (!target || target.kind === "audio") continue;
                                await fetchAndStoreMedia({
                                    mediaKey: target.mediaKey,
                                    kind: target.kind,
                                    url: target.url,
                                    conversationId,
                                    messageId: msg.messageId,
                                    viewOnce: target.viewOnce,
                                    isOwnMessage: false,
                                    cacheInMemory: false,
                                    sender: { senderId: msg.senderId, timestamp: msg.timestamp },
                                });
                            }
                            explicitCheckedRef.current.set(conversationId, lastActivity);
                        } catch (err) {
                            console.warn(`[BackgroundInboxScanner] Explicit photo check failed for ${conversationId}:`, err);
                        }

                        // Throttle between API calls
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    }
                }

            } catch (error) {
                console.error("[BackgroundInboxScanner] Scan failed:", error);
            } finally {
                isScanningRef.current = false;
            }

            if (!isCancelled) {
                // Run scanner more frequently when seen-blocker or faceless blocker is active for responsive blocking
                const interval = (isSeenBlockEnabled || isFacelessBlockEnabled || isExplicitCatchUpEnabled) ? 30000 : 60000;
                timeoutRef.current = setTimeout(scanInbox, interval);
            }
        };

        const handleTriggerScan = () => {
            if (triggerScanTimerRef.current) clearTimeout(triggerScanTimerRef.current);
            triggerScanTimerRef.current = setTimeout(() => {
                triggerScanTimerRef.current = null;
                console.log("[BackgroundInboxScanner] Instant scan triggered by setting change");
                scannedProfilesRef.current.clear();
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                void scanInbox();
            }, SCAN_TRIGGER_DEBOUNCE_MS);
        };

        window.addEventListener("fg-trigger-inbox-scan", handleTriggerScan);

        // Delay the first check slightly to let other assets load
        timeoutRef.current = setTimeout(scanInbox, 5000);

        return () => {
            isCancelled = true;
            window.removeEventListener("fg-trigger-inbox-scan", handleTriggerScan);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            if (triggerScanTimerRef.current) clearTimeout(triggerScanTimerRef.current);
            if (pendingMediaBlocksRef.current) {
                for (const timer of pendingMediaBlocksRef.current.values()) {
                    clearTimeout(timer);
                }
                pendingMediaBlocksRef.current.clear();
            }
        };
    }, [api, userId]);

    return null;
}
