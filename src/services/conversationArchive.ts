/**
 * conversationArchive.ts — archive/unarchive a conversation locally, and
 * track the explicit, durable `block_state` (chatDb.ts) that says who
 * blocked whom.
 *
 * Archiving never deletes anything; it's a flag flip in chatDb.ts. A
 * conversation is archived when the server can no longer produce it (404 on
 * open, or a chat.v1.conversation.delete event — which fires for both being
 * blocked and for unblock, so the only reliable way back is the conversation
 * reappearing in a fresh /v4/inbox response, see ChatPage.tsx's loadInbox).
 *
 * `block_state` exists because chat.v1.conversation.delete alone can't tell
 * "we blocked them" from "they blocked us" from "their profile was deleted"
 * — every caller that determines one of those (a self-triggered mutation, a
 * WS event, a 403 while loading a thread, the auto-block-on-spam path)
 * funnels through claimBlockStateTransition, which atomically checks-and-
 * sets it. Because it's a real column checked against the DB (not a
 * time-windowed heuristic), a duplicate signal is recognized as such no
 * matter how much later it arrives — a redelivered event, a stale in-flight
 * request that resolves after the fact, or another call site altogether.
 */

import * as chatDb from "./chatDb";
import { clearUnreadCountForProfile } from "./chatContactIndex";
import type { ArchivedReason, BlockState } from "../types/chat-db";
import type { Message } from "../types/messages";
import { shouldRestoreLoggedBlock, shouldRestoreOwnBlock } from "../utils/blockAttribution";
import { appLog } from "../utils/logger";
import {
	consumeSelfBlockAction,
	hasRecentSelfBlockAction,
	hasRecentSelfBlockActionOnProfile,
	markSelfBlockActionOnProfile,
	markSelfBlockAction,
} from "../utils/selfBlockActions";
import { isStatsEnabled, logBlockEvent } from "./statsLog";

// A synthetic, locally-generated block/unblock marker (see chatDb.insertSystemMessage)
// was inserted — dispatched so any mounted chat UI can append it live.
export const CHAT_SYSTEM_MESSAGE_EVENT = "fg:chat-system-message";
// A conversation's archived flag changed — dispatched so any mounted chat UI
// (which keeps its own in-memory archived-conversations map) can stay in
// sync without needing a bespoke update at every call site.
export const CHAT_ARCHIVE_STATE_EVENT = "fg:chat-archive-state";

// This account blocked someone outside the block mutation (useBlockProfile
// updates the "blocked-profile-ids" cache itself) — an auto-block or a
// counter-block. Dispatched so that cache learns about it right away instead
// of at its next refetch, up to 10 minutes later; until then nothing that
// reads it (the Interest list's blocked badge, the profile page) knows.
export const SELF_BLOCK_EVENT = "fg:self-block";

export type SelfBlockDetail = { profileId: string };

export function announceSelfBlock(profileId: string) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<SelfBlockDetail>(SELF_BLOCK_EVENT, { detail: { profileId: String(profileId) } }),
	);
}

export type ChatArchiveStateChangeDetail =
	| { conversationId: string; archived: true; reason: ArchivedReason }
	| { conversationId: string; archived: false };

function dispatchArchiveStateChange(detail: ChatArchiveStateChangeDetail) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<ChatArchiveStateChangeDetail>(CHAT_ARCHIVE_STATE_EVENT, { detail }),
	);
}

export async function archiveConversation(
	conversationId: string,
	reason: ArchivedReason,
	otherProfileId?: string | null,
): Promise<void> {
	try {
		await chatDb.setConversationArchived(conversationId, true, reason);
		dispatchArchiveStateChange({ conversationId, archived: true, reason });
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("fg:chat-hide-state", {
					detail: { conversationId, hidden: false },
				}),
			);
		}
	} catch (error) {
		appLog.error(`[conversation-archive] failed to archive ${conversationId}`, error);
	}

	// Archiving here always means the server will never offer this conversation
	// as current again (blocked, or the profile is gone). The unread badge drawn
	// on a grid tile and on the profile page comes from a different store keyed
	// by profile id (chat_contact_index), which nothing else clears once the
	// thread is gone rather than genuinely read — so without this, a profile
	// auto-block just archived keeps showing "1 unread" for good.
	const profileId =
		otherProfileId ??
		(await chatDb.getConversation(conversationId).catch(() => null))?.otherProfileId;
	if (profileId) {
		await clearUnreadCountForProfile(profileId).catch(() => {});
	}
}

export async function archiveConversations(
	conversationIds: string[],
	reason: ArchivedReason,
): Promise<void> {
	await Promise.all(
		conversationIds.map((conversationId) => archiveConversation(conversationId, reason)),
	);
}

export async function unarchiveConversation(conversationId: string): Promise<void> {
	try {
		await chatDb.setConversationArchived(conversationId, false, null);
		dispatchArchiveStateChange({ conversationId, archived: false });
	} catch (error) {
		appLog.error(`[conversation-archive] failed to unarchive ${conversationId}`, error);
	}
}

// Synchronous, in-memory pre-claim so two calls racing within the same tick
// (or a few seconds of each other) can't both pass the DB check inside
// claimBlockStateTransition — without this, both could read the
// pre-transition block_state before either had written the new one back.
const CLAIM_TTL_MS = 5_000;
const pendingBlockStateClaim = new Map<string, { target: BlockState | null; at: number }>();

/**
 * Atomically checks-and-sets a conversation's block_state. Returns true only
 * for the one call that actually performs the transition — every other call
 * (racing within the claim TTL, or arriving any time later once block_state
 * already reflects the target) returns false, so callers can gate archiving
 * and system-message insertion on this instead of re-deriving "did this
 * already happen" from timing or message history.
 */
export async function claimBlockStateTransition(
	conversationId: string,
	target: BlockState | null,
): Promise<boolean> {
	const now = Date.now();
	const pending = pendingBlockStateClaim.get(conversationId);
	if (pending && pending.target === target && now - pending.at < CLAIM_TTL_MS) {
		appLog.debug(
			`[conversation-archive] block_state transition to ${target} for ${conversationId} already claimed`,
		);
		return false;
	}
	pendingBlockStateClaim.set(conversationId, { target, at: now });

	const stored = await chatDb.getConversation(conversationId).catch(() => null);
	if ((stored?.blockState ?? null) === target) {
		appLog.debug(
			`[conversation-archive] ${conversationId} already has block_state ${target}`,
		);
		return false;
	}

	await chatDb.setBlockState(conversationId, target);
	return true;
}

// The server (or a flaky WS reconnect) can redeliver the same
// chat.v1.conversation.delete event for a conversation within milliseconds
// of the first one — skip exact redeliveries we've already seen by
// notificationId, and skip any event for a conversation that was processed
// moments ago even if its notificationId is new/null.
const DUPLICATE_EVENT_WINDOW_MS = 15_000;
const lastProcessedAt = new Map<string, number>();
const seenNotificationIds = new Map<string, number>();
const NOTIFICATION_ID_TTL_MS = 10 * 60_000;

function pruneSeenNotificationIds(now: number) {
	for (const [id, seenAt] of seenNotificationIds) {
		if (now - seenAt > NOTIFICATION_ID_TTL_MS) {
			seenNotificationIds.delete(id);
		}
	}
}

/**
 * Lets a caller that just archived/unarchived a conversation directly (e.g.
 * blocking someone from an open chat, applied immediately rather than
 * waiting on the WS round-trip) preempt the matching chat.v1.conversation.delete
 * echo that will still arrive shortly after.
 */
export function markConversationDeleteHandled(conversationId: string): void {
	lastProcessedAt.set(conversationId, Date.now());
}

/**
 * chat.v1.conversation.delete fires for both being blocked and for unblock,
 * with no way to tell which from the payload alone, and also fires when the
 * *other profile* was deleted or banned — not a block at all. Rather than
 * flipping `archived` reactively and guessing the reason afterwards, this
 * determines who's involved first (self marker, the server's own block
 * list, the current `block_state`, and finally a live profile-status check —
 * checkConversationAccessible, when given) and only then archives/unarchives
 * to match. Every actual transition goes through claimBlockStateTransition
 * against the durable `block_state` column, so a duplicate or redelivered
 * signal from any call site, any time later, is always recognized as such
 * instead of leaving a second system message.
 */
// Conversation ids are "{otherProfileId}:{ownProfileId}" (or the reverse —
// whichever isn't our own id is theirs). The stored other_profile_id column
// is only backfilled by upsertConversation from a live /v4/inbox entry's
// participant list, so a conversation that's never been through that yet
// (e.g. one just started, blocked within moments of the first message)
// would otherwise have it null — breaking the isBlockedByMe/
// checkConversationAccessible checks below, which need a profile id to
// check against, silently falling back to the far less reliable
// isProfileFound path instead.
export function deriveOtherProfileIdFromConversationId(
	conversationId: string,
	currentUserId: number | string | null | undefined,
): string | null {
	if (currentUserId == null) return null;
	const parts = conversationId.split(":");
	if (parts.length !== 2) return null;
	const ownId = String(currentUserId);
	if (parts[0] === ownId) return parts[1];
	if (parts[1] === ownId) return parts[0];
	return null;
}

/**
 * A message that arrives over the socket is saved straight away, but the chat
 * only gets its row in `conversations` with the next inbox answer. Someone who
 * writes and then blocks, or whose account is removed, within those seconds
 * leaves a chat with saved messages and no row. Archiving and setting the
 * block state are plain UPDATEs, so on such a chat they changed nothing: it
 * showed in no list at all, although a notification had announced it.
 *
 * This gives that chat its row, built from what was saved, so that archiving
 * it has something to act on. Only when its last message is recent: an older
 * chat without a row is one the user deleted, and must not come back.
 */
const UNLISTED_CHAT_MAX_AGE_MS = 10 * 60_000;

async function listUnlistedChatBeforeArchiving(
	conversationId: string,
	otherProfileId: string | null,
): Promise<boolean> {
	if (!otherProfileId) return false;
	const recovered = await chatDb
		.recoverLatestOrphanedConversationForProfile(otherProfileId)
		.catch(() => null);
	if (!recovered || recovered.conversationId !== conversationId) return false;
	const timestamp = recovered.entry.data.lastActivityTimestamp ?? 0;
	const lastMessageAt = timestamp > 0 && timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
	if (lastMessageAt <= 0 || Math.abs(Date.now() - lastMessageAt) > UNLISTED_CHAT_MAX_AGE_MS) {
		return false;
	}
	try {
		await chatDb.upsertConversation(recovered.entry, otherProfileId);
		appLog.info(
			`[conversation-archive] ${conversationId} had saved messages but no row; listed it so it can be archived`,
		);
		return true;
	} catch (error) {
		appLog.warn(`[conversation-archive] could not list ${conversationId} before archiving`, error);
		return false;
	}
}

export async function toggleArchiveOnConversationDelete(
	conversationIds: string[],
	notificationId?: string | null,
	isProfileFound?: (profileId: string) => Promise<boolean>,
	isBlockedByMe?: (profileId: string) => Promise<boolean>,
	checkConversationAccessible?: (
		profileId: string,
	) => Promise<"accessible" | "not_found" | "blocked">,
	currentUserId?: number | string | null,
): Promise<{ archived: string[]; unarchived: string[]; systemMessages: Message[] }> {
	const archived: string[] = [];
	const unarchived: string[] = [];
	const systemMessages: Message[] = [];
	const now = Date.now();

	if (notificationId) {
		pruneSeenNotificationIds(now);
		if (seenNotificationIds.has(notificationId)) {
			appLog.debug(
				`[conversation-archive] ignoring redelivered notification ${notificationId}`,
			);
			return { archived, unarchived, systemMessages };
		}
		seenNotificationIds.set(notificationId, now);
	}

	const dedupedIds = conversationIds.filter((conversationId) => {
		const last = lastProcessedAt.get(conversationId);
		if (last != null && now - last < DUPLICATE_EVENT_WINDOW_MS) {
			appLog.debug(
				`[conversation-archive] ignoring duplicate conversation.delete for ${conversationId}`,
			);
			return false;
		}
		lastProcessedAt.set(conversationId, now);
		return true;
	});
	// Determines block direction/attribution first, and only then archives
	// or unarchives to match — rather than flipping `archived` reactively and
	// trying to explain the flip afterwards. Only actually inserts a message
	// when claimBlockStateTransition confirms this is a real transition, so
	// a redelivered or independently-arriving duplicate of this same event
	// (from any call site, any time later) is always recognized as such.
	const insertBlockMessage = async (
		conversationId: string,
		type: "SystemBlocked" | "SystemBlockedBySelf" | "SystemUnblocked" | "SystemUnblockedBySelf",
	) => {
		try {
			const message = await chatDb.insertSystemMessage(conversationId, type);
			systemMessages.push(message);
		} catch (error) {
			appLog.error(
				`[conversation-archive] failed to insert system message for ${conversationId}`,
				error,
			);
		}
	};

	await Promise.all(
		dedupedIds.map(async (conversationId) => {
			const existing = await chatDb.getConversation(conversationId).catch(() => null);
			const currentBlockState = existing?.blockState ?? null;
			const otherProfileId =
				existing?.otherProfileId ??
				deriveOtherProfileIdFromConversationId(conversationId, currentUserId);
			if (otherProfileId && !existing?.otherProfileId) {
				void chatDb.backfillOtherProfileId(conversationId, otherProfileId).catch((error) => {
					appLog.warn(
						`[conversation-archive] failed to backfill other_profile_id for ${conversationId}`,
						error,
					);
				});
			}
			// Called right before a branch archives: never for an event that
			// ends up leaving the chat alone.
			const listIfUnlisted = async () => {
				if (!existing) {
					await listUnlistedChatBeforeArchiving(conversationId, otherProfileId);
				}
			};

			// 1. Self-attribution first — always correct regardless of anything
			// else, since it's set by our own mutation before the request even
			// goes out (see useProfileQueries.ts).
			if (consumeSelfBlockAction(conversationId, "block")) {
				if (await claimBlockStateTransition(conversationId, "blocked_by_me")) {
					await archiveConversation(conversationId, "ws_delete", otherProfileId);
					archived.push(conversationId);
					await insertBlockMessage(conversationId, "SystemBlockedBySelf");
				}
				return;
			}
			if (consumeSelfBlockAction(conversationId, "unblock")) {
				if (await claimBlockStateTransition(conversationId, null)) {
					await unarchiveConversation(conversationId);
					unarchived.push(conversationId);
					await insertBlockMessage(conversationId, "SystemUnblockedBySelf");
				}
				return;
			}

			// 2. We already know we're the one who blocked them. A second delete
			// event here isn't necessarily a stale echo of that same block — it's
			// also exactly how an unblock made from *another* device arrives: that
			// device's mutation never set our local self-action marker (only the
			// device that ran the mutation gets one), so step 1 can't catch it.
			// Verify live via isBlockedByMe first, same as the blocked_by_other
			// branch below verifies via checkConversationAccessible, rather than
			// assuming every repeat delivery here means nothing changed.
			if (currentBlockState === "blocked_by_me") {
				const stillBlockedByMe =
					isBlockedByMe && otherProfileId
						? await isBlockedByMe(otherProfileId).catch(() => true)
						: true;
				if (stillBlockedByMe) {
					return;
				}
				if (await claimBlockStateTransition(conversationId, null)) {
					await unarchiveConversation(conversationId);
					unarchived.push(conversationId);
					await insertBlockMessage(conversationId, "SystemUnblockedBySelf");
				}
				return;
			}

			// 3. Cross-device self-block: no local marker exists for a block
			// made from another device/session, but the server's own block
			// list confirms it's us.
			if (
				isBlockedByMe &&
				otherProfileId &&
				(await isBlockedByMe(otherProfileId).catch(() => false))
			) {
				await listIfUnlisted();
				if (await claimBlockStateTransition(conversationId, "blocked_by_me")) {
					await archiveConversation(conversationId, "ws_delete", otherProfileId);
					archived.push(conversationId);
					await insertBlockMessage(conversationId, "SystemBlockedBySelf");
				}
				return;
			}

			// 4. Already known blocked by them — a second event here (not our
			// own unblock, not a self-block confirmation) usually means their
			// unblock, but don't just assume that from a second delivery of
			// this same ambiguous event: verify live first (checkConversationAccessible
			// — displayName "4" means still blocked) so a redelivered/stale
			// event can't be misread as an unblock that never actually happened.
			if (currentBlockState === "blocked_by_other") {
				const stillBlocked =
					checkConversationAccessible && otherProfileId
						? (await checkConversationAccessible(otherProfileId).catch(
								() => "accessible" as const,
							)) === "blocked"
						: false;
				if (stillBlocked) {
					appLog.debug(
						`[conversation-archive] ${conversationId} still shows as blocked — ignoring stale/redelivered delete event`,
					);
					return;
				}
				if (await claimBlockStateTransition(conversationId, null)) {
					await unarchiveConversation(conversationId);
					unarchived.push(conversationId);
				}
				return;
			}

			// 5. Neither side currently known-blocked. Check live whether this
			// event means "blocked" or "profile deleted/banned" before deciding
			// what to do. checkConversationAccessible (GET /v7/profiles/:id) gives
			// a specific blocked-vs-gone signal — isProfileFound (a bulk profile
			// lookup) can't reliably tell those apart, since a backend that also
			// hides blocked-you profiles from generic lookups makes a genuine
			// block look identical to a deletion, silently archiving with the
			// wrong reason and skipping the "You were blocked" marker (and,
			// later, the matching "You were unblocked" one too, since block_state
			// never got set). Falls back to isProfileFound's plain found/not-found
			// when unavailable. Default to "accessible" when neither check is
			// conclusive, which below means leaving the conversation untouched.
			let status: "accessible" | "not_found" | "blocked";
			if (checkConversationAccessible && otherProfileId) {
				status = await checkConversationAccessible(otherProfileId).catch(
					() => "accessible" as const,
				);
			} else {
				const profileFound =
					isProfileFound && otherProfileId
						? await isProfileFound(otherProfileId).catch(() => true)
						: true;
				status = profileFound ? "accessible" : "not_found";
			}

			if (existing?.archived && existing.archivedReason === "not_found") {
				// Was archived because the profile seemed gone, not because of a
				// block. Still not found: nothing changed. Now shows as blocked:
				// this was mis-attributed before (isProfileFound's bulk lookup
				// couldn't tell a block from a deletion, or checkConversationAccessible
				// wasn't available yet at the time) — correct the record properly
				// instead of just silently unarchiving, so it ends up with the
				// right block_state and the "You were blocked" marker it should
				// have had all along. Otherwise genuinely reachable again: a real
				// reappearance.
				if (status === "not_found") {
					return;
				}
				if (status === "blocked") {
					if (await claimBlockStateTransition(conversationId, "blocked_by_other")) {
						await archiveConversation(conversationId, "ws_delete", otherProfileId);
						archived.push(conversationId);
						await insertBlockMessage(conversationId, "SystemBlocked");

						const targetPid = otherProfileId || deriveOtherProfileIdFromConversationId(conversationId, currentUserId);
						if (targetPid && typeof window !== "undefined" && window.localStorage.getItem("fg-autoblock-counter-block") === "true") {
							window.dispatchEvent(new CustomEvent("fg:trigger-counter-block", { detail: { profileId: targetPid, conversationId } }));
						}
					}
					return;
				}
				await unarchiveConversation(conversationId);
				unarchived.push(conversationId);
				return;
			}

			if (status === "not_found") {
				appLog.debug(
					`[conversation-archive] ${conversationId} not found — treating as gone, not a block`,
				);
				if (existing?.archivedReason !== "not_found") {
					await listIfUnlisted();
					await archiveConversation(conversationId, "not_found", otherProfileId);
					archived.push(conversationId);
				}
				return;
			}

			// Only a lookup that says "blocked" is evidence the other party
			// blocked us. The same event fires when this account deletes the
			// conversation somewhere the local marker can't reach — another
			// device, a delete echo arriving late — and on an unblock, and in
			// all of those their profile is simply visible. Treating
			// "accessible" as a block archived those chats with a false "You
			// were blocked" and set counter-block on people who had done
			// nothing. A lookup that failed also lands on "accessible"; a real
			// block missed that way is still caught by the inbox sweep, which
			// acts only on "blocked".
			if (status !== "blocked") {
				appLog.debug(
					`[conversation-archive] ${conversationId} is still visible — a delete or an unblock, not a block; leaving it alone`,
				);
				return;
			}

			// A block or unblock this account made moments ago explains an
			// unreachable chat by itself, and the lookup above cannot tell the
			// two directions apart — it returns the same stub whichever side
			// blocked. After an *unblock* every other check points away from us
			// too, so this is what stops "You unblocked this person" being
			// followed seconds later by "You were blocked". A real block by them
			// in this window is only delayed: the inbox sweep still finds it.
			if (hasRecentSelfBlockAction(conversationId)) {
				appLog.debug(
					`[conversation-archive] ${conversationId} was blocked/unblocked here moments ago — not attributing it to them`,
				);
				return;
			}

			await listIfUnlisted();
			if (await claimBlockStateTransition(conversationId, "blocked_by_other")) {
				await archiveConversation(conversationId, "ws_delete", otherProfileId);
				archived.push(conversationId);
				await insertBlockMessage(conversationId, "SystemBlocked");

				const targetPid = otherProfileId || deriveOtherProfileIdFromConversationId(conversationId, currentUserId);
				if (targetPid && typeof window !== "undefined" && window.localStorage.getItem("fg-autoblock-counter-block") === "true") {
					window.dispatchEvent(new CustomEvent("fg:trigger-counter-block", { detail: { profileId: targetPid, conversationId } }));
				}
			}
		}),
	);
	return { archived, unarchived, systemMessages };
}

/**
 * A conversation showing up as new/changed in a fresh inbox-style response
 * (the foreground `/v4/inbox` poll, or inboxSync's background walk) usually
 * means the other party messaged again, or someone unblocked someone. Only
 * trust that signal for a block-related archive (`ws_delete`) with a
 * block_state still set — an archive for another reason (e.g. "not_found")
 * isn't block-related, and a block_state already cleared means something
 * else (most likely the matching WS event) already resolved this for real,
 * so there's nothing left to reconcile. Returns the system message to
 * broadcast, if any transition actually happened.
 */
export async function reconcileReappearedConversation(
	conversationId: string,
	archivedReason: ArchivedReason | null | undefined,
): Promise<Message | null> {
	if (archivedReason !== "ws_delete") {
		return null;
	}
	const stored = await chatDb.getConversation(conversationId).catch(() => null);
	if (!stored?.blockState) {
		return null;
	}
	if (!(await claimBlockStateTransition(conversationId, null).catch(() => false))) {
		return null;
	}
	await unarchiveConversation(conversationId);
	const isSelf = consumeSelfBlockAction(conversationId, "unblock");
	// Only this account's own unblock is worth a marker; nobody asked to be
	// told when someone else unblocks them.
	if (!isSelf) {
		return null;
	}
	try {
		return await chatDb.insertSystemMessage(conversationId, "SystemUnblockedBySelf");
	} catch (error) {
		appLog.error(
			`[conversation-archive] failed to insert unblocked system message for ${conversationId}`,
			error,
		);
		return null;
	}
}

/**
 * Applies the immediate, local side effects of a self-triggered block/unblock:
 * archives (or unarchives) the conversation with this profile right away
 * instead of waiting on the chat.v1.conversation.delete round-trip, leaves a
 * "You blocked/unblocked this person" marker, and preempts that round-trip's
 * echo so it can't flip the state back. Called from the block/unblock
 * mutations themselves (see useProfileQueries.ts) so every entry point —
 * chat header, grid, profile page, blocked-list settings — behaves the same
 * way, not just the ones that happen to have a chat thread open.
 */
export type ApplySelfBlockActionOptions = {
	/**
	 * Whether a block for a profile that has no conversation *anywhere* may
	 * mint a `direct:<profileId>` stand-in to archive.
	 *
	 * Off unless a caller asks for it. The stand-in is an empty, nameless
	 * archived chat holding nothing but "You blocked this person", and it
	 * turned up in the archive as an "Unknown" conversation nobody ever had.
	 * A block with no conversation belongs in the blocked list, and the block
	 * itself happens either way.
	 */
	materializeMissingConversation?: boolean;
};

export async function applySelfBlockAction(
	profileId: string,
	action: "block" | "unblock",
	options?: ApplySelfBlockActionOptions,
): Promise<void> {
	let stored = await chatDb.findConversationByProfileId(profileId).catch(() => null);
	if (action === "block") {
		// The realtime bridge can receive and persist the triggering message
		// before an inbox metadata row exists. Recover that real server
		// conversation first; otherwise creating `direct:<profileId>` strands
		// the saved content under its original id and archives an empty shell.
		const recovered = await chatDb
			.recoverLatestOrphanedConversationForProfile(profileId)
			.catch(() => null);
		const recoveredTimestamp = recovered?.entry.data.lastActivityTimestamp ?? 0;
		const normalizedRecoveredTimestamp =
			recoveredTimestamp > 0 && recoveredTimestamp < 100_000_000_000
				? recoveredTimestamp * 1000
				: recoveredTimestamp;
		const isRecentAutoBlockMessage =
			normalizedRecoveredTimestamp > 0 &&
			Math.abs(Date.now() - normalizedRecoveredTimestamp) <= 5 * 60_000;
		if (recovered && isRecentAutoBlockMessage) {
			await chatDb.upsertConversation(recovered.entry, profileId);
			stored = await chatDb.getConversation(recovered.conversationId).catch(() => null);
		}
	}
	if (!stored && action === "block") {
		if (options?.materializeMissingConversation !== true) {
			// Nothing local to archive and nothing lost by not archiving: no
			// conversation row, no archived entry, no system message. The block
			// itself was already issued by the caller.
			appLog.debug(
				`[conversation-archive] no conversation for ${profileId} — skipping synthetic archive shell`,
			);
			return;
		}
		const conversationId = `direct:${profileId}`;
		const pidNum = Number(profileId) || 0;
		await chatDb.upsertConversation(
			{
				type: "Conversation",
				data: {
					conversationId,
					name: "",
					participants: pidNum ? [{ profileId: pidNum }] : [],
					lastActivityTimestamp: Date.now(),
					unreadCount: 0,
					pinned: false,
					muted: false,
					favorite: false,
					preview: null,
				},
			},
			profileId,
		).catch(() => {});
		await chatDb.setConversationArchived(conversationId, true, "ws_delete").catch(() => {});
		stored = await chatDb.getConversation(conversationId).catch(() => null);
	}
	if (!stored) {
		return;
	}

	const { conversationId } = stored;
	markConversationDeleteHandled(conversationId);

	// The matching chat.v1.conversation.delete WS event (handled by
	// toggleArchiveOnConversationDelete) can race ahead of this onSuccess
	// callback and get here first — it consults the same onMutate-time self
	// marker, so it already applied this exact transition correctly
	// attributed. claimBlockStateTransition checks the durable block_state
	// column, so this is recognized as a no-op regardless of how that race
	// resolved, or how much later this call lands.
	const claimed = await claimBlockStateTransition(
		conversationId,
		action === "block" ? "blocked_by_me" : null,
	);
	if (!claimed) {
		return;
	}

	if (action === "block") {
		await archiveConversation(conversationId, "ws_delete", profileId);
		await chatDb.setConversationUnreadCount(conversationId, 0).catch(() => {});
	} else {
		await unarchiveConversation(conversationId);
	}

	try {
		const message = await chatDb.insertSystemMessage(
			conversationId,
			action === "block" ? "SystemBlockedBySelf" : "SystemUnblockedBySelf",
		);
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent<Message[]>(CHAT_SYSTEM_MESSAGE_EVENT, { detail: [message] }),
			);
		}
	} catch (error) {
		appLog.error(
			`[conversation-archive] failed to insert self ${action} system message for ${conversationId}`,
			error,
		);
	}
}

// Any incoming WS activity from a profile whose conversation is currently
// archived (typing, a read receipt, a tap, a view, a message) is a live
// signal that they might be reachable again — recheck and pull the
// conversation out of archive if so, rather than waiting for the next
// chat.v1.conversation.delete, inbox reload, or profile-page visit. Cheap in
// the common case: findConversationByProfileId is a local read, and the
// network profile lookup only runs for conversations that are archived.
const RECHECK_COOLDOWN_MS = 30_000;
const lastRecheckedAt = new Map<string, number>();

export async function reconcileArchivedConversationForProfile(
	profileId: string,
	isProfileFound: (profileId: string) => Promise<boolean>,
): Promise<void> {
	const stored = await chatDb.findConversationByProfileId(profileId).catch(() => null);
	if (!stored?.archived) {
		return;
	}
	// Activity never reopens a chat this account archived by blocking. The
	// caller already skips anyone on the server's block list, but Grindr drops
	// blocks on its own (see shouldRestoreOwnBlock), and the lookup below finds
	// a blocked profile just as it finds any other — so the list going quiet
	// was all it took for a blocked chat to come back.
	if (stored.blockState === "blocked_by_me") {
		return;
	}

	const now = Date.now();
	const last = lastRecheckedAt.get(profileId);
	if (last != null && now - last < RECHECK_COOLDOWN_MS) {
		return;
	}
	lastRecheckedAt.set(profileId, now);

	const found = await isProfileFound(profileId).catch(() => false);
	if (!found) {
		return;
	}

	const { conversationId } = stored;
	markConversationDeleteHandled(conversationId);

	const claimed = await claimBlockStateTransition(conversationId, null);
	if (!claimed) {
		return;
	}
	await unarchiveConversation(conversationId);
	// No "you were unblocked" marker: this runs for any archived chat whose
	// profile is visible again, and the user does not want to be told either way.
}

export type RestoreDroppedBlockOutcome = "none" | "restored" | "failed";

/**
 * Puts back a block of this account's that Grindr has stopped applying.
 *
 * Called with real evidence that the person can be reached — their full
 * profile was just read, or a message from them just arrived — and does
 * nothing unless their chat is archived as blocked by this account (see
 * shouldRestoreOwnBlock for what counts). The chat is left exactly as it is:
 * still archived, still "You blocked this person" at the time of the block
 * that was actually made. Only the request to Grindr is repeated, and nothing
 * is added to the Stats log, because no new decision was taken.
 *
 * `blockProfile` is whatever the caller blocks with: the plain request from
 * the profile page, the preserving one where there is a message to keep.
 */
export async function restoreDroppedBlock(input: {
	profileId: string;
	/** When the sign of life happened: a message's own time, or now for a lookup. */
	evidenceAt: number;
	blockProfile: () => Promise<unknown>;
}): Promise<RestoreDroppedBlockOutcome> {
	const profileId = String(input.profileId);
	const stored = await chatDb.findConversationByProfileId(profileId).catch(() => null);
	if (!stored) {
		return restoreLoggedBlock(profileId, input);
	}
	if (
		!shouldRestoreOwnBlock({
			archived: stored.archived,
			knownBlockState: stored.blockState,
			archivedAt: stored.archivedAt,
			evidenceAt: input.evidenceAt,
			selfActedRecently: hasRecentSelfBlockAction(stored.conversationId),
		})
	) {
		return "none";
	}

	const { conversationId } = stored;
	// Marked before the request, like every block this account makes: the
	// delete echo must not be read as their block, and the mark is also what
	// keeps a second sign of life from sending the request again.
	markSelfBlockAction(conversationId, "block");
	markConversationDeleteHandled(conversationId);
	try {
		await input.blockProfile();
	} catch (error) {
		appLog.warn(
			`[conversation-archive] Grindr dropped the block on ${profileId} and it could not be put back`,
			error,
		);
		return "failed";
	}
	// Preserving a message of theirs on the way counts it as unread, and an
	// archived chat is never opened through a path that would clear that.
	await chatDb.setConversationUnreadCount(conversationId, 0).catch(() => {});
	announceSelfBlock(profileId);
	appLog.info(
		`[conversation-archive] Grindr had dropped the block on ${profileId} (${conversationId}); blocked again`,
	);
	return "restored";
}

/**
 * restoreDroppedBlock for someone with no conversation saved here, going by
 * the Stats block log instead (see shouldRestoreLoggedBlock). Without this a
 * person blocked from their profile came back whenever Grindr dropped the
 * block, with nothing on this device left to say they had been blocked.
 */
async function restoreLoggedBlock(
	profileId: string,
	input: { evidenceAt: number; blockProfile: () => Promise<unknown> },
): Promise<RestoreDroppedBlockOutcome> {
	const statsEnabled = isStatsEnabled();
	if (!statsEnabled) return "none";
	const [latest, latestUnblockAllAt] = await Promise.all([
		chatDb.getLatestBlockLogEntry(profileId).catch(() => null),
		chatDb.getLatestUnblockAllTimestamp().catch(() => null),
	]);
	if (
		!shouldRestoreLoggedBlock({
			statsEnabled,
			latest,
			latestUnblockAllAt,
			evidenceAt: input.evidenceAt,
			selfActedRecently: hasRecentSelfBlockActionOnProfile(profileId),
		})
	) {
		return "none";
	}
	// Marked first, as for a conversation: a second sign of life must not
	// send the request again, and the profile page must not read the blocked
	// stub that follows as their block.
	markSelfBlockActionOnProfile(profileId);
	try {
		await input.blockProfile();
	} catch (error) {
		appLog.warn(`[conversation-archive] Grindr dropped the block on ${profileId} and it could not be put back`, error);
		return "failed";
	}
	announceSelfBlock(profileId);
	appLog.info(`[conversation-archive] Grindr had dropped the block on ${profileId} (no saved chat, going by the block log); blocked again`);
	return "restored";
}

/**
 * Cross-checks every local conversation against the server's own blocked-
 * profile-ids list, both directions:
 * - server lists them, we don't know it yet -> archive + block_state =
 *   'blocked_by_me'. Catches a block made on another device while this
 *   device's app wasn't running at all, so no chat.v1.conversation.delete WS
 *   event or 403 ever had a chance to tell it.
 * - we have them marked 'blocked_by_me', server no longer lists them ->
 *   unarchive + clear block_state. Catches an unblock made on another
 *   device (or missed here for any other reason) the same way.
 *
 * Called whenever useBlockedProfileIds' data changes (see
 * ChatRealtimeBridge.tsx) — typically once at app start, and again on any
 * later refetch (staleTime elapsing, or right after our own block/unblock
 * mutations, where it's a cheap no-op since applySelfBlockAction already
 * handled those synchronously). One local table scan, and
 * claimBlockStateTransition is a no-op for every conversation that's
 * already correctly marked, so re-running this on every data change is
 * inexpensive.
 */
export async function reconcileBlockStateWithBlockedList(
	blockedProfileIds: string[],
): Promise<void> {
	const blockedSet = new Set(blockedProfileIds);
	const conversations = await chatDb.listConversations({ includeArchived: true }).catch(() => []);
	const toReconcile = conversations.filter((c) => {
		if (!c.otherProfileId) return false;
		const shouldBeBlockedByMe = blockedSet.has(c.otherProfileId);
		return shouldBeBlockedByMe && c.blockState !== "blocked_by_me";
	});
	if (toReconcile.length === 0) {
		return;
	}

	appLog.debug(
		`[conversation-archive] reconciling ${toReconcile.length} conversation(s) against the server's blocked-profile list`,
	);

	const messages: Message[] = [];
	await Promise.all(
		toReconcile.map(async (conversation) => {
			const claimed = await claimBlockStateTransition(
				conversation.conversationId,
				"blocked_by_me",
			);
			if (!claimed) {
				return;
			}
			try {
				await archiveConversation(conversation.conversationId, "ws_delete");
				const message = await chatDb.insertSystemMessage(
					conversation.conversationId,
					"SystemBlockedBySelf",
				);
				messages.push(message);
			} catch (error) {
				appLog.error(
					`[conversation-archive] failed to insert reconciled block message for ${conversation.conversationId}`,
					error,
				);
			}
		}),
	);

	if (messages.length > 0 && typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<Message[]>(CHAT_SYSTEM_MESSAGE_EVENT, { detail: messages }),
		);
	}
}

// ---------------------------------------------------------------------------
// Counter-block reconciliation
// ---------------------------------------------------------------------------

/**
 * Profile lookups per sweep, across both sources. A block is rare; a slow drip
 * beats a burst of requests.
 */
const MAX_COUNTER_BLOCK_PROBES = 20;

export type CounterBlockReconcileOptions = {
	/** Profile ids the server says this account has blocked. */
	blockedProfileIds: readonly string[];
	currentUserId: number | null;
	blockProfile: (profileId: string) => Promise<unknown>;
	/**
	 * A live profile fetch, classified. Nobody is blocked back unless this
	 * answers "blocked" for them during the sweep.
	 */
	checkConversationAccessible: (
		profileId: string,
	) => Promise<"accessible" | "not_found" | "blocked">;
	/**
	 * Only supplied after a sweep that walked the inbox to its last page.
	 * Without a complete walk, "absent from the inbox" only means "on a page
	 * this run never asked for".
	 */
	missingFromInbox?: {
		sweepStartedAt: number;
	};
};

function counterBlockEnabled(): boolean {
	return (
		typeof window !== "undefined" &&
		window.localStorage.getItem("fg-autoblock-counter-block") === "true"
	);
}

/**
 * Blocks back everyone who has blocked this account, as a sweep rather than a
 * reaction.
 *
 * The live path — a chat.v1.conversation.delete arriving over the websocket —
 * only fires while the app is open, and it counter-blocks by dispatching a DOM
 * event nothing retries. So a block landing overnight was never seen at all,
 * and one whose block request failed was lost with a console warning. Both are
 * repaired here: the state is durable, so re-running is free, and the check
 * against the server's own blocked list is what stops it repeating work.
 *
 * Two sources feed it:
 *  - conversations already attributed to the other party (blocked_by_other)
 *    that this account never blocked back;
 *  - conversations the inbox stopped returning, which is what a block looks
 *    like when nothing was pushed.
 *
 * Neither is acted on unless a live profile fetch says "blocked" outright —
 * never on a lookup that merely failed, and never on "not_found", which is a
 * deleted or banned account rather than someone who blocked you. That holds
 * for the first source too: blocked_by_other can be recorded after a lookup
 * that failed, and trusting it is how deleted accounts got blocked back.
 */
export async function reconcileCounterBlocks(
	options: CounterBlockReconcileOptions,
): Promise<{ counterBlocked: string[] }> {
	const counterBlocked: string[] = [];
	if (!counterBlockEnabled()) {
		return { counterBlocked };
	}

	const alreadyBlocked = new Set(options.blockedProfileIds.map(String));
	const stored = await chatDb
		.listConversations({ includeArchived: true })
		.catch(() => []);

	// One lookup budget for the whole sweep, so confirming stored attributions
	// adds no requests on top of the probing below.
	let probes = 0;
	// "accessible" on a failed lookup is the deliberate default, here and in the
	// live path: never conclude someone blocked you from a request that simply
	// did not come back.
	const isConfirmedBlock = async (profileId: string): Promise<boolean> => {
		probes += 1;
		const status = await options
			.checkConversationAccessible(profileId)
			.catch(() => "accessible" as const);
		return status === "blocked";
	};

	const targets = new Map<string, string>(); // profileId -> conversationId
	for (const conversation of stored) {
		if (conversation.blockState !== "blocked_by_other") continue;
		const profileId =
			conversation.otherProfileId ??
			deriveOtherProfileIdFromConversationId(
				conversation.conversationId,
				options.currentUserId,
			);
		if (!profileId || alreadyBlocked.has(String(profileId))) continue;
		if (targets.has(String(profileId))) continue;
		if (probes >= MAX_COUNTER_BLOCK_PROBES) break;
		if (!(await isConfirmedBlock(String(profileId)))) {
			appLog.debug(
				`[counter-block] ${profileId} not confirmed as blocking this account; not blocking back`,
			);
			continue;
		}
		targets.set(String(profileId), conversation.conversationId);
	}

	if (options.missingFromInbox) {
		const { sweepStartedAt } = options.missingFromInbox;
		const missing = await chatDb
			.listConversationsMissingFromInbox(sweepStartedAt)
			.catch(() => []);
		for (const conversation of missing) {
			if (probes >= MAX_COUNTER_BLOCK_PROBES) break;
			const profileId = conversation.otherProfileId;
			if (!profileId || alreadyBlocked.has(String(profileId))) continue;
			if (targets.has(String(profileId))) continue;
			if (!(await isConfirmedBlock(String(profileId)))) continue;
			if (!(await claimBlockStateTransition(conversation.conversationId, "blocked_by_other"))) {
				continue;
			}
			await archiveConversation(conversation.conversationId, "ws_delete").catch(() => {});
			const message = await chatDb
				.insertSystemMessage(conversation.conversationId, "SystemBlocked")
				.catch(() => null);
			if (message && typeof window !== "undefined") {
				window.dispatchEvent(
					new CustomEvent<Message[]>(CHAT_SYSTEM_MESSAGE_EVENT, { detail: [message] }),
				);
			}
			targets.set(String(profileId), conversation.conversationId);
		}
	}

	for (const [profileId, conversationId] of targets) {
		try {
			await options.blockProfile(profileId);
			logBlockEvent({
				eventType: "block",
				profileId,
				method: "auto",
				source: "counter_block",
				reason: { kind: "counter_block", label: "They blocked you" },
			});
			counterBlocked.push(profileId);
			announceSelfBlock(profileId);
			appLog.info(
				`[counter-block] blocked ${profileId} back for ${conversationId}`,
			);
		} catch (error) {
			// Left for the next sweep rather than swallowed: the conversation
			// keeps its blocked_by_other state, so this retries on its own.
			appLog.warn(
				`[counter-block] could not block ${profileId} back for ${conversationId}; will retry`,
				error,
			);
		}
	}

	return { counterBlocked };
}
