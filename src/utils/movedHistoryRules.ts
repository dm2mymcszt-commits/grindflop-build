/**
 * Re-homing an old account's history under the account it is moved to, so
 * Stats can count both as one person's history.
 *
 * The moved rows live in their own tables and are only ever read by Stats.
 * They must never go into `messages`: the chat code adopts messages that
 * have no conversation row ("orphans") as a real conversation, which would
 * bring the old account's chats back to life in the new one.
 */

const PROFILE_ID = /^[1-9]\d{0,19}$/;

/**
 * The same conversation as the new owner would have it with that person.
 * Grindr orders the two ids numerically, smaller first. Null when the id is
 * not a conversation of `oldOwner`.
 */
export function rehomeConversationId(
	conversationId: string,
	oldOwner: string,
	newOwner: string,
): string | null {
	const parts = conversationId.split(":");
	if (parts.length !== 2) return null;
	const other = parts[0] === oldOwner ? parts[1] : parts[1] === oldOwner ? parts[0] : null;
	if (other == null || !PROFILE_ID.test(other) || other === newOwner) return null;
	// Ids are digits with no leading zero, so the shorter one is the smaller.
	const otherIsSmaller =
		other.length !== newOwner.length ? other.length < newOwner.length : other < newOwner;
	return otherIsSmaller ? `${other}:${newOwner}` : `${newOwner}:${other}`;
}

function rehomeReactions(reactionsJson: unknown, oldOwner: string, newOwner: string): unknown {
	if (typeof reactionsJson !== "string" || !reactionsJson) return reactionsJson;
	try {
		const reactions = JSON.parse(reactionsJson) as unknown;
		if (!Array.isArray(reactions)) return reactionsJson;
		return JSON.stringify(
			reactions.map((reaction) =>
				reaction && typeof reaction === "object" && String((reaction as { profileId?: unknown }).profileId) === oldOwner
					? { ...reaction, profileId: Number(newOwner) }
					: reaction,
			),
		);
	} catch {
		return reactionsJson;
	}
}

/**
 * A stored message row as the new owner's history: the conversation id is
 * re-homed and anything the old owner sent or reacted with becomes the new
 * owner's. Null for a row that isn't one of the old owner's conversations.
 */
export function rehomeMessageRow(
	row: Readonly<Record<string, unknown>>,
	oldOwner: string,
	newOwner: string,
): Record<string, unknown> | null {
	const conversationId = rehomeConversationId(String(row.conversation_id ?? ""), oldOwner, newOwner);
	if (conversationId == null || row.message_id == null) return null;
	return {
		...row,
		conversation_id: conversationId,
		sender_id: String(row.sender_id) === oldOwner ? Number(newOwner) : row.sender_id,
		reactions_json: rehomeReactions(row.reactions_json, oldOwner, newOwner),
	};
}
