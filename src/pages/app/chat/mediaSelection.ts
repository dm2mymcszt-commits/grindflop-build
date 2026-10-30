import type { UiMessage } from "../../../types/chat-page";
import { translate } from "../../../utils/translate";

/**
 * Picking several photos or videos in a chat, or in its media grid, to save or
 * delete them together. Albums are not included: they are shared, not sent.
 */

export type MediaSelectionItem = {
	/** Null for a saved photo the app never tied to a message; it can be saved but not deleted. */
	messageId: string | null;
	mine: boolean;
	kind: "image" | "video";
	/** Where the bytes come from: a URL, or a saved copy already in hand. */
	source: { url: string } | { base64: string; mimeType: string | null };
};

const IMAGE_OR_VIDEO_TYPES = new Set(["Image", "ExpiringImage", "Video", "PrivateVideo", "NonExpiringVideo"]);
const IMAGE_OR_VIDEO_CHAT1_TYPES = new Set([
	"image",
	"expiring_image",
	"video",
	"privatevideo",
	"private_video",
	"nonexpiringvideo",
	"expiring_video",
]);

/** A photo or video message: not an album, a GIF, a voice note or a profile-photo reply. */
export function isSelectableMediaMessage(message: Pick<UiMessage, "type" | "chat1Type" | "unsent">): boolean {
	if (message.unsent) return false;
	if (IMAGE_OR_VIDEO_TYPES.has(message.type)) return true;
	return IMAGE_OR_VIDEO_CHAT1_TYPES.has(message.chat1Type?.toLowerCase() ?? "");
}

export type MediaDeletionPlan = {
	/** Sent by the user: unsent, so it disappears for both. */
	unsend: string[];
	/** Sent by them: deleted for the user only. */
	deleteForMe: string[];
	/** Saved copies without a message, which have nothing to delete on the server. */
	notDeletable: number;
};

export function planMediaDeletion(items: readonly MediaSelectionItem[]): MediaDeletionPlan {
	const plan: MediaDeletionPlan = { unsend: [], deleteForMe: [], notDeletable: 0 };
	const seen = new Set<string>();
	for (const item of items) {
		if (!item.messageId) {
			plan.notDeletable += 1;
			continue;
		}
		if (seen.has(item.messageId)) continue;
		seen.add(item.messageId);
		(item.mine ? plan.unsend : plan.deleteForMe).push(item.messageId);
	}
	return plan;
}

/** Only unsending needs a confirmation: deleting their photos for yourself touches nothing of theirs. */
export function deletionNeedsConfirmation(plan: MediaDeletionPlan): boolean {
	return plan.unsend.length > 0;
}

export function describeDeletionConfirmation(plan: MediaDeletionPlan): string {
	const count = plan.unsend.length;
	if (plan.deleteForMe.length > 0) {
		return translate("chat.media_delete.confirm_both", {
			defaultValue_one:
				"{{count}} photo or video you sent will be unsent for both of you, and {{theirs}} of theirs deleted for you. They are also removed from this device.",
			defaultValue_other:
				"{{count}} photos and videos you sent will be unsent for both of you, and {{theirs}} of theirs deleted for you. They are also removed from this device.",
			count,
			theirs: plan.deleteForMe.length,
		});
	}
	return translate("chat.media_delete.confirm", {
		defaultValue_one:
			"{{count}} photo or video you sent will be unsent for both of you. They are also removed from this device.",
		defaultValue_other:
			"{{count}} photos and videos you sent will be unsent for both of you. They are also removed from this device.",
		count,
	});
}
