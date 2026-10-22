import { useEffect, useMemo, useState } from "react";
import { useApiFunctions } from "./useApiFunctions";
import { useBlockedProfileIds } from "./queries/useProfileQueries";
import {
	lookUpLocalProfile,
	readProfileCard,
	type LocalProfileKnowledge,
} from "../services/knownProfile";
import type { ProfileCopy } from "../services/profileCopyStore";
import type { BlockExplanation } from "../utils/blockExplanation";
import { getThumbImageUrl, validateMediaHash } from "../utils/media";
import type { ProfileAccessStatus } from "../utils/profileAccessStatus";
import {
	hasRecentSelfBlockAction,
	hasRecentSelfBlockActionOnProfile,
} from "../utils/selfBlockActions";
import {
	pickKnownProfile,
	resolveUnavailableProfile,
	type KnownProfile,
	type UnavailableProfileState,
} from "../utils/unavailableProfile";

export type UnavailableProfile = {
	state: UnavailableProfileState;
	/** Still reading what decides `state`; say nothing about it yet. */
	isResolving: boolean;
	name: string | null;
	photoUrl: string | null;
	/** Their chat on this device, if there is one to go back to. */
	conversationId: string | null;
	/** Their whole profile as this device last read it, when it was saved. */
	savedCopy: ProfileCopy | null;
	/** How and why this account blocked them, when the Stats log recorded it. */
	blockExplanation: BlockExplanation | null;
};

/**
 * Everything the "this profile can't be shown" screen needs, or null while
 * the profile is (or may still be) there to show.
 *
 * `access` is what the latest GET /v7/profiles/:id said — null until it has
 * answered. `hint` is whatever the place that opened the profile already had
 * for this person; it is trusted ahead of anything looked up here.
 */
export function useUnavailableProfile(input: {
	profileId: string | null;
	access: ProfileAccessStatus | null;
	hint?: KnownProfile | null;
}): UnavailableProfile | null {
	const { profileId, access, hint } = input;
	const apiFunctions = useApiFunctions();
	const { data: blockedProfileIdsData, isPending: isBlockListPending } = useBlockedProfileIds();
	const isUnavailable = access === "blocked" || access === "not_found";

	const [local, setLocal] = useState<
		(LocalProfileKnowledge & { profileId: string }) | null
	>(null);
	const [live, setLive] = useState<{ profileId: string; card: KnownProfile } | null>(null);

	useEffect(() => {
		if (!profileId || !isUnavailable) {
			setLocal(null);
			return;
		}
		let cancelled = false;
		void lookUpLocalProfile(profileId)
			.catch(() => ({
				conversationId: null,
				blockState: null,
				candidates: [],
				savedCopy: null,
				blockExplanation: null,
			}))
			.then((knowledge) => {
				if (!cancelled) setLocal({ ...knowledge, profileId });
			});
		return () => {
			cancelled = true;
		};
	}, [profileId, isUnavailable]);

	const localForProfile = local && local.profileId === profileId ? local : null;
	const liveForProfile = live && live.profileId === profileId ? live.card : null;

	const blockedByMe = useMemo(() => {
		if (!profileId || !blockedProfileIdsData) return null;
		return blockedProfileIdsData.includes(profileId);
	}, [blockedProfileIdsData, profileId]);

	const state =
		profileId && access
			? resolveUnavailableProfile({
					access,
					blockedByMe,
					knownBlockState: localForProfile?.blockState ?? null,
					selfActedRecently:
						hasRecentSelfBlockActionOnProfile(profileId) ||
						(localForProfile?.conversationId != null &&
							hasRecentSelfBlockAction(localForProfile.conversationId)),
				})
			: null;

	const known = pickKnownProfile([hint, ...(localForProfile?.candidates ?? []), liveForProfile]);
	const hasName = known.name !== null;
	const hasPhoto = known.imageHash !== null || known.imageUrl !== null;

	// Only someone this account blocked, and only for what is still missing
	// once the device's own copies have been read.
	const shouldAskGrindr =
		state === "you_blocked" && localForProfile !== null && (!hasName || !hasPhoto);
	useEffect(() => {
		if (!profileId || !shouldAskGrindr) return;
		let cancelled = false;
		void apiFunctions
			.getProfilesByIds([profileId])
			.then((raw) => {
				const card = readProfileCard(raw, profileId);
				if (!cancelled && card) setLive({ profileId, card });
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [apiFunctions, profileId, shouldAskGrindr]);

	if (!state) return null;
	return {
		state,
		// Both answers feed the line about who blocked whom, and a first guess
		// made without them can be the opposite of the final one.
		isResolving:
			localForProfile === null || (access === "blocked" && isBlockListPending),
		name: known.name,
		photoUrl:
			known.imageHash && validateMediaHash(known.imageHash)
				? getThumbImageUrl(known.imageHash, "320x320")
				: known.imageUrl,
		conversationId: localForProfile?.conversationId ?? null,
		savedCopy: localForProfile?.savedCopy ?? null,
		// Only for a block of this account's that is in force now: the log
		// knows nothing about their block, and nothing about a deleted profile.
		blockExplanation:
			state === "you_blocked" ? (localForProfile?.blockExplanation ?? null) : null,
	};
}
