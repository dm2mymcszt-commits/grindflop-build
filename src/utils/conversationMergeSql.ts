/**
 * The statements that fold one conversation's content into another, kept
 * apart from chatDb so that they can be run against a real database in a
 * test: this moves the user's own history and cannot be taken back.
 *
 * See chatDb.mergeConversationInto for what moves, what does not and why.
 */

export type SqlStep = { sql: string; params: unknown[] };

/**
 * A message that is part of what was said, as opposed to one of the notes
 * the app writes into a thread itself ("You blocked this person" and the
 * like, see chatDb.insertSystemMessage).
 */
const IS_CONTENT = "COALESCE(type, '') NOT LIKE 'System%'";

/** How many messages a merge of `sourceConversationId` would move. */
export function countMergeableMessages(sourceConversationId: string): SqlStep {
	return {
		sql: `SELECT COUNT(*) as count FROM messages WHERE conversation_id = $1 AND ${IS_CONTENT}`,
		params: [sourceConversationId],
	};
}

/**
 * The merge, in the order it has to run. Nothing here is one transaction, so
 * the order is the safety: everything is moved before anything is deleted,
 * and the source's own row goes last. Stopped after any step, the source is
 * still there and running the whole list again finishes the job.
 */
export function mergeConversationSteps(
	sourceConversationId: string,
	targetConversationId: string,
	now: number,
): SqlStep[] {
	const move = [sourceConversationId, targetConversationId];
	return [
		{
			sql: "UPDATE media_files SET conversation_id = $2 WHERE conversation_id = $1",
			params: move,
		},
		{
			sql: "UPDATE content_checks SET conversation_id = $2 WHERE conversation_id = $1",
			params: move,
		},
		{
			sql: "UPDATE albums SET conversation_id = $2, updated_at = $3 WHERE conversation_id = $1",
			params: [...move, now],
		},
		{
			// Flagged local history: these exist on this device only, so the
			// thread shows them as such and never asks Grindr about them.
			sql: `UPDATE messages SET conversation_id = $2, local_history = 1, updated_at = $3 WHERE conversation_id = $1 AND ${IS_CONTENT}`,
			params: [...move, now],
		},
		{
			// Only the app's own notes are left under the source by now.
			sql: "DELETE FROM messages WHERE conversation_id = $1",
			params: [sourceConversationId],
		},
		{
			// Keeps the target where it belongs in the list should the merged
			// history be the more recent of the two; usually it is all older
			// and this changes nothing but the row's own stamp.
			sql: `UPDATE conversations
				SET last_activity_timestamp = MAX(
						COALESCE(last_activity_timestamp, 0),
						(SELECT COALESCE(MAX(timestamp), 0) FROM messages WHERE conversation_id = $1 AND ${IS_CONTENT})
					),
					updated_at = $2
				WHERE conversation_id = $1`,
			params: [targetConversationId, now],
		},
		{
			sql: "DELETE FROM conversation_meta WHERE conversation_id = $1",
			params: [sourceConversationId],
		},
		{
			sql: "DELETE FROM conversations WHERE conversation_id = $1",
			params: [sourceConversationId],
		},
	];
}
