/**
 * Keeps the "last online" and the distance of a saved chat up to date from
 * what Grindr answers for that person's profile.
 *
 * Every chat Grindr still lists gets both from the inbox answer. A chat it
 * no longer lists (shown from this device's copy) gets nothing: it kept the
 * distance and the last-online time of the day it was last listed, next to a
 * profile that showed the current ones.
 */

import type { ProfileDetail } from "../types/grid";
import type { ConversationEntry } from "../types/messages";
import { classifyProfileAccess } from "../utils/profileAccessStatus";
import * as chatDb from "./chatDb";

export const CHAT_PRESENCE_CHANGED_EVENT = "fg:chat-presence-changed";

type Participant = ConversationEntry["data"]["participants"][number];

export type ChatPresence = Pick<Participant, "lastOnline" | "onlineUntil" | "distanceMetres">;

export type ChatPresenceChangedDetail = { profileId: string; presence: ChatPresence };

/** A distance moving by less than this is not worth writing down. */
const DISTANCE_STEP_METRES = 1;

const isRealTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * What a profile answer changes about a chat participant, or null when it
 * changes nothing. A value the answer does not carry (hidden, or masked as
 * 0) leaves what the chat has: old information beats none. A last-online
 * time older than the chat's is never written, since it cannot go backwards.
 */
export function presenceFromProfileAnswer(
	participant: ChatPresence,
	profile: Pick<ProfileDetail, "seen" | "onlineUntil" | "distance">,
): ChatPresence | null {
	const next: ChatPresence = {
		lastOnline: participant.lastOnline ?? null,
		onlineUntil: participant.onlineUntil ?? null,
		distanceMetres: participant.distanceMetres ?? null,
	};
	let changed = false;

	if (isRealTime(profile.seen) && profile.seen >= (next.lastOnline ?? 0)) {
		const onlineUntil = isRealTime(profile.onlineUntil) ? profile.onlineUntil : null;
		if (next.lastOnline !== profile.seen || next.onlineUntil !== onlineUntil) {
			next.lastOnline = profile.seen;
			next.onlineUntil = onlineUntil;
			changed = true;
		}
	}

	const distance = profile.distance;
	if (
		typeof distance === "number" &&
		Number.isFinite(distance) &&
		distance >= 0 &&
		(next.distanceMetres == null ||
			Math.abs(next.distanceMetres - distance) >= DISTANCE_STEP_METRES)
	) {
		next.distanceMetres = distance;
		changed = true;
	}

	return changed ? next : null;
}

/**
 * Grindr answered for a profile. `owner` is the account from before the
 * request: an answer that arrives after an account switch is not written to
 * the other account's chats.
 */
export async function presenceSeenInProfileAnswer(
	owner: number | null,
	profile: ProfileDetail,
): Promise<void> {
	if (owner == null || chatDb.getActiveChatDbUser() !== owner) return;
	// A blocked or deleted profile answers as an empty shell.
	if (classifyProfileAccess(profile) !== "accessible") return;

	const profileId = String(profile.profileId);
	const presence = await chatDb
		.updateConversationPresenceForProfile(profileId, (participant) =>
			presenceFromProfileAnswer(participant, profile),
		)
		.catch(() => null);
	if (presence && typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<ChatPresenceChangedDetail>(CHAT_PRESENCE_CHANGED_EVENT, {
				detail: { profileId, presence },
			}),
		);
	}
}
