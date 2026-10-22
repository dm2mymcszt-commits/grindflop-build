/**
 * The conversation that is open on screen right now, if any.
 *
 * The address cannot say which one it is: on a desktop, picking a chat from
 * the list does not change it. So the chat page reports here what it is
 * showing, and the code that decides whether a new message deserves a
 * notification asks here.
 */

let openConversationId: string | null = null;

export function setOpenConversationId(conversationId: string | null): void {
	openConversationId = conversationId || null;
}

export function getOpenConversationId(): string | null {
	return openConversationId;
}
