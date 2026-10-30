import type { ConversationEntry } from "../types/messages";

type Participant = ConversationEntry["data"]["participants"][number];

/**
 * The conversation an auto-block writes to chatDb just before blocking.
 *
 * Auto-block paths often build their entry from a realtime message: a name
 * that can be blank and a participant with nothing but an id. Writing that
 * over the stored row wiped the name and profile photo the chat already had,
 * and once the block goes through they cannot be fetched again. So whatever
 * the incoming entry leaves blank is kept from the stored one.
 */
export function mergeConversationForPreserve(
	incoming: ConversationEntry,
	stored: ConversationEntry | null | undefined,
	displayName?: string | null,
): ConversationEntry {
	const name =
		incoming.data.name?.trim() || displayName?.trim() || stored?.data.name?.trim() || "";
	return {
		...incoming,
		data: {
			...incoming.data,
			name,
			participants: mergeParticipants(incoming.data.participants, stored?.data.participants ?? []),
		},
	};
}

function mergeParticipants(
	incoming: readonly Participant[],
	stored: readonly Participant[],
): Participant[] {
	const sameProfile = (a: Participant, b: Participant) => Number(a.profileId) === Number(b.profileId);
	const merged = incoming.map((participant) => {
		const previous = stored.find((candidate) => sameProfile(candidate, participant));
		if (!previous) return participant;
		const result: Record<string, unknown> = { ...previous };
		for (const [key, value] of Object.entries(participant)) {
			if (value !== undefined && value !== null && value !== "") result[key] = value;
		}
		return result as Participant;
	});
	for (const participant of stored) {
		if (!merged.some((candidate) => sameProfile(candidate, participant))) {
			merged.push(participant);
		}
	}
	return merged;
}
