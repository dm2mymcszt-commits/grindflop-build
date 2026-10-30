import type { SharedAlbum } from "./albums";
import type { AlbumContentItem } from "./chat-page";

export type SharedAlbumItem = {
	profileId: number;
	profileName: string;
	profileMediaHash: string | null;
	/** The feed's own link to the owner's photo, for when there is no hash. */
	profileImageUrl: string | null;
	conversationId: string | null;
	album: SharedAlbum;
	albumNumber: number;
	totalAlbumsShared?: number;
	/** No longer in the live feed; opens the copy saved on this device. */
	localOnly?: boolean;
	/** Items whose file is stored on this device. */
	savedCount: number;
	isOnline?: boolean;
	hasUnseenContent?: boolean;
	/** The feed's albumViewable: false when Grindr has locked the album for this account. */
	isViewable?: boolean;
	/** Epoch ms when the share ends, if it does. */
	expiresAt?: number | null;
};

export type AlbumViewer = {
	item: SharedAlbumItem;
	albumName: string | null;
	status: "loading" | "ready" | "error";
	content: AlbumContentItem[];
	/** Why the album could not be shown, when status is "error". */
	error: string | null;
	/** Showing the copy saved on this device because the live album would not load. */
	isSavedCopy: boolean;
	/** How many items of `content` the explicit-photo filter is holding back. */
	hiddenCount?: number;
};
