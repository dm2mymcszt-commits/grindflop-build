import { localizeBlockReason } from "./blockReasonText";
import { translate } from "./translate";

/**
 * What an old account knew about each person: whether they wrote, whether
 * they got an answer, and who blocked whom. Built once from the old account's
 * data on this device when moving to a new account, then shown wherever that
 * person turns up again (chat, inbox, profile).
 */

export type PastContact = {
	profileId: string;
	/** The old account this history comes from. */
	sourceProfileId: string;
	displayName: string | null;
	theirMessages: number;
	myMessages: number;
	firstMessageAt: number | null;
	lastMessageAt: number | null;
	/** Their most recent message, shortened, to jog the memory. */
	lastText: string | null;
	/** Set while the old account's last word on it was a block. */
	blockedByMeAt: number | null;
	blockReason: string | null;
	blockedMeAt: number | null;
	/** The old conversation as far as this device kept it, oldest first. */
	messages: PastMessage[];
};

/** One message of the old conversation, reduced to what can still be shown. */
export type PastMessage = {
	at: number;
	mine: boolean;
	text: string;
};

export type PastContactMessage = {
	conversationId: string;
	senderId: string;
	type: string;
	timestamp: number;
	/** Readable text of the message, "" when it has none. */
	text: string;
};

/** A block or unblock from the Stats log, which also carries the reason. */
export type PastContactLoggedBlock = {
	profileId: string;
	blocked: boolean;
	timestamp: number;
	reason: string | null;
};

const PROFILE_ID = /^[1-9]\d{0,19}$/;
const LAST_TEXT_MAX = 140;
/** Newest messages kept per person; the old chats here run to 14 at most. */
export const MAX_PAST_MESSAGES = 50;

// Photo and album links in old messages expire, so they are named instead.
const PLACEHOLDERS: Record<string, string> = {
	Image: "Photo",
	ExpiringImage: "Expiring photo",
	ProfilePhotoReply: "Reply to a profile photo",
	Album: "Shared an album",
	ExpiringAlbum: "Shared an album",
	ExpiringAlbumV2: "Shared an album",
	Video: "Video",
	Audio: "Voice message",
	Location: "Location",
	Gaymoji: "Gaymoji",
	Giphy: "GIF",
};

function messageTextOrPlaceholder(message: PastContactMessage): string {
	const text = message.text.trim();
	if (text) return text;
	return PLACEHOLDERS[message.type] ?? message.type;
}

const MY_BLOCK_TYPES: Record<string, boolean> = {
	SystemBlockedBySelf: true,
	SystemUnblockedBySelf: false,
};
const THEIR_BLOCK_TYPES: Record<string, boolean> = {
	SystemBlocked: true,
	SystemUnblocked: false,
};

/** The other person in a `a:b` conversation id, or null when it isn't one. */
export function otherProfileInConversation(conversationId: string, ownProfileId: string): string | null {
	const parts = conversationId.split(":");
	if (parts.length !== 2) return null;
	const [first, second] = parts;
	if (first === ownProfileId && PROFILE_ID.test(second)) return second;
	if (second === ownProfileId && PROFILE_ID.test(first)) return first;
	return null;
}

function shorten(text: string): string | null {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return null;
	return trimmed.length > LAST_TEXT_MAX ? `${trimmed.slice(0, LAST_TEXT_MAX - 1)}…` : trimmed;
}

type Draft = PastContact & {
	myBlockAt: number;
	myBlockState: boolean | null;
	myUnblockAt: number;
	reasonAt: number;
	theirBlockAt: number;
	theirBlockState: boolean | null;
	lastTextAt: number;
	kept: PastMessage[];
};

function emptyDraft(profileId: string, sourceProfileId: string): Draft {
	return {
		profileId,
		sourceProfileId,
		displayName: null,
		theirMessages: 0,
		myMessages: 0,
		firstMessageAt: null,
		lastMessageAt: null,
		lastText: null,
		blockedByMeAt: null,
		blockReason: null,
		blockedMeAt: null,
		myBlockAt: -1,
		myBlockState: null,
		myUnblockAt: -1,
		reasonAt: -1,
		theirBlockAt: -1,
		theirBlockState: null,
		lastTextAt: -1,
		kept: [],
		messages: [],
	};
}

export function buildPastContacts(input: {
	sourceProfileId: string;
	messages: readonly PastContactMessage[];
	loggedBlocks: readonly PastContactLoggedBlock[];
	displayNames?: ReadonlyMap<string, string>;
}): PastContact[] {
	const { sourceProfileId } = input;
	const drafts = new Map<string, Draft>();
	const draftFor = (profileId: string) => {
		let draft = drafts.get(profileId);
		if (!draft) {
			draft = emptyDraft(profileId, sourceProfileId);
			drafts.set(profileId, draft);
		}
		return draft;
	};
	const noteMyBlock = (draft: Draft, blocked: boolean, at: number, reason: string | null) => {
		if (!blocked) draft.myUnblockAt = Math.max(draft.myUnblockAt, at);
		// A chat marker and its Stats row describe the same block a moment
		// apart, and only the Stats row knows why; keep the newest reason.
		if (blocked && reason != null && at >= draft.reasonAt) {
			draft.reasonAt = at;
			draft.blockReason = reason;
		}
		if (at < draft.myBlockAt) return;
		draft.myBlockAt = at;
		draft.myBlockState = blocked;
	};

	for (const message of input.messages) {
		const profileId = otherProfileInConversation(message.conversationId, sourceProfileId);
		if (!profileId) continue;
		const draft = draftFor(profileId);
		const at = Number.isFinite(message.timestamp) ? message.timestamp : 0;

		if (message.type in MY_BLOCK_TYPES) {
			noteMyBlock(draft, MY_BLOCK_TYPES[message.type], at, null);
			continue;
		}
		if (message.type in THEIR_BLOCK_TYPES) {
			if (at >= draft.theirBlockAt) {
				draft.theirBlockAt = at;
				draft.theirBlockState = THEIR_BLOCK_TYPES[message.type];
			}
			continue;
		}
		if (message.type.startsWith("System")) continue;

		if (message.senderId === sourceProfileId) {
			draft.myMessages += 1;
		} else if (message.senderId === profileId) {
			draft.theirMessages += 1;
			const text = shorten(message.text);
			if (text && at >= draft.lastTextAt) {
				draft.lastText = text;
				draft.lastTextAt = at;
			}
		} else {
			continue;
		}
		draft.kept.push({
			at,
			mine: message.senderId === sourceProfileId,
			text: messageTextOrPlaceholder(message),
		});
		draft.firstMessageAt = draft.firstMessageAt == null ? at : Math.min(draft.firstMessageAt, at);
		draft.lastMessageAt = draft.lastMessageAt == null ? at : Math.max(draft.lastMessageAt, at);
	}

	for (const block of input.loggedBlocks) {
		if (!PROFILE_ID.test(block.profileId) || block.profileId === sourceProfileId) continue;
		noteMyBlock(draftFor(block.profileId), block.blocked, block.timestamp, block.reason);
	}

	const contacts: PastContact[] = [];
	for (const draft of drafts.values()) {
		const blockedByMeAt = draft.myBlockState ? draft.myBlockAt : null;
		const blockedMeAt = draft.theirBlockState ? draft.theirBlockAt : null;
		const hasMessages = draft.theirMessages > 0 || draft.myMessages > 0;
		if (!hasMessages && blockedByMeAt == null && blockedMeAt == null) continue;
		contacts.push({
			profileId: draft.profileId,
			sourceProfileId: draft.sourceProfileId,
			displayName: input.displayNames?.get(draft.profileId) ?? null,
			theirMessages: draft.theirMessages,
			myMessages: draft.myMessages,
			firstMessageAt: draft.firstMessageAt,
			lastMessageAt: draft.lastMessageAt,
			lastText: draft.lastText,
			blockedByMeAt,
			// A reason from before a later unblock belongs to an older block.
			blockReason:
				blockedByMeAt != null && draft.reasonAt >= draft.myUnblockAt ? draft.blockReason : null,
			blockedMeAt,
			messages: draft.kept.sort((a, b) => a.at - b.at).slice(-MAX_PAST_MESSAGES),
		});
	}
	return contacts;
}

export type PastContactSummary = {
	/** One short line for tight spaces such as an inbox row. */
	badge: string;
	/** Full sentences for the chat and profile. */
	lines: string[];
};

function messageCount(count: number): string {
	return translate("past_contact.message_count", {
		defaultValue_one: "{{count}} message",
		defaultValue_other: "{{count}} messages",
		count,
	});
}

export function describePastContact(
	contact: PastContact,
	formatDate: (timestamp: number) => string,
): PastContactSummary {
	const lines: string[] = [];
	const wrote = contact.theirMessages > 0;
	const replied = contact.myMessages > 0;

	if (wrote) {
		const messages = messageCount(contact.theirMessages);
		lines.push(
			contact.lastMessageAt != null
				? translate("past_contact.they_wrote_dated", {
						defaultValue: "Wrote to your old account ({{messages}}, last on {{date}}).",
						messages,
						date: formatDate(contact.lastMessageAt),
					})
				: translate("past_contact.they_wrote", {
						defaultValue: "Wrote to your old account ({{messages}}).",
						messages,
					}),
		);
		lines.push(
			replied
				? translate("past_contact.you_replied", {
						defaultValue: "You replied ({{messages}}).",
						messages: messageCount(contact.myMessages),
					})
				: translate("past_contact.never_replied", { defaultValue: "You never replied." }),
		);
	} else if (replied) {
		lines.push(
			translate("past_contact.you_wrote", {
				defaultValue: "You wrote to them from your old account ({{messages}}).",
				messages: messageCount(contact.myMessages),
			}),
		);
	}
	if (contact.lastText) {
		lines.push(
			translate("past_contact.their_last_message", {
				defaultValue: "Their last message: “{{text}}”",
				text: contact.lastText,
			}),
		);
	}
	if (contact.blockedByMeAt != null) {
		const date = formatDate(contact.blockedByMeAt);
		lines.push(
			contact.blockReason
				? translate("past_contact.you_blocked_reason", {
						defaultValue: "You blocked them on {{date}} — {{reason}}.",
						date,
						// Saved in English; shown in the app's language.
						reason: localizeBlockReason(contact.blockReason),
					})
				: translate("past_contact.you_blocked", { defaultValue: "You blocked them on {{date}}.", date }),
		);
	}
	if (contact.blockedMeAt != null) {
		lines.push(
			translate("past_contact.they_blocked", {
				defaultValue: "They blocked your old account on {{date}}.",
				date: formatDate(contact.blockedMeAt),
			}),
		);
	}

	let badge: string;
	if (contact.blockedByMeAt != null) {
		badge = wrote
			? translate("past_contact.badge.wrote_blocked", { defaultValue: "Old account: wrote · blocked" })
			: translate("past_contact.badge.blocked", { defaultValue: "Old account: blocked" });
	} else if (contact.blockedMeAt != null) {
		badge = translate("past_contact.badge.blocked_you", { defaultValue: "Old account: blocked you" });
	} else if (wrote) {
		badge = replied
			? translate("past_contact.badge.talked", { defaultValue: "Old account: talked" })
			: translate("past_contact.badge.no_reply", { defaultValue: "Old account: no reply" });
	} else {
		badge = translate("past_contact.badge.you_wrote", { defaultValue: "Old account: you wrote" });
	}
	return { badge, lines };
}
