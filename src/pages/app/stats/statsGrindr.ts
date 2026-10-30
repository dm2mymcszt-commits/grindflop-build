/**
 * The few things the Stats page asks Grindr for, each fetched at most once
 * per visit (or per Refresh) and only when a section that needs it opens.
 */

import type { createApiFunctions } from "../../../services/apiFunctions";
import { classifyProfileAccess } from "../../../utils/profileAccessStatus";
import { hasRecentSelfBlockActionOnProfile } from "../../../utils/selfBlockActions";
import { resolveUnavailableProfile } from "../../../utils/unavailableProfile";
import type { ProfileDetail } from "../GridPage.types";
import { normalizeTimestamp } from "./statsCompute";

type ApiFunctions = ReturnType<typeof createApiFunctions>;

/**
 * What Grindr says about one person right now. `unreachable`: the check could
 * not finish, so nothing is known either way.
 */
export type PersonState =
	| "open"
	| "you_blocked"
	| "blocked_you"
	| "deleted"
	| "unreachable";

export type PersonLookup = {
	state: PersonState;
	name: string | null;
	imageHash: string | null;
	detail: ProfileDetail | null;
};

export type TapEntry = {
	profileId: string;
	tapType: number | null;
	timestamp: number | null;
	name: string | null;
	imageHash: string | null;
};

export type OwnAlbumShares = {
	albumId: string;
	name: string | null;
	shares: number | null;
};

export type GrindrStats = {
	blockedIds: () => Promise<Set<string>>;
	taps: () => Promise<TapEntry[]>;
	ownAlbums: () => Promise<OwnAlbumShares[]>;
	/** Never rejects. Reading a profile this way does not leave a view. */
	person: (profileId: string) => Promise<PersonLookup>;
	/** The answer already in hand, if this person was asked about. */
	knownPerson: (profileId: string) => PersonLookup | null;
};

function once<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => {
		pending ??= load();
		return pending;
	};
}

/** Albums asked about, at most — one request each. */
const MAX_ALBUMS = 20;

export function createGrindrStats(api: ApiFunctions): GrindrStats {
	const blockedIds = once(
		async () => new Set((await api.getBlockedProfileIds()).map(String)),
	);
	const people = new Map<string, Promise<PersonLookup>>();
	const known = new Map<string, PersonLookup>();

	const lookUp = async (profileId: string): Promise<PersonLookup> => {
		const nothing = { name: null, imageHash: null, detail: null };
		try {
			const detail = await api.getProfileDetail(profileId);
			const access = classifyProfileAccess(detail);
			if (access === "accessible") {
				return {
					state: "open",
					name: detail.displayName?.trim() || null,
					imageHash: detail.profileImageMediaHash ?? null,
					detail,
				};
			}
			if (access === "not_found") return { state: "deleted", ...nothing };
			// The same stub comes back whichever side did the blocking; the
			// profile page reads it by the same rule.
			const mine = await blockedIds();
			const state = resolveUnavailableProfile({
				access,
				blockedByMe: mine.has(profileId),
				selfActedRecently: hasRecentSelfBlockActionOnProfile(profileId),
			});
			return {
				state: state === "you_blocked" || state === "blocked_you" ? state : "unreachable",
				...nothing,
			};
		} catch {
			return { state: "unreachable", ...nothing };
		}
	};

	return {
		blockedIds,
		person: (profileId) => {
			let pending = people.get(profileId);
			if (!pending) {
				pending = lookUp(profileId).then((result) => {
					if (result.state === "unreachable") people.delete(profileId);
					else known.set(profileId, result);
					return result;
				});
				people.set(profileId, pending);
			}
			return pending;
		},
		knownPerson: (profileId) => known.get(profileId) ?? null,
		taps: once(async () => {
			const response = await api.getTaps();
			return response.profiles.flatMap((entry): TapEntry[] => {
				const profileId = entry.profileId ?? entry.senderId;
				if (!profileId) return [];
				const rawTime = entry.timestamp ?? entry.sentOn ?? null;
				return [
					{
						profileId: String(profileId),
						tapType: entry.tapType ?? null,
						timestamp: normalizeTimestamp(
							rawTime == null ? null : Number(rawTime),
						),
						name: entry.displayName?.trim() || null,
						imageHash:
							entry.profileImageMediaHash ??
							entry.photoHash ??
							entry.mediaHash ??
							null,
					},
				];
			});
		}),
		ownAlbums: once(async () => {
			const albums = (await api.getOwnAlbums()).slice(0, MAX_ALBUMS);
			return Promise.all(
				albums.map(async (album) => {
					const shares = await api
						.getAlbumShares({ albumId: String(album.albumId) })
						.then((ids) => ids.length)
						.catch(() => null);
					return {
						albumId: String(album.albumId),
						name: album.albumName ?? null,
						shares,
					};
				}),
			);
		}),
	};
}
