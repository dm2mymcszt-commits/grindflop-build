/**
 * The rules behind "who blocked whom", kept free of storage so they can be
 * tested on their own — the same split as statsLogRules.ts.
 *
 * Getting these wrong is silent and durable: a wrong answer writes a permanent
 * system message into a thread, skews the Stats "Blocked you" figures, and can
 * aim counter-block at someone who never blocked anybody. Both rules below are
 * therefore written to say nothing rather than guess.
 */

import type { BlockState } from "../types/chat-db";

/**
 * Who an inaccessible conversation (a 403 on its messages, a delete event)
 * should be attributed to, or null for "don't attribute it at all".
 *
 *  - An existing block_state settles it. A 403 on an already-blocked
 *    conversation is that same block still in force, not a new event, and
 *    re-deriving attribution there is exactly how an account's own block came
 *    back minutes later as "You were blocked".
 *  - An inconclusive lookup attributes nothing. Both signals fail *towards*
 *    "they blocked me" — a block list request that errors, a conversation
 *    whose other_profile_id was never backfilled — so anything short of a real
 *    answer is left for a later sweep that can confirm it.
 *  - This account's own block or unblock, moments ago, explains the chat being
 *    unreachable on its own. An unblock is the dangerous one: the block list
 *    then correctly says this account does not block them, which reads exactly
 *    like being blocked.
 */
export function resolveBlockAttribution(input: {
	/** The durable record, if this conversation already has one. */
	knownBlockState: BlockState | null;
	/** This device ran the block itself (its own pre-request marker). */
	selfMarked: boolean;
	/** The server's block list says we block them — null when it couldn't answer. */
	blockedByMeLookup: boolean | null;
	/** This account blocked or unblocked this chat within the grace window. */
	selfActedRecently?: boolean;
}): BlockState | null {
	if (input.knownBlockState !== null) return null;
	if (input.selfMarked) return "blocked_by_me";
	if (input.selfActedRecently) return null;
	if (input.blockedByMeLookup === null) return null;
	return input.blockedByMeLookup ? "blocked_by_me" : "blocked_by_other";
}

/**
 * How long this account's own block/unblock is treated as still settling
 * server-side. Shared with selfBlockActions.ts so the live guard and the
 * repair below cannot drift apart.
 */
export const SELF_ACTION_SETTLE_MS = 2 * 60_000;

/**
 * Whether a sign of life from someone — their full profile coming back, a
 * message from them arriving — means Grindr has stopped applying a block this
 * account made, and that block should be put back.
 *
 * Grindr does drop blocks on its own, mostly on accounts it marks as new: the
 * request is accepted, the conversation is deleted, and some minutes or hours
 * later their profile is served in full again and they are gone from the block
 * list. Every check that asks Grindr "is this person still blocked?" then
 * answers no, which is how a chat this account had blocked walked back into
 * the inbox with "You blocked this person" still in it.
 *
 * The chat's own block_state is what says the block was this account's and was
 * never taken back: an unblock here clears it, and one made on another device
 * clears it through the delete event or the synced row. So:
 *  - anything but an archived chat in blocked_by_me is not this rule's business;
 *  - a sign of life from before the block, or from the moments around it, proves
 *    nothing — a message already on its way, a lookup answered before the block
 *    landed;
 *  - nor does one straight after this account's own block or unblock, which is
 *    also what stops a block Grindr refuses outright from being sent in a loop.
 */
export function shouldRestoreOwnBlock(input: {
	archived: boolean;
	/** The durable record on their conversation. */
	knownBlockState: BlockState | null;
	/** When that conversation was archived, i.e. when the block was made. */
	archivedAt: number | null;
	/** When the sign of life happened: a message's own time, or now for a lookup. */
	evidenceAt: number;
	/** This account blocked or unblocked this chat within the grace window. */
	selfActedRecently?: boolean;
	settleMs?: number;
}): boolean {
	if (!input.archived || input.knownBlockState !== "blocked_by_me") return false;
	if (input.selfActedRecently) return false;
	const settleMs = input.settleMs ?? SELF_ACTION_SETTLE_MS;
	if (input.archivedAt != null && input.evidenceAt - input.archivedAt <= settleMs) return false;
	return true;
}

/**
 * The same decision for someone blocked with no conversation to carry the
 * record (blocked from their profile, or a chat that was never saved): the
 * Stats block log is then the only trace of the intent. Their newest logged
 * event has to be this account's block, with no "unblock all" after it, and
 * old enough to be settled. Only read while Stats is on, since an unblock
 * made with Stats off would not be in the log.
 */
export function shouldRestoreLoggedBlock(input: {
	statsEnabled: boolean;
	latest: { eventType: string; timestamp: number } | null;
	/** The newest "unblock all", which is logged without a profile. */
	latestUnblockAllAt: number | null;
	evidenceAt: number;
	selfActedRecently?: boolean;
	settleMs?: number;
}): boolean {
	if (!input.statsEnabled || input.selfActedRecently) return false;
	if (!input.latest || input.latest.eventType !== "block") return false;
	if (input.latestUnblockAllAt != null && input.latestUnblockAllAt >= input.latest.timestamp) return false;
	const settleMs = input.settleMs ?? SELF_ACTION_SETTLE_MS;
	return input.evidenceAt - input.latest.timestamp > settleMs;
}

/** The block/unblock markers a single conversation holds, by timestamp. */
export type ConversationBlockMarkers = {
	blockedByOther: number | null;
	blockedBySelf: number | null;
	unblockedBySelf: number | null;
};

/**
 * Whether a conversation's "You were blocked" marker records a block nobody
 * made — true only when this account's own block was already in force when
 * that marker was written, which is the shape the 403 bug produced.
 *
 * One ordering is always a real block and must survive: they blocked first and
 * this account blocked back.
 *
 * An unblock in between normally means a real block too — it is the only way
 * they could have reached this account again. The exception is a "block" that
 * lands while that unblock is still settling, which is the artifact the live
 * guard now prevents: the chat stays briefly unreachable, and every check then
 * points away from this account. Judged purely on the gap, so a block minutes
 * later is still taken at face value.
 */
/**
 * The block_state a conversation should be left in once its false marker is
 * removed: whatever this account's own last action implies.
 *
 * The false marker overwrote block_state with blocked_by_other, so putting
 * back "blocked_by_me" unconditionally is wrong for the unblock case — the
 * chat would stay archived, and the stored state would contradict the server's
 * block list, which no longer holds that person. null means "not blocked by
 * anyone as far as this account did anything", and lets the normal sweeps
 * re-decide from fresh evidence, including concluding that they really did
 * block you.
 */
export function restoredStateAfterFalseMarker(
	markers: ConversationBlockMarkers,
): BlockState | null {
	const { blockedBySelf, unblockedBySelf } = markers;
	if (blockedBySelf == null) return null;
	return unblockedBySelf != null && unblockedBySelf > blockedBySelf ? null : "blocked_by_me";
}

export function isFalseBlockedByOtherMarker(
	markers: ConversationBlockMarkers,
	settleMs: number = SELF_ACTION_SETTLE_MS,
): boolean {
	const { blockedByOther, blockedBySelf, unblockedBySelf } = markers;
	if (blockedByOther == null || blockedBySelf == null) return false;
	if (blockedByOther <= blockedBySelf) return false;
	if (
		unblockedBySelf != null &&
		unblockedBySelf > blockedBySelf &&
		unblockedBySelf < blockedByOther
	) {
		return blockedByOther - unblockedBySelf <= settleMs;
	}
	return true;
}
