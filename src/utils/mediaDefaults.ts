/**
 * How the media you send starts out, before you change anything in the send
 * sheet: whether a photo is set to expire, and how long a shared album stays
 * open. Kept on the device. Out of the box nothing expires, which is how the
 * app behaved before these existed.
 */

export const DEFAULT_EXPIRING_PHOTOS_KEY = "fg-default-expiring-photos";
export const DEFAULT_ALBUM_EXPIRATION_KEY = "fg-default-album-expiration";
export const DRAWER_MOST_SENT_FIRST_KEY = "fg-drawer-most-sent-first";

/** Grindr's value for "may be viewed any number of times". */
export const UNLIMITED_VIEWS = 2147483647;

/** The ways Grindr lets access to a shared album run out. */
export const ALBUM_EXPIRATION_TYPES = [
	"INDEFINITE",
	"ONCE",
	"TEN_MINUTES",
	"ONE_HOUR",
	"ONE_DAY",
] as const;

export type AlbumExpirationType = (typeof ALBUM_EXPIRATION_TYPES)[number];

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Storage unavailable: the default simply stays as it is.
	}
}

export function isDefaultExpiringPhotos(): boolean {
	return read(DEFAULT_EXPIRING_PHOTOS_KEY) === "true";
}

export function setDefaultExpiringPhotos(enabled: boolean): void {
	write(DEFAULT_EXPIRING_PHOTOS_KEY, String(enabled));
}

/**
 * How many times a photo about to be sent may be viewed, to start with. An
 * expiring photo opens once, for ten seconds. Videos have their own starting
 * point and are not affected.
 */
export function defaultPhotoMaxViews(): number {
	return isDefaultExpiringPhotos() ? 1 : UNLIMITED_VIEWS;
}

export function parseAlbumExpiration(value: unknown): AlbumExpirationType {
	return (ALBUM_EXPIRATION_TYPES as readonly unknown[]).includes(value)
		? (value as AlbumExpirationType)
		: "INDEFINITE";
}

export function getDefaultAlbumExpiration(): AlbumExpirationType {
	return parseAlbumExpiration(read(DEFAULT_ALBUM_EXPIRATION_KEY));
}

export function setDefaultAlbumExpiration(type: AlbumExpirationType): void {
	write(DEFAULT_ALBUM_EXPIRATION_KEY, type);
}

/**
 * Whether the drawer shows what is sent most often first. On unless turned
 * off; until something has been sent from the drawer it changes nothing.
 */
export function isDrawerMostSentFirst(): boolean {
	return read(DRAWER_MOST_SENT_FIRST_KEY) !== "false";
}

export function setDrawerMostSentFirst(enabled: boolean): void {
	write(DRAWER_MOST_SENT_FIRST_KEY, String(enabled));
}
