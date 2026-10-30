import type { Message } from "./messages";

export type UiMessage = Message & {
	clientState?: "pending" | "failed";
	_localOnly?: boolean;
	/** Content kept locally despite the server wiping it via unsend. */
	localHistory?: boolean;
};

export type AlbumListItem = {
	albumId: number;
	albumName: string | null;
	isShareable: boolean;
};

export type AlbumContentItem = {
	contentId: number;
	contentType: string | null;
	thumbUrl: string | null;
	url: string | null;
	coverUrl: string | null;
	processing: boolean;
	/** Held back by the explicit-photo filter: its links point at the hidden tile, not at the item. */
	hidden?: boolean;
};

export type AlbumViewerState = {
	albumId: number;
	albumName: string | null;
	content: AlbumContentItem[];
	/** Whether the message that opened this album belongs to the current user — reacting/replying to your own album doesn't make sense, so callers use this to hide those controls. */
	isOwn?: boolean;
	/** How many items of `content` the explicit-photo filter is holding back. */
	hiddenCount?: number;
};

export type InboxFilterKey =
	| "unreadOnly"
	| "favoritesOnly"
	| "chemistryOnly"
	| "rightNowOnly"
	| "onlineNowOnly";

/** Three-way visibility filter for a conversation category (pinned/archived/hidden):
 * "all" mixes it into the normal list, "hide" excludes it, "only" shows exclusively it. */
export type InboxVisibilityFilter = "all" | "hide" | "only";

export type SearchMode = "messages" | "conversations" | "profiles";

export type ProfileSearchResult = {
	profileId: string;
	displayName: string | null;
	profileImageMediaHash: string | null;
	distance: number | null;
};
