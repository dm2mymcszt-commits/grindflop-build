/**
 * linkBots.ts — removing link bots' chats once they are blocked.
 *
 * The block itself goes through the usual auto-block path and is kept in the
 * Stats block log. What this adds is the step after it: the archived chat is
 * deleted the way a manual delete of an archived chat does it (the row goes,
 * the saved messages stay), so it no longer sits in the archive. Grindr has
 * already dropped its copy of the conversation with the block, so there is
 * nothing to delete on the server.
 */

import * as chatDb from "./chatDb";
import { clearUnreadCountForProfile } from "./chatContactIndex";
import { appLog } from "../utils/logger";
import { isLinkBotHistory, isLinkBotRuleEnabled, isLinkOnlyMessage, type LinkBotMessage } from "../utils/linkBotMessage";

/** A conversation was deleted outside the chat screen; any mounted chat UI drops it. */
export const CHAT_CONVERSATION_REMOVED_EVENT = "fg:chat-conversation-removed";
export type ChatConversationRemovedDetail = { conversationId: string };

/**
 * Judged on everything known: the saved history plus the messages just
 * fetched or received, which may not be saved yet. A failed read of the
 * saved history counts as "not a bot".
 */
export async function isLinkBotConversation(
	conversationId: string,
	recentMessages: readonly (LinkBotMessage & { messageId?: string | null })[],
	userId: number | string | null | undefined,
): Promise<boolean> {
	const stored = await chatDb.getMessages(conversationId).catch(() => null);
	if (stored == null) return false;
	const byId = new Map<string, LinkBotMessage>();
	let unnamed = 0;
	for (const message of [...stored, ...recentMessages]) {
		const id = (message as { messageId?: string | null }).messageId;
		byId.set(id ? String(id) : `unnamed-${unnamed++}`, message);
	}
	return isLinkBotHistory([...byId.values()], userId);
}

async function deleteLinkBotConversation(conversationId: string, profileId: string | null): Promise<void> {
	await chatDb.deleteConversationOnly(conversationId);
	if (profileId) {
		await clearUnreadCountForProfile(profileId).catch(() => {});
	}
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<ChatConversationRemovedDetail>(CHAT_CONVERSATION_REMOVED_EVENT, {
				detail: { conversationId },
			}),
		);
	}
	appLog.info(`[link-bots] deleted the chat of link bot ${profileId ?? "?"} (${conversationId})`);
}

/**
 * Called right after an auto-block, whatever rule caused it: if the person
 * was a link bot, their now-archived chat is deleted. True when it was.
 */
export async function removeChatIfLinkBot(
	conversationId: string,
	profileId: string | null,
	recentMessages: readonly (LinkBotMessage & { messageId?: string | null })[],
	userId: number | string | null | undefined,
): Promise<boolean> {
	if (!isLinkBotRuleEnabled()) return false;
	try {
		if (!(await isLinkBotConversation(conversationId, recentMessages, userId))) return false;
		await deleteLinkBotConversation(conversationId, profileId);
		return true;
	} catch (error) {
		appLog.warn(`[link-bots] could not delete the chat ${conversationId}`, error);
		return false;
	}
}

/**
 * Deletes the link-bot chats already in the archive: those this account
 * blocked whose whole history is bare links from them. The newest message
 * is checked first, so most chats cost no extra read. Returns how many went.
 */
export async function sweepArchivedLinkBots(userId: number | string | null | undefined): Promise<number> {
	if (!isLinkBotRuleEnabled() || userId == null) return 0;
	const conversations = await chatDb.listConversations({ includeArchived: true }).catch(() => []);
	let removed = 0;
	for (const conversation of conversations) {
		if (!conversation.archived || conversation.blockState !== "blocked_by_me") continue;
		// Their newest message has to be a bare link already; that keeps the
		// full read to the few chats that can qualify.
		const preview = conversation.entry.data.preview;
		if (!preview || Number(preview.senderId) === Number(userId) || !isLinkOnlyMessage(preview.text)) continue;
		if (await removeChatIfLinkBot(conversation.conversationId, conversation.otherProfileId ?? null, [], userId)) {
			removed += 1;
		}
	}
	return removed;
}
