/**
 * Keeps the favourite star the same on every screen.
 *
 * The chat list and the chat header read the star from this device's saved
 * chat row; a profile reads it from what Grindr answers for that profile. A
 * star set on one side stayed unknown to the other, and a chat Grindr no
 * longer lists kept whatever star it last had, since no inbox answer would
 * ever correct it. Both sources now pass through here: a favourite added or
 * removed, and every real profile answer, are written to the chat row and
 * announced to whichever screens are open.
 */

import type { ProfileDetail } from "../types/grid";
import { classifyProfileAccess } from "../utils/profileAccessStatus";
import { appLog } from "../utils/logger";
import { setCachedProfileFavorite } from "../pages/app/gridpage/cache";
import * as chatDb from "./chatDb";

export const FAVORITE_CHANGED_EVENT = "fg:favorite-changed";

export type FavoriteChangedDetail = { profileId: string; favorite: boolean };

/**
 * A profile asked for this soon after a tap on the star may still carry the
 * value from before it. Such an answer is not allowed to undo the tap.
 */
export const FAVORITE_SETTLE_MS = 10_000;

export type FavoriteSyncDeps = {
	/** Resolves to whether a chat row had a different star. */
	setChatRowFavorite: (profileId: string, favorite: boolean) => Promise<boolean>;
	setCachedProfileFavorite: (profileId: string, favorite: boolean) => void;
	announce: (detail: FavoriteChangedDetail) => void;
	/** The account whose chats are open now. */
	activeAccount: () => number | null;
	now: () => number;
};

export function createFavoriteSync(deps: FavoriteSyncDeps) {
	const toggledAt = new Map<string, number>();

	return {
		/** Grindr accepted a favourite being added or removed. */
		async toggled(profileId: string, favorite: boolean): Promise<void> {
			toggledAt.set(profileId, deps.now());
			deps.setCachedProfileFavorite(profileId, favorite);
			await deps.setChatRowFavorite(profileId, favorite).catch((error) => {
				appLog.warn("[favorite-sync] could not save the star on the chat", error);
				return false;
			});
			deps.announce({ profileId, favorite });
		},

		/**
		 * Grindr answered for a profile. `owner` and `askedAt` are from before
		 * the request: an answer for another account, or one asked before the
		 * last tap on the star had settled, says nothing about the star now.
		 */
		async seenInProfileAnswer(
			owner: number | null,
			profile: ProfileDetail,
			askedAt: number,
		): Promise<void> {
			if (owner == null || deps.activeAccount() !== owner) return;
			if (typeof profile.isFavorite !== "boolean") return;
			// A blocked or deleted profile answers as an empty shell.
			if (classifyProfileAccess(profile) !== "accessible") return;

			const profileId = String(profile.profileId);
			const lastToggle = toggledAt.get(profileId);
			if (lastToggle !== undefined && askedAt <= lastToggle + FAVORITE_SETTLE_MS) return;

			const changed = await deps
				.setChatRowFavorite(profileId, profile.isFavorite)
				.catch(() => false);
			if (changed) {
				deps.announce({ profileId, favorite: profile.isFavorite });
			}
		},
	};
}

const favoriteSync = createFavoriteSync({
	setChatRowFavorite: chatDb.setConversationFavoriteForProfile,
	setCachedProfileFavorite,
	announce: (detail) => {
		if (typeof window === "undefined") return;
		window.dispatchEvent(
			new CustomEvent<FavoriteChangedDetail>(FAVORITE_CHANGED_EVENT, { detail }),
		);
	},
	activeAccount: chatDb.getActiveChatDbUser,
	now: () => Date.now(),
});

export const favoriteToggled = favoriteSync.toggled;
export const favoriteSeenInProfileAnswer = favoriteSync.seenInProfileAnswer;
