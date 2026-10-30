/**
 * Message id predicates, kept in their own leaf module so anything can ask
 * about an id without pulling in the chat helpers (and, through them, the
 * locale loader, which only exists under Vite and breaks the test runner).
 */

/**
 * An optimistic id this app made up for a message that has not come back
 * from the server yet. Such a message is superseded by the confirmed one
 * under a different id once sending finishes.
 */
export function isLocalClientMessageId(messageId: string): boolean {
	return messageId.startsWith("local:") || messageId.startsWith("local-upload:");
}
