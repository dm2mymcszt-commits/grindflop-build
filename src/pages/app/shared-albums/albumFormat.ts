import type { TFunction } from "i18next";

/** "4 photos · 1 video", leaving out a kind the album has none of. */
export function formatAlbumCounts(t: TFunction, images: number, videos: number): string {
	const parts = [
		images > 0 ? t("shared_albums.photos_count", { count: images }) : null,
		videos > 0 ? t("shared_albums.videos_count", { count: videos }) : null,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : t("shared_albums.items_count", { count: 0 });
}

/** "2h" until the share ends, or null once the time is past or when it never ends. */
export function formatTimeLeftShort(t: TFunction, expiresAt: number | null | undefined, now = Date.now()): string | null {
	if (!expiresAt || expiresAt <= now) return null;
	const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
	return minutes < 60
		? t("shared_albums.minutes_short", { count: minutes })
		: minutes < 48 * 60
			? t("shared_albums.hours_short", { count: Math.round(minutes / 60) })
			: t("shared_albums.days_short", { count: Math.round(minutes / (24 * 60)) });
}

/** "Expires in 2h", or null once the time is past or when the share never ends. */
export function formatTimeLeft(t: TFunction, expiresAt: number | null | undefined, now = Date.now()): string | null {
	const amount = formatTimeLeftShort(t, expiresAt, now);
	return amount ? t("shared_albums.expires_in", { time: amount }) : null;
}
