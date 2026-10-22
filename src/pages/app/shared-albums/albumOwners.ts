import { validateMediaHash } from "../../../utils/media";

/**
 * Names and photos of the people who shared albums, remembered from the live
 * feed. Most of them end up blocked and their chats deleted, so once a share
 * ends, a saved album would otherwise have only a profile number to show.
 * Per account and per device; nothing here is needed to open an album.
 */
export type AlbumOwner = {
	name: string | null;
	mediaHash: string | null;
};

const MAX_OWNERS = 2_000;

function storageKey(userId: number): string {
	return `fg-album-owners-${userId}`;
}

export function readAlbumOwners(userId: number | null): Record<string, AlbumOwner> {
	if (userId == null) return {};
	try {
		const raw = localStorage.getItem(storageKey(userId));
		const parsed = raw ? (JSON.parse(raw) as unknown) : null;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, AlbumOwner>) : {};
	} catch {
		return {};
	}
}

export function rememberAlbumOwners(userId: number | null, owners: Record<string, AlbumOwner>): void {
	if (userId == null || Object.keys(owners).length === 0) return;
	const merged = { ...readAlbumOwners(userId) };
	for (const [profileId, owner] of Object.entries(owners)) {
		const previous = merged[profileId];
		// Re-inserted so the newest owners are the last ones dropped.
		delete merged[profileId];
		merged[profileId] = {
			name: owner.name || previous?.name || null,
			mediaHash: owner.mediaHash || previous?.mediaHash || null,
		};
	}
	const entries = Object.entries(merged);
	const kept = entries.length > MAX_OWNERS ? Object.fromEntries(entries.slice(-MAX_OWNERS)) : merged;
	try {
		localStorage.setItem(storageKey(userId), JSON.stringify(kept));
	} catch {
		// Storage full or unavailable: the page falls back to profile numbers.
	}
}

/** The photo hash inside a Grindr image link, e.g. …/images/thumb/320x320/<hash>. */
export function mediaHashFromUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		for (let index = segments.length - 1; index >= 0; index -= 1) {
			const candidate = segments[index].replace(/\.[a-z0-9]+$/i, "");
			if (validateMediaHash(candidate)) return candidate;
		}
	} catch {
		// Not a URL.
	}
	return null;
}
