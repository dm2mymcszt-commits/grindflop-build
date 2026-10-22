/**
 * blockListSnapshotRules.ts — the pure parts of the block list copy kept on
 * the device (services/blockListSnapshot.ts), so Export still has something
 * to save when Grindr's servers don't answer.
 */

import { normalizeProfileId } from "./blockListImportRules";

export type SavedBlockList = {
	version: 1;
	/** When the list was last changed or read in full from Grindr. */
	savedAt: number;
	/** When Grindr last sent the whole list; null while it was only ever built from single blocks. */
	fullListAt: number | null;
	profileIds: string[];
};

export type BlockChange = { profileId: string; blocked: boolean; at: number };

/** Anything older can't still be missing from a list Grindr sends back. */
export const RECENT_CHANGE_WINDOW_MS = 15 * 60 * 1000;

export function readSavedBlockList(value: unknown): SavedBlockList | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Partial<SavedBlockList>;
	if (record.version !== 1 || !Array.isArray(record.profileIds)) return null;
	return {
		version: 1,
		savedAt: typeof record.savedAt === "number" ? record.savedAt : 0,
		fullListAt: typeof record.fullListAt === "number" ? record.fullListAt : null,
		profileIds: [
			...new Set(
				record.profileIds.map(normalizeProfileId).filter((id): id is string => id !== null),
			),
		],
	};
}

/** Applies blocks and unblocks in the order they happened. */
export function applyBlockChanges(profileIds: readonly string[], changes: readonly BlockChange[]): string[] {
	const ids = new Set(profileIds);
	for (const change of [...changes].sort((a, b) => a.at - b.at)) {
		if (change.blocked) ids.add(change.profileId);
		else ids.delete(change.profileId);
	}
	return [...ids];
}

/**
 * The list Grindr sent, plus the changes made since the request went out,
 * which its answer may not include yet.
 */
export function mergeFullBlockList(
	fromServer: readonly string[],
	requestedAt: number,
	recentChanges: readonly BlockChange[],
): string[] {
	return applyBlockChanges(
		fromServer,
		recentChanges.filter((change) => change.at >= requestedAt),
	);
}

/** Everyone whose latest entry in the Stats block log is a block. */
export function blockedFromStatsLog(
	rows: readonly { profile_id: string | null; event_type: string; timestamp: number }[],
): string[] {
	const latest = new Map<string, { blocked: boolean; at: number }>();
	for (const row of rows) {
		const profileId = normalizeProfileId(row.profile_id);
		if (!profileId) continue;
		const previous = latest.get(profileId);
		if (previous && previous.at > row.timestamp) continue;
		latest.set(profileId, { blocked: row.event_type === "block", at: row.timestamp });
	}
	return [...latest].filter(([, entry]) => entry.blocked).map(([profileId]) => profileId);
}
