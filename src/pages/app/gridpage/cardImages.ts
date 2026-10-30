import type { BrowseCard } from "../../../types/grid";

/**
 * Grindr's grid endpoint now and then leaves `primaryImageUrl` out of a card
 * that is otherwise complete. A fresh load replaces the whole list, so on a
 * refresh that card flashed from its photo to the no-photo placeholder and
 * back again on the next one. This carries the last photo known for a profile
 * forward until the server sends one again.
 *
 * Kept apart from the other grid helpers so it can be tested without loading
 * them: they reach the locale loader, which exists only under Vite.
 */
export function mergeBrowseCardImages(previous: BrowseCard[], next: BrowseCard[]): BrowseCard[] {
	if (previous.length === 0) {
		return next;
	}

	const previousImageByProfileId = new Map<BrowseCard["profileId"], string>();
	for (const card of previous) {
		if (card.primaryImageUrl) {
			previousImageByProfileId.set(card.profileId, card.primaryImageUrl);
		}
	}

	if (previousImageByProfileId.size === 0) {
		return next;
	}

	return next.map((card) => {
		if (card.primaryImageUrl) {
			return card;
		}
		const previousImageUrl = previousImageByProfileId.get(card.profileId);
		return previousImageUrl ? { ...card, primaryImageUrl: previousImageUrl } : card;
	});
}
