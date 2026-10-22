/**
 * What to say about a profile Grindr will not show, kept free of storage and
 * network so it can be tested on its own — the same split as
 * blockAttribution.ts, and for the same reason: the "4" stub looks identical
 * whichever side did the blocking, so who it was has to come from elsewhere.
 */

import type { BlockState } from "../types/chat-db";
import type { ProfileAccessStatus } from "./profileAccessStatus";

/**
 * `blocked_unknown`: there is a block, but nothing in hand says whose. Shown
 * as exactly that rather than guessed at.
 */
export type UnavailableProfileState =
	| "you_blocked"
	| "blocked_you"
	| "deleted"
	| "blocked_unknown";

/**
 * Null when the profile is there to be shown.
 *
 *  - The server's block list is the answer when it has one. Holding them means
 *    this account blocks them, whatever else is also true. Not holding them,
 *    while their profile still comes back as the stub, leaves only their block.
 *  - Except straight after this account's own block or unblock: the stub can
 *    outlive an unblock for a moment, and the list then correctly says this
 *    account no longer blocks them, which reads exactly like being blocked.
 *  - A list that says "not blocked by you" against a saved "blocked by me" is
 *    one of the two being stale. Neither is believed.
 *  - Without the list, the chat's saved block state is the only other source.
 */
export function resolveUnavailableProfile(input: {
	access: ProfileAccessStatus;
	/** The server's block list holds them — null when it couldn't answer. */
	blockedByMe: boolean | null;
	/** The durable record on their conversation, if there is one. */
	knownBlockState?: BlockState | null;
	/** This account blocked or unblocked them within the grace window. */
	selfActedRecently?: boolean;
}): UnavailableProfileState | null {
	if (input.access === "accessible") return null;
	if (input.access === "not_found") return "deleted";

	const knownBlockState = input.knownBlockState ?? null;
	if (input.blockedByMe === true) return "you_blocked";
	if (input.selfActedRecently) return "blocked_unknown";
	if (input.blockedByMe === false) {
		return knownBlockState === "blocked_by_me" ? "blocked_unknown" : "blocked_you";
	}
	if (knownBlockState === "blocked_by_me") return "you_blocked";
	if (knownBlockState === "blocked_by_other") return "blocked_you";
	return "blocked_unknown";
}

/** What this device already knows about someone, from wherever it was kept. */
export type KnownProfile = {
	name?: string | null;
	imageHash?: string | null;
	/** A ready-made picture address, for sources that never had the hash. */
	imageUrl?: string | null;
};

/**
 * Whether a saved name is worth showing. "3" and "4" are the stub's own
 * placeholders, and have been saved as a chat's name before; a real person
 * could be called that, but far more often it is the stub leaking through.
 */
export function isUsableProfileName(name: string | null | undefined): name is string {
	const trimmed = name?.trim();
	return Boolean(trimmed) && trimmed !== "3" && trimmed !== "4";
}

/**
 * The first usable name and the first picture across the sources, most
 * trusted first. Name and picture are picked independently: the chat may
 * remember the name while only the viewers list kept a photo.
 */
export function pickKnownProfile(
	candidates: ReadonlyArray<KnownProfile | null | undefined>,
): { name: string | null; imageHash: string | null; imageUrl: string | null } {
	let name: string | null = null;
	let imageHash: string | null = null;
	let imageUrl: string | null = null;
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (name === null && isUsableProfileName(candidate.name)) {
			name = candidate.name.trim();
		}
		if (imageHash === null && imageUrl === null) {
			const hash = candidate.imageHash?.trim();
			const url = candidate.imageUrl?.trim();
			if (hash) imageHash = hash;
			else if (url) imageUrl = url;
		}
	}
	return { name, imageHash, imageUrl };
}
