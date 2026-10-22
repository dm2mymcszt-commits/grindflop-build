/**
 * selfBlockActions.ts — disambiguates who triggered a block/unblock.
 *
 * chat.v1.conversation.delete (and its offline-fallback equivalents, see
 * conversationArchive.ts) fires identically whether we blocked/unblocked
 * someone or they did it to us. The only local signal we have is timing:
 * mark a conversation right after *we* call the block/unblock API, then
 * check that mark when the resulting event lands.
 */

import { SELF_ACTION_SETTLE_MS } from "./blockAttribution";

export type SelfBlockAction = "block" | "unblock";

const TTL_MS = 60_000;

/**
 * How long after this account's own block/unblock an inaccessible
 * conversation is still assumed to be that action settling server-side.
 *
 * The mark above is consumed by the first event that claims it, but one
 * block or unblock can produce several signals — the websocket delete, a 403
 * on the next message load, a profile lookup that still returns the blocked
 * stub. The later ones arrive with the mark already spent, and every check
 * then points *away* from us: the block list correctly says this account no
 * longer blocks them, so "they blocked me" is what falls out. That is how an
 * unblock turned into "You were blocked" in the same minute.
 */
const SELF_ACTION_GRACE_MS = SELF_ACTION_SETTLE_MS;

const pending = new Map<string, { action: SelfBlockAction; expiresAt: number }>();
/** Unlike `pending`, reading this does not consume it. */
const lastSelfActionAt = new Map<string, number>();

export function markSelfBlockAction(conversationId: string, action: SelfBlockAction): void {
	pending.set(conversationId, { action, expiresAt: Date.now() + TTL_MS });
	lastSelfActionAt.set(conversationId, Date.now());
}

/**
 * Whether this account blocked or unblocked this conversation moments ago —
 * in which case its being unreachable says nothing about what the other side
 * did, and nothing should be attributed to them.
 *
 * A real block by them inside this window is only delayed, not lost: the
 * inbox sweep re-checks and attributes it once it can confirm it. A false one
 * would be a permanent row in their thread.
 */
export function hasRecentSelfBlockAction(conversationId: string): boolean {
	const at = lastSelfActionAt.get(conversationId);
	if (at == null) return false;
	if (Date.now() - at > SELF_ACTION_GRACE_MS) {
		lastSelfActionAt.delete(conversationId);
		return false;
	}
	return true;
}

/**
 * The same grace window, kept per profile for people this account has no
 * conversation with — there is no conversation id to hang the mark on, but
 * their profile still comes back as the blocked stub for a moment after an
 * unblock, and the profile page must not read that as their block.
 */
const lastSelfActionOnProfileAt = new Map<string, number>();

export function markSelfBlockActionOnProfile(profileId: string): void {
	lastSelfActionOnProfileAt.set(String(profileId), Date.now());
}

export function hasRecentSelfBlockActionOnProfile(profileId: string): boolean {
	const key = String(profileId);
	const at = lastSelfActionOnProfileAt.get(key);
	if (at == null) return false;
	if (Date.now() - at > SELF_ACTION_GRACE_MS) {
		lastSelfActionOnProfileAt.delete(key);
		return false;
	}
	return true;
}

/**
 * Returns true (and clears the mark) if the given conversation has a recent,
 * still-valid self-triggered action matching `expectedAction`.
 */
export function consumeSelfBlockAction(
	conversationId: string,
	expectedAction: SelfBlockAction,
): boolean {
	const entry = pending.get(conversationId);
	if (!entry) return false;
	pending.delete(conversationId);
	return entry.expiresAt >= Date.now() && entry.action === expectedAction;
}
