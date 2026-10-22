import { useCallback, useEffect, useMemo, useState } from "react";
import { coverAlbumContent, refreshAlbumChecks } from "../services/albumContentCheck";
import {
	EXPLICIT_FILTER_UPDATED_EVENT,
	isExplicitFilterEnabled,
	subscribeToContentChecks,
} from "../services/contentCheck";
import type { AlbumContentItem } from "../types/chat-page";

/**
 * An open album as the explicit-photo filter lets it be seen: every item
 * still in its place, with the ones not cleared swapped for the hidden tile.
 * `showHidden` puts the real ones back for as long as this album stays open.
 *
 * Listens for checks only while an album is open, and asks for the album's
 * items to be checked when it opens. The result is what both the album grid
 * and the full-screen viewer should be given, so positions match and a
 * hidden item is hidden in both.
 */
export function useVisibleAlbumContent(
	albumId: number | null,
	content: readonly AlbumContentItem[] | null | undefined,
	isOwn: boolean,
): { content: AlbumContentItem[]; hiddenCount: number; showHidden: () => void } {
	const [tick, setTick] = useState(0);
	const [shownAlbumId, setShownAlbumId] = useState<number | null>(null);
	const watching = albumId != null && !isOwn;

	useEffect(() => {
		if (!watching) return;
		const bump = () => setTick((value) => value + 1);
		const unsubscribe = subscribeToContentChecks(bump);
		window.addEventListener(EXPLICIT_FILTER_UPDATED_EVENT, bump);
		return () => {
			unsubscribe();
			window.removeEventListener(EXPLICIT_FILTER_UPDATED_EVENT, bump);
		};
	}, [watching]);

	const itemCount = content?.length ?? 0;
	useEffect(() => {
		if (watching && albumId != null && isExplicitFilterEnabled()) {
			void refreshAlbumChecks(albumId);
		}
	}, [watching, albumId, itemCount]);

	// Remembered per album, so opening another one starts hidden again.
	const showHidden = useCallback(() => setShownAlbumId(albumId), [albumId]);
	const revealed = albumId != null && shownAlbumId === albumId;

	const covered = useMemo(() => {
		if (albumId == null) return { content: content ? [...content] : [], hiddenCount: 0 };
		return coverAlbumContent(albumId, content ?? [], isOwn || revealed);
		// `tick` is the reason to recompute: a check landed or the filter was switched.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [albumId, content, isOwn, revealed, tick]);

	return useMemo(() => ({ ...covered, showHidden }), [covered, showHidden]);
}
