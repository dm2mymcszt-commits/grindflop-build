import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchSpotifyTracks } from "../../services/spotifyTrackInfo";
import { useApiFunctions } from "../useApiFunctions";
import type { TravelPlanPayload } from "../../types/travel";
import type { VisitingMode } from "../../types/visiting";
import { findConversationByProfileId } from "../../services/chatDb";
import { markSelfBlockAction, markSelfBlockActionOnProfile } from "../../utils/selfBlockActions";
import {
	applySelfBlockAction,
	markConversationDeleteHandled,
} from "../../services/conversationArchive";
import { logBlockEvent } from "../../services/statsLog";
import { profileSchema } from "../../pages/app/profile-editor/profileEditorUtils";

// chat.v1.conversation.delete fires identically for "we blocked/unblocked
// them" and "they blocked/unblocked us" — mark the conversation right after
// our own block/unblock call succeeds so that event can tell the two apart.
//
// Also claim the WS-echo dedup lock (markConversationDeleteHandled) here,
// not just in applySelfBlockAction's onSuccess — that's a purely local DB
// read with no network round trip, so it's guaranteed to land before the
// chat.v1.conversation.delete event even *could* arrive (which needs the
// outgoing request to reach the server and a broadcast to come back).
// Claiming it only in applySelfBlockAction (after the mutation's own HTTP
// round trip) left a real window where the WS-triggered path could win the
// race, archive, and insert its own system message before
// applySelfBlockAction's local state check could see it — producing a
// duplicate "You blocked/unblocked this person".
function markConversationSelfAction(profileId: string, action: "block" | "unblock") {
	// Kept per profile too, and synchronously: the profile page asks about
	// people there is no conversation with.
	markSelfBlockActionOnProfile(profileId);
	void findConversationByProfileId(profileId)
		.then((conversation) => {
			if (conversation) {
				markSelfBlockAction(conversation.conversationId, action);
				markConversationDeleteHandled(conversation.conversationId);
			}
		})
		.catch(() => {});
}

/**
 * Hook to fetch and manage blocked profile IDs.
 */
export function useBlockedProfileIds(enabled = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["blocked-profile-ids"],
		queryFn: () => api.getBlockedProfileIds(),
		staleTime: 1000 * 60 * 10, // Consider data fresh for 10 minutes
		enabled,
	});
}

/**
 * Mutation to block a profile.
 * Automatically updates the "blocked-profile-ids" cache.
 */
export function useBlockProfile() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (profileId: string) => api.blockProfile(profileId),
		// Mark before the request goes out, not in onSuccess — the resulting
		// chat.v1.conversation.delete WS event can otherwise race ahead of an
		// onSuccess-time mark and land unattributed as "You were blocked".
		onMutate: (profileId) => {
			markConversationSelfAction(profileId, "block");
		},
		onSuccess: (_, profileId) => {
			logBlockEvent({ eventType: "block", profileId, method: "manual", source: "manual" });
			// Manually update the cache for blocked IDs to keep UI in sync
			queryClient.setQueryData<string[]>(["blocked-profile-ids"], (old) => {
				if (!old) return [profileId];
				if (old.includes(profileId)) return old;
				return [...old, profileId];
			});
			// Archive any existing conversation with this profile right away
			// instead of waiting on the WS round-trip — covers every entry
			// point (grid, profile page, chat header), not just chat.
			void applySelfBlockAction(profileId, "block");
		},
	});
}

/**
 * Mutation to unblock a profile.
 * Automatically updates the "blocked-profile-ids" cache.
 */
export function useUnblockProfile() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (profileId: string) => api.unblockProfile(profileId),
		onMutate: (profileId) => {
			markConversationSelfAction(profileId, "unblock");
		},
		onSuccess: (_, profileId) => {
			logBlockEvent({ eventType: "unblock", profileId, method: "manual", source: "manual" });
			// Manually update the cache for blocked IDs to keep UI in sync
			queryClient.setQueryData<string[]>(["blocked-profile-ids"], (old) => {
				if (!old) return [];
				return old.filter((id) => id !== profileId);
			});
			// Take any existing conversation with this profile out of archive
			// right away — covers every entry point (blocked-list settings,
			// grid, profile page, chat header), not just chat.
			void applySelfBlockAction(profileId, "unblock");
		},
	});
}

/**
 * Hook to fetch managed genders.
 */
export function useManagedGenders(enabled: boolean = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["managed-genders"],
		queryFn: () => api.getManagedGenders(),
		staleTime: Infinity, // These rarely change
		enabled,
	});
}

/**
 * Hook to fetch managed pronouns.
 */
export function useManagedPronouns(enabled: boolean = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["managed-pronouns"],
		queryFn: () => api.getManagedPronouns(),
		staleTime: Infinity, // These rarely change
		enabled,
	});
}

/**
 * Hook to fetch the managed tag catalog (categories + selectable tags), used
 * both by the profile editor's tag picker and the grid tag-search filter.
 */
export function useManagedTagCategories(locale: string, enabled: boolean = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["managed-tag-categories", locale],
		queryFn: () => api.getManagedTagCategories(locale),
		staleTime: Infinity, // These rarely change
		enabled,
	});
}

/**
 * Hook to fetch the current user's own profile (read through /v4/me/profile,
 * same endpoint the profile editor uses) — used by app-level checks like the
 * HIV test reminder that need a profile field without opening the editor.
 */
export function useMyOwnProfile(enabled: boolean = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["my-own-profile"],
		queryFn: async () => {
			const raw = await api.getMyOwnProfile();
			const rawProfileObject =
				raw && typeof raw === "object" && Array.isArray((raw as { profiles?: unknown }).profiles)
					? ((raw as { profiles: Record<string, unknown>[] }).profiles[0] ?? null)
					: (raw as Record<string, unknown> | null);
			return profileSchema.parse(rawProfileObject);
		},
		enabled,
		staleTime: 1000 * 60 * 5,
	});
}

/**
 * The account's visiting mode: auto, home or visiting.
 */
export function useVisitingMode(enabled = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["visiting-mode"],
		queryFn: () => api.getVisitingMode(),
		enabled,
		staleTime: 1000 * 60 * 5,
	});
}

/**
 * Changes the visiting mode, and has the stored value read again afterwards.
 */
export function useUpdateVisitingMode() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (setting: VisitingMode) => api.updateVisitingMode(setting),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["visiting-mode"] });
		},
	});
}

/**
 * The place the account calls home. Not every account has one, and for
 * those the request fails; that is no reason to keep asking.
 */
export function useHomeLocation(enabled = true) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["home-location"],
		queryFn: () => api.getHomeLocation(),
		enabled,
		staleTime: 1000 * 60 * 5,
		retry: false,
	});
}

/**
 * Changes the home location, and has the stored value read again afterwards.
 */
export function useUpdateHomeLocation() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (location: { lat: number; lon: number }) => api.updateHomeLocation(location),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["home-location"] });
		},
	});
}

/**
 * Hook to fetch a profile's travel plans.
 */
export function useTravelPlans(profileId: string | number | null | undefined) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["travel-plans", profileId == null ? null : String(profileId)],
		queryFn: () => api.getTravelPlans(profileId!),
		enabled: profileId != null,
		staleTime: 1000 * 60 * 5,
	});
}

function invalidateTravelPlans(queryClient: ReturnType<typeof useQueryClient>, profileId: number) {
	void queryClient.invalidateQueries({ queryKey: ["travel-plans", String(profileId)] });
}

/**
 * Mutation to create a travel plan. Invalidates that profile's travel-plans cache on success.
 */
export function useCreateTravelPlan() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: TravelPlanPayload) => api.createTravelPlan(payload),
		onSuccess: (_, payload) => invalidateTravelPlans(queryClient, payload.profileId),
	});
}

/**
 * Mutation to update a travel plan. Invalidates that profile's travel-plans cache on success.
 */
export function useUpdateTravelPlan() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: TravelPlanPayload & { travelPlanId: number }) => api.updateTravelPlan(payload),
		onSuccess: (_, payload) => invalidateTravelPlans(queryClient, payload.profileId),
	});
}

/**
 * Mutation to delete a travel plan. Invalidates that profile's travel-plans cache on success.
 */
export function useDeleteTravelPlan() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ travelPlanId }: { travelPlanId: number; profileId: number }) =>
			api.deleteTravelPlan(travelPlanId),
		onSuccess: (_, variables) => invalidateTravelPlans(queryClient, variables.profileId),
	});
}

/**
 * Hook to fetch a profile's Spotify favourite track ids.
 *
 * This is an extra request per profile opened, for data that changes rarely
 * and that most profiles will not have at all, so it caches hard and never
 * retries. getSpotifyFavorites already swallows its own failures and returns
 * an empty list, so there is no error state for callers to handle.
 */
export function useSpotifyFavorites(profileId: string | number | null | undefined) {
	const api = useApiFunctions();
	return useQuery({
		queryKey: ["spotify-favorites", profileId == null ? null : String(profileId)],
		queryFn: () => api.getSpotifyFavorites(profileId!),
		enabled: profileId != null,
		staleTime: 1000 * 60 * 30,
		retry: false,
	});
}

/**
 * A profile's Spotify favourites, hydrated into renderable tracks.
 *
 * Grindr stores only bare track ids, so this is two stages: the ids from
 * Grindr, then names and artwork from Spotify's public oEmbed endpoint. The
 * second stage is keyed on the ids themselves rather than on the profile, so
 * a track shared between two profiles is only ever looked up once.
 */
export function useSpotifyTracks(profileId: string | number | null | undefined) {
	const { data: favorites, isLoading: isLoadingFavorites } = useSpotifyFavorites(profileId);
	const songIds = useMemo(() => favorites?.songIds ?? [], [favorites]);

	const { data: tracks, isLoading: isLoadingTracks } = useQuery({
		queryKey: ["spotify-tracks", songIds.join(",")],
		queryFn: () => fetchSpotifyTracks(songIds),
		enabled: songIds.length > 0,
		// Track metadata is immutable — never refetch it.
		staleTime: Infinity,
		retry: false,
	});

	return {
		tracks: tracks ?? [],
		songIds,
		isLoading: isLoadingFavorites || (songIds.length > 0 && isLoadingTracks),
	};
}

/**
 * Replaces the signed-in user's Spotify favourites.
 *
 * The endpoint takes the whole list, so callers pass the full desired set of
 * track ids, not a delta.
 */
export function useSetSpotifyFavorites(profileId: string | number | null | undefined) {
	const api = useApiFunctions();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (songIds: string[]) => api.setSpotifyFavorites(songIds),
		onSuccess: (_, songIds) => {
			const key = profileId == null ? null : String(profileId);
			// Write through rather than invalidate: the server just accepted
			// this exact list, and refetching would race the read-after-write.
			queryClient.setQueryData(["spotify-favorites", key], { songIds });
		},
	});
}
