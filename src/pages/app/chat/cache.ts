import type { ConversationEntry, Message } from "../../../types/messages";
import type {
	IndexedConversation,
	IndexedMessage,
	ScoredResult,
} from "../../../types/chat-cache";
import { getMessageText } from "../../../utils/messageText";
import { isLocalClientMessageId } from "../../../utils/messageIds";

const conversationIndex = new Map<string, IndexedConversation>();
const messageIndex = new Map<string, IndexedMessage>();
const revisionListeners = new Set<() => void>();
let revision = 0;

function publishRevision(): void {
	revision += 1;
	for (const listener of revisionListeners) {
		listener();
	}
}

function normalize(input: string): string {
	return input.trim().toLowerCase();
}

function scoreMatch(haystack: string, needle: string): number {
	const startsWith = haystack.startsWith(needle) ? 60 : 0;
	const index = haystack.indexOf(needle);
	if (index < 0) {
		return -1;
	}
	const proximity = Math.max(0, 40 - index);
	return startsWith + proximity;
}

function addConversationsToIndex(entries: ConversationEntry[]): void {
	for (const entry of entries) {
		const conversationId = entry.data.conversationId;
		const name = entry.data.name ?? "Unknown";
		const preview = entry.data.preview?.text ?? "";
		const searchText = normalize(`${name} ${preview}`);

		conversationIndex.set(conversationId, {
			conversationId,
			name,
			preview,
			searchText,
		});
	}
}

function addMessagesToIndex(messages: Message[]): void {
	for (const message of messages) {
		// An optimistic local id (local:/local-upload:) is replaced by the
		// server-confirmed message under a different id once sending finishes,
		// but that swap happens in thread state, not here: this index is a
		// module-level Map nothing prunes, so indexing the local id would leave
		// a duplicate that search keeps matching for the rest of the session.
		if (isLocalClientMessageId(message.messageId)) {
			continue;
		}

		const text = getMessageText(message);
		if (!text) {
			// An unsend/content deletion must evict an older searchable copy.
			messageIndex.delete(message.messageId);
			continue;
		}

		messageIndex.set(message.messageId, {
			messageId: message.messageId,
			conversationId: message.conversationId,
			senderId: message.senderId,
			timestamp: message.timestamp,
			text,
			searchText: normalize(text),
		});
	}
}

export function indexConversations(entries: ConversationEntry[]): void {
	addConversationsToIndex(entries);
	publishRevision();
}

export function indexMessages(messages: Message[]): void {
	addMessagesToIndex(messages);
	publishRevision();
}

/**
 * Atomically replaces the process-local search snapshot after a durable
 * database refresh. Unlike the incremental indexers used by live chat, this
 * removes rows deleted on another device before notifying search surfaces.
 */
export function replaceChatSearchIndex(
	entries: ConversationEntry[],
	messages: Message[],
): void {
	conversationIndex.clear();
	messageIndex.clear();
	addConversationsToIndex(entries);
	addMessagesToIndex(messages);
	publishRevision();
}

export function clearChatSearchIndex(): void {
	conversationIndex.clear();
	messageIndex.clear();
	publishRevision();
}

export function getChatSearchIndexRevision(): number {
	return revision;
}

export function subscribeChatSearchIndex(listener: () => void): () => void {
	revisionListeners.add(listener);
	return () => {
		revisionListeners.delete(listener);
	};
}

export function searchConversationsLocal(query: string, limit = 24) {
	const needle = normalize(query);
	if (!needle) {
		return [];
	}

	const scored: ScoredResult<IndexedConversation>[] = [];
	for (const item of conversationIndex.values()) {
		const score = scoreMatch(item.searchText, needle);
		if (score >= 0) {
			scored.push({ score, item });
		}
	}

	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.item);
}

export function searchMessagesLocal(
	query: string,
	options?: {
		conversationId?: string;
		limit?: number;
	},
) {
	const needle = normalize(query);
	if (!needle) {
		return [];
	}

	const limit = options?.limit ?? 40;
	const scored: ScoredResult<IndexedMessage>[] = [];
	for (const item of messageIndex.values()) {
		if (
			options?.conversationId &&
			item.conversationId !== options.conversationId
		) {
			continue;
		}

		const score = scoreMatch(item.searchText, needle);
		if (score >= 0) {
			scored.push({ score, item });
		}
	}

	return scored
		.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			return b.item.timestamp - a.item.timestamp;
		})
		.slice(0, limit)
		.map((entry) => entry.item);
}
