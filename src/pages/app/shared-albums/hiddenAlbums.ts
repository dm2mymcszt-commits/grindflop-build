/**
 * Albums the user deleted from the Shared Albums page while Grindr refused to
 * stop the share. The feed keeps listing those, so they are left out here
 * instead. Per account and per device.
 */
const MAX_HIDDEN = 5_000;

function storageKey(userId: number): string {
	return `fg-album-hidden-${userId}`;
}

export function readHiddenAlbumIds(userId: number | null): Set<number> {
	if (userId == null) return new Set();
	try {
		const raw = localStorage.getItem(storageKey(userId));
		const parsed = raw ? (JSON.parse(raw) as unknown) : null;
		return new Set(Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : []);
	} catch {
		return new Set();
	}
}

export function hideAlbums(userId: number | null, albumIds: number[]): void {
	if (userId == null || albumIds.length === 0) return;
	const hidden = readHiddenAlbumIds(userId);
	for (const albumId of albumIds) {
		// Re-inserted so the newest are the last ones dropped.
		hidden.delete(albumId);
		hidden.add(albumId);
	}
	try {
		localStorage.setItem(storageKey(userId), JSON.stringify([...hidden].slice(-MAX_HIDDEN)));
	} catch {
		// Storage full or unavailable: the album shows again on the next load.
	}
}
