/**
 * Folding an archived conversation into a current one, so that the chat with
 * someone's old profile and the chat with their new one read as a single
 * thread. chatDb.mergeConversationInto moves the rows; this is the check in
 * front of it and the event behind it, the same shape conversationArchive.ts
 * uses for CHAT_ARCHIVE_STATE_EVENT.
 */

import * as chatDb from "./chatDb";
import { appLog } from "../utils/logger";

export const CHAT_MERGE_EVENT = "fg:chat-merge";

export type ChatMergeDetail = {
	sourceConversationId: string;
	targetConversationId: string;
	movedMessages: number;
};

function dispatchMerge(detail: ChatMergeDetail) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<ChatMergeDetail>(CHAT_MERGE_EVENT, { detail }));
}

/**
 * Only archived into current. A current conversation has a counterpart on
 * Grindr that keeps receiving messages of its own, so merging one live chat
 * into another would start coming apart again with the next message.
 */
export async function mergeArchivedConversationIntoActive(
	sourceConversationId: string,
	targetConversationId: string,
): Promise<ChatMergeDetail> {
	if (sourceConversationId === targetConversationId) {
		throw new Error("Cannot merge a conversation into itself");
	}

	const [source, target] = await Promise.all([
		chatDb.getConversation(sourceConversationId),
		chatDb.getConversation(targetConversationId),
	]);

	if (!source) {
		throw new Error("Source conversation not found");
	}
	if (!source.archived) {
		throw new Error("Only archived conversations can be merged");
	}
	if (!target) {
		throw new Error("Target conversation not found");
	}
	if (target.archived) {
		throw new Error("Cannot merge into an archived conversation");
	}

	const { movedMessages } = await chatDb.mergeConversationInto(
		sourceConversationId,
		targetConversationId,
	);

	appLog.info(
		`[conversation-merge] moved ${movedMessages} message(s) from ${sourceConversationId} into ${targetConversationId}`,
	);

	const detail: ChatMergeDetail = { sourceConversationId, targetConversationId, movedMessages };
	dispatchMerge(detail);
	return detail;
}
