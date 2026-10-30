import { useEffect, useMemo, useRef, useState } from "react";
import {
	useLocation,
	useNavigate,
	useParams,
	useSearchParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import z from "zod";
import toast from "react-hot-toast";
import { useApiFunctions } from "../../hooks/useApiFunctions";
import { useManagedGenders, useManagedPronouns, useBlockedProfileIds, useBlockProfile, useUnblockProfile } from "../../hooks/queries/useProfileQueries";
import { usePreferences } from "../../contexts/PreferencesContext";
import { decodeGeohash, encodeGeohash } from "../../utils/geohash";
import { validateMediaHash } from "../../utils/media";
import { ProfileDetailsModal } from "./gridpage/components/ProfileDetailsModal";
import {
	LocationFinderDialog,
	type LocationFinderEvent,
	type LocationFinderResult,
	type LocationFinderStage,
} from "./gridpage/components/LocationFinderDialog";
import { isLocationFinderEnabled } from "../../utils/locationFinderSettings";
import { useTapProfile } from "./gridpage/hooks/useTapProfile";
import { loadBrowseFiltersDraft } from "./browse-filters-storage";
import {
	getCachedProfileDetail,
	removeProfileFromBrowseCache,
	setCachedProfileDetail,
} from "./gridpage/cache";
import {
	type ProfileDetail,
} from "./GridPage.types";
import { getChatContactIndexForProfiles, getLocalNicknamesForProfiles } from "../../services/chatContactIndex";
import type { ChatContactIndexRecord } from "../../types/chat-contact-index";
import { findConversationByProfileId, insertSystemMessage } from "../../services/chatDb";
import {
	unarchiveConversation,
	claimBlockStateTransition,
	restoreDroppedBlock,
} from "../../services/conversationArchive";
import { appLog } from "../../utils/logger";
import { consumeSelfBlockAction } from "../../utils/selfBlockActions";
import { classifyProfileAccess, type ProfileAccessStatus } from "../../utils/profileAccessStatus";
import type { KnownProfile } from "../../utils/unavailableProfile";
import { useUnavailableProfile } from "../../hooks/useUnavailableProfile";
import { UnavailableProfileView } from "./gridpage/components/UnavailableProfileView";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import {
	SKIP_BLOCK_CONFIRM_KEY,
	SKIP_UNBLOCK_CONFIRM_KEY,
	isBlockConfirmSkipped,
	isUnblockConfirmSkipped,
} from "../../utils/blockConfirm";
import { useAuth } from "../../contexts/useAuth";
import {
	GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
	type GoogleDriveSyncDataAppliedDetail,
} from "../../services/googleDriveSyncRuntime";
import { logProfileOpen } from "../../services/statsLog";
import { FAVORITE_CHANGED_EVENT, type FavoriteChangedDetail } from "../../services/favoriteSync";
import { isRecordProfileViewsEnabled } from "../../utils/privacy";

const profileRouteParamsSchema = z.object({
	profileId: z.string().min(1),
});

// Successfully loading someone's full profile here is evidence we're not
// blocked by them anymore — a real signal independent of the WS
// chat.v1.conversation.delete event, which can be missed (app not running,
// connection drop) when an unblock actually happens.
//
// That is evidence about *their* block. A chat this account archived by
// blocking stays where it is: their profile being readable then means Grindr
// dropped the block, which is restoreDroppedBlock's to put back, not a reason
// to hand the chat back to the inbox.
function unarchiveConversationIfArchived(profileId: string) {
	void findConversationByProfileId(profileId)
		.then(async (stored) => {
			if (!stored?.archived || stored.blockState === "blocked_by_me") {
				return;
			}
			const isSelf = consumeSelfBlockAction(stored.conversationId, "unblock");
			const claimed = await claimBlockStateTransition(stored.conversationId, null).catch(
				() => false,
			);
			if (!claimed) {
				return;
			}
			void unarchiveConversation(stored.conversationId);
			// Only this account's own unblock is worth a marker.
			if (!isSelf) {
				return;
			}
			void insertSystemMessage(stored.conversationId, "SystemUnblockedBySelf").catch((error) => {
				appLog.error("[grid-profile] failed to insert system message", error);
			});
		})
		.catch((error) => {
			appLog.warn("[grid-profile] failed to check archived conversation", error);
		});
}

export function GridProfilePage() {
	const { t } = useTranslation();
	const TAP_WINDOW_MS = 24 * 60 * 60 * 1000;
	const navigate = useNavigate();
	const location = useLocation();
	const params = useParams();
	const [searchParams] = useSearchParams();
	const apiFunctions = useApiFunctions();
	const { geohash } = usePreferences();
	const { userId, settingsReady } = useAuth();

	const { data: managedGenders } = useManagedGenders();
	const { data: managedPronouns } = useManagedPronouns();
	const { data: blockedProfileIdsData } = useBlockedProfileIds();
	const { mutateAsync: blockProfileMutation, isPending: isBlockingProfile } = useBlockProfile();
	const { mutateAsync: unblockProfileMutation, isPending: isUnblockingProfile } = useUnblockProfile();

	const blockedProfileIds = useMemo(() => new Set(blockedProfileIdsData ?? []), [blockedProfileIdsData]);
	// Read when a profile is opened, without reopening it each time the list changes.
	const blockedProfileIdsRef = useRef(blockedProfileIds);
	blockedProfileIdsRef.current = blockedProfileIds;

	const genderOptions = useMemo(() => {
		return managedGenders?.map((item) => ({
			value: item.genderId,
			label: item.gender,
		})) ?? [];
	}, [managedGenders]);

	const pronounOptions = useMemo(() => {
		return managedPronouns?.map((item) => ({
			value: item.pronounId,
			label: item.pronoun,
		})) ?? [];
	}, [managedPronouns]);

	const [activeProfile, setActiveProfile] = useState<ProfileDetail | null>(
		null,
	);
	const [isLoadingActiveProfile, setIsLoadingActiveProfile] = useState(true);
	const [activeProfileError, setActiveProfileError] = useState<string | null>(
		null,
	);
	// What Grindr's latest answer for this profile was — null until it has
	// answered. Anything but "accessible" is the empty stub, which is shown as
	// its own screen instead of as a profile named "4".
	const [profileAccess, setProfileAccess] = useState<ProfileAccessStatus | null>(null);
	const profileAccessForRef = useRef<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	const [isLocatingProfile, setIsLocatingProfile] = useState(false);
	const [isFinderOpen, setIsFinderOpen] = useState(false);
	const [finderStage, setFinderStage] = useState<LocationFinderStage>("confirm");
	const [finderTargetId, setFinderTargetId] = useState<string | null>(null);
	const [finderEvents, setFinderEvents] = useState<LocationFinderEvent[]>([]);
	const [finderResult, setFinderResult] = useState<LocationFinderResult | null>(null);
	const [finderStartedAt, setFinderStartedAt] = useState<number | null>(null);
	const finderEventIdRef = useRef(0);
	const [locationFinderEnabled] = useState(isLocationFinderEnabled);
	const [chatContactStatus, setChatContactStatus] = useState<ChatContactIndexRecord | null>(null);
	const [localNickname, setLocalNickname] = useState<string | null>(null);

	const [mutatingFavoriteProfileId, setMutatingFavoriteProfileId] = useState<string | null>(
		null,
	);
	const [pendingProfileConfirm, setPendingProfileConfirm] = useState<{
		action: "block" | "unblock";
		profileId: string;
	} | null>(null);
	const [dontAskAgainChecked, setDontAskAgainChecked] = useState(false);

	const [isDesktopLike, setIsDesktopLike] = useState(() =>
		window.matchMedia("(hover: hover) and (pointer: fine)").matches
	);
	useEffect(() => {
		const query = window.matchMedia("(hover: hover) and (pointer: fine)");
		const update = () => setIsDesktopLike(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	const parsedParams = profileRouteParamsSchema.safeParse(params);
	const profileId = parsedParams.success ? parsedParams.data.profileId : null;

	useEffect(() => {
		if (!profileId || !settingsReady || userId == null) {
			setChatContactStatus(null);
			return;
		}

		let cancelled = false;
		const hydrateChatContactStatus = async () => {
			try {
				const records = await getChatContactIndexForProfiles([profileId]);
				if (!cancelled) {
					setChatContactStatus(records[0] ?? null);
				}
			} catch (error) {
				if (!cancelled) {
					setChatContactStatus(null);
				}
				appLog.warn("[chat-index] failed to hydrate profile chat metadata", error);
			}
		};
		const handleCloudDataApplied = (event: Event) => {
			const detail = (event as CustomEvent<GoogleDriveSyncDataAppliedDetail>).detail;
			if (!settingsReady || userId == null || detail?.profileId !== userId) {
				return;
			}
			void hydrateChatContactStatus();
		};

		setChatContactStatus(null);
		void hydrateChatContactStatus();
		window.addEventListener(
			GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
			handleCloudDataApplied,
		);

		return () => {
			cancelled = true;
			window.removeEventListener(
				GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
				handleCloudDataApplied,
			);
		};
	}, [profileId, settingsReady, userId]);

	useEffect(() => {
		if (!profileId) {
			setLocalNickname(null);
			return;
		}

		setLocalNickname(null);
		let cancelled = false;
		void getLocalNicknamesForProfiles([profileId])
			.then((nicknames) => {
				if (cancelled) {
					return;
				}
				setLocalNickname(nicknames[profileId] ?? null);
			})
			.catch((error) => {
				if (!cancelled) {
					setLocalNickname(null);
				}
				appLog.warn("[chat-index] failed to hydrate profile local nickname", error);
			});

		return () => {
			cancelled = true;
		};
	}, [profileId]);

	const {
		tappingProfileId,
		resolvedTapVisualState,
		hasSentTapRecently,
		handleTapProfile,
	} = useTapProfile({
		activeProfile,
		setActiveProfile,
		activeProfileId: profileId,
		tap: apiFunctions.tap,
		TAP_WINDOW_MS,
	});

	const isTappingProfile = tappingProfileId === profileId;

	const locationState = (location.state as { returnTo?: unknown; profileIds?: unknown; knownProfile?: unknown } | null) ?? {};
	const returnToFromState =
		typeof locationState.returnTo === "string" ? locationState.returnTo : null;
	// The name and picture the list that opened this profile was showing.
	const knownProfileFromState = useMemo<KnownProfile | null>(() => {
		const raw = locationState.knownProfile;
		if (!raw || typeof raw !== "object") return null;
		const { name, imageHash } = raw as { name?: unknown; imageHash?: unknown };
		return {
			name: typeof name === "string" ? name : null,
			imageHash: typeof imageHash === "string" ? imageHash : null,
		};
	}, [locationState.knownProfile]);
	const profileIds: string[] = Array.isArray(locationState.profileIds)
		? (locationState.profileIds as unknown[]).filter((x): x is string => typeof x === "string")
		: [];
	const returnToFromQuery = searchParams.get("returnTo");
	const returnTo = returnToFromState ?? returnToFromQuery;
	const safeReturnTo =
		typeof returnTo === "string" &&
		returnTo.startsWith("/") &&
		!returnTo.startsWith("//")
			? returnTo
			: "/browse";

	const currentIndex = profileId ? profileIds.indexOf(profileId) : -1;
	const prevProfileId = currentIndex > 0 ? profileIds[currentIndex - 1] : null;
	const nextProfileId = currentIndex >= 0 && currentIndex < profileIds.length - 1 ? profileIds[currentIndex + 1] : null;

	const handlePrevProfile = prevProfileId
		? () => navigate(`/profile/${prevProfileId}`, { replace: true, state: { returnTo: safeReturnTo, profileIds } })
		: undefined;
	const handleNextProfile = nextProfileId
		? () => navigate(`/profile/${nextProfileId}`, { replace: true, state: { returnTo: safeReturnTo, profileIds } })
		: undefined;

	useEffect(() => {
		if (!profileId) {
			setActiveProfile(null);
			setActiveProfileError(t("api.errors.invalid_profile_id"));
			setIsLoadingActiveProfile(false);
			return;
		}

		let cancelled = false;

		// A reload of the same profile (after an unblock, or "Check again")
		// keeps the last answer on screen until the new one is in.
		if (profileAccessForRef.current !== profileId) {
			profileAccessForRef.current = profileId;
			setProfileAccess(null);
		}

		// Someone this account blocks has no profile to look at, so there is
		// no visit to tell Grindr about.
		const isKnownBlocked = blockedProfileIdsRef.current.has(profileId);
		if (!isKnownBlocked) {
			void apiFunctions.recordProfileView(profileId);
		}
		logProfileOpen(profileId, {
			viewRecorded: !isKnownBlocked && isRecordProfileViewsEnabled(),
			surface: "profile_page",
		});

		const loadProfileDetails = async () => {
			const cachedProfile = getCachedProfileDetail(profileId);

			if (cachedProfile) {
				setActiveProfile(cachedProfile);
				// A copy from before this account blocked them is not shown as
				// their profile while Grindr is asked what it shows now.
				setIsLoadingActiveProfile(isKnownBlocked);
			} else {
				setIsLoadingActiveProfile(true);
			}

			setActiveProfileError(null);

			try {
				const parsed = await apiFunctions.getProfileDetail(profileId);

				if (!cancelled) {
					// GET /v7/profiles/:id always returns 200, even for a blocked or
					// deleted profile — it comes back as a stub (see
					// classifyProfileAccess). A successful fetch alone is therefore
					// NOT evidence of being unblocked — only a real profile is.
					const access = classifyProfileAccess(parsed);
					setProfileAccess(access);
					setCachedProfileDetail(profileId, parsed);
					if (access === "accessible") {
						setActiveProfile(parsed);
						// Someone this account blocked is only readable because Grindr
						// dropped the block. It is put back, and the profile asked for
						// again, which is then the blocked one this page has a screen for.
						// Not awaited: the profile is already on screen.
						void restoreDroppedBlock({
							profileId,
							evidenceAt: Date.now(),
							blockProfile: () => apiFunctions.blockProfile(profileId),
						}).then((restored) => {
							if (restored === "restored") {
								removeProfileFromBrowseCache(profileId);
								toast.success(
									t("profile_details.block_restored", {
										defaultValue:
											"Grindr had dropped your block on this person. They are blocked again.",
									}),
								);
								if (!cancelled) {
									setReloadToken((token) => token + 1);
								}
							} else if (restored === "failed") {
								toast.error(
									t("profile_details.block_restore_failed", {
										defaultValue:
											"Grindr dropped your block on this person, and it could not be put back. Use Block to try again.",
									}),
								);
							} else {
								unarchiveConversationIfArchived(profileId);
							}
						});
					} else if (!cachedProfile) {
						// The stub is never shown as a profile. A copy cached from
						// before the block stays, as the name and picture to show.
						setActiveProfile(null);
					}
				}
			} catch (error) {
				if (!cancelled) {
					if (!cachedProfile) {
						setActiveProfile(null);
						setActiveProfileError(
							error instanceof Error
								? error.message
								: t("browse_page.errors.load_profile_details"),
						);
					}
				}
			} finally {
				if (!cancelled) {
					setIsLoadingActiveProfile(false);
				}
			}
		};

		void loadProfileDetails();

		return () => {
			cancelled = true;
		};
	}, [apiFunctions, profileId, reloadToken]);

	const unavailableProfile = useUnavailableProfile({
		profileId,
		access: profileAccess,
		hint:
			knownProfileFromState ??
			(activeProfile && String(activeProfile.profileId) === profileId
				? {
						name: activeProfile.displayName,
						imageHash: activeProfile.profileImageMediaHash,
					}
				: null),
	});

	const activeProfilePhotoHashes = useMemo(() => {
		if (!activeProfile) {
			return [];
		}

		const fromList = activeProfile.medias
			.map((item) => item.mediaHash ?? "")
			.filter((hash): hash is string => validateMediaHash(hash));

		const hashes = [...fromList];

		if (
			activeProfile.profileImageMediaHash &&
			validateMediaHash(activeProfile.profileImageMediaHash) &&
			!hashes.includes(activeProfile.profileImageMediaHash)
		) {
			hashes.unshift(activeProfile.profileImageMediaHash);
		}

		return hashes;
	}, [activeProfile]);

	const handleMessageProfile = (targetProfileId: string) => {
		const nextParams = new URLSearchParams();
		nextParams.set("targetProfileId", targetProfileId);
		nextParams.set("returnTo", safeReturnTo);
		navigate(`/chat?${nextParams.toString()}`);
	};

	const handleSendQuickMessage = async (targetProfileId: string, text: string) => {
		try {
			await apiFunctions.sendText({ targetProfileId: Number(targetProfileId), text });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("chat.errors.send_failed"));
		}
	};

	const handleSendProfilePhotoReply = async (targetProfileId: string, imageHash: string, text: string) => {
		try {
			await apiFunctions.sendMessage({
				type: "ProfilePhotoReply",
				target: { type: "Direct", targetId: Number(targetProfileId) },
				body: { imageHash, photoContentReply: text },
			});
			toast.success(t("chat.toasts.photo_reply_sent", { defaultValue: "Reply sent" }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("chat.errors.send_failed"));
		}
	};

	const performBlockProfile = async (targetProfileId: string) => {
		try {
			await blockProfileMutation(targetProfileId);
			removeProfileFromBrowseCache(targetProfileId);
			toast.success(t("profile_details.block_success"));
			navigate(safeReturnTo, { replace: true });
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t("profile_details.block_failed"),
			);
		}
	};

	const performUnblockProfile = async (targetProfileId: string) => {
		try {
			await unblockProfileMutation(targetProfileId);
			toast.success(t("profile_details.unblock_success"));
			// Their profile was the blocked stub until now; ask for the real one.
			setReloadToken((token) => token + 1);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("profile_details.unblock_failed"),
			);
		}
	};

	const handleBlockProfile = async (targetProfileId: string) => {
		if (isBlockingProfile || isUnblockingProfile) {
			return;
		}
		if (isBlockConfirmSkipped()) {
			await performBlockProfile(targetProfileId);
			return;
		}
		setDontAskAgainChecked(false);
		setPendingProfileConfirm({ action: "block", profileId: targetProfileId });
	};

	const handleUnblockProfile = async (targetProfileId: string) => {
		if (isBlockingProfile || isUnblockingProfile) {
			return;
		}
		if (isUnblockConfirmSkipped()) {
			await performUnblockProfile(targetProfileId);
			return;
		}
		setDontAskAgainChecked(false);
		setPendingProfileConfirm({ action: "unblock", profileId: targetProfileId });
	};

	const handleToggleFavoriteProfile = async (
		targetProfileId: string,
		currentlyFavorite: boolean,
	) => {
		if (mutatingFavoriteProfileId) {
			return;
		}

		setMutatingFavoriteProfileId(targetProfileId);
		try {
			if (currentlyFavorite) {
				await apiFunctions.removeFavorite(targetProfileId);
			} else {
				await apiFunctions.addFavorite(targetProfileId);
			}


			setActiveProfile((previous) => {
				if (!previous || previous.profileId !== targetProfileId) {
					return previous;
				}
				return {
					...previous,
					isFavorite: !currentlyFavorite,
				};
			});

			toast.success(
				currentlyFavorite ? t("favorites.removed") : t("favorites.added"),
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: currentlyFavorite
						? t("favorites.remove_failed")
						: t("favorites.add_failed"),
			);
		} finally {
			setMutatingFavoriteProfileId(null);
		}
	};

	// The star was set or removed from this person's chat while their profile
	// was open here.
	useEffect(() => {
		const onFavoriteChange = (event: Event) => {
			const detail = (event as CustomEvent<FavoriteChangedDetail>).detail;
			if (!detail) return;
			setActiveProfile((previous) =>
				previous &&
				previous.profileId === detail.profileId &&
				Boolean(previous.isFavorite) !== detail.favorite
					? { ...previous, isFavorite: detail.favorite }
					: previous,
			);
		};
		window.addEventListener(FAVORITE_CHANGED_EVENT, onFavoriteChange as EventListener);
		return () => {
			window.removeEventListener(FAVORITE_CHANGED_EVENT, onFavoriteChange as EventListener);
		};
	}, []);

	const handleCancelProfileConfirm = () => {
		if (isBlockingProfile || isUnblockingProfile) {
			return;
		}
		setPendingProfileConfirm(null);
	};

	const handleConfirmProfileAction = async () => {
		if (!pendingProfileConfirm || isBlockingProfile || isUnblockingProfile) {
			return;
		}

		const { action, profileId } = pendingProfileConfirm;
		if (dontAskAgainChecked && typeof window !== "undefined") {
			localStorage.setItem(
				action === "block" ? SKIP_BLOCK_CONFIRM_KEY : SKIP_UNBLOCK_CONFIRM_KEY,
				"true",
			);
		}

		setPendingProfileConfirm(null);
		if (action === "block") {
			await performBlockProfile(profileId);
			return;
		}
		await performUnblockProfile(profileId);
	};

    const solveTrilateration = (points: { lat: number, lon: number, dist: number }[]) => {
        // 1. Convert Lat/Lon to a simple XY grid (meters) relative to the first point
        // This avoids floating point errors with large coordinate numbers
        const p1 = points[0];
        const p2 = points[1];
        const p3 = points[2];

        // Rough conversion: 1 degree lat = 111320m
        const latToM = 111320;
        const lonToM = 111320 * Math.cos(p1.lat * (Math.PI / 180));

        const x2 = (p2.lon - p1.lon) * lonToM;
        const y2 = (p2.lat - p1.lat) * latToM;
        const x3 = (p3.lon - p1.lon) * lonToM;
        const y3 = (p3.lat - p1.lat) * latToM;

        const r1 = p1.dist;
        const r2 = p2.dist;
        const r3 = p3.dist;

        // 2. Standard Trilateration Formula for 2D intersection
        // Derived from (x-x1)^2 + (y-y1)^2 = r1^2 ... etc
        const A = 2 * x2;
        const B = 2 * y2;
        const C = Math.pow(r1, 2) - Math.pow(r2, 2) + Math.pow(x2, 2) + Math.pow(y2, 2);
        const D = 2 * x3;
        const E = 2 * y3;
        const F = Math.pow(r1, 2) - Math.pow(r3, 2) + Math.pow(x3, 2) + Math.pow(y3, 2);

        const denom = A * E - D * B;
        if (Math.abs(denom) < 1e-10) {
            throw new Error("Trilateration failed: measurement points are collinear or too close together. Try again with a larger initial offset.");
        }
        const x = (C * E - F * B) / denom;
        const y = (A * F - D * C) / denom;

        // 3. Convert XY back to Lat/Lon
        return {
            lat: p1.lat + (y / latToM),
            lon: p1.lon + (x / lonToM)
        };
    };

    // The finder reports into its pop-up (LocationFinderDialog) rather than
    // toasts, and is started from there, after its warning.
    const reportFinder = (tone: LocationFinderEvent["tone"], text: string) => {
        finderEventIdRef.current += 1;
        const id = finderEventIdRef.current;
        setFinderEvents((current) => [...current, { id, tone, text }]);
    };

    const handleTriangleProfile = async (targetProfileId: string) => {
        if (!geohash) {
            reportFinder("error", t("browse_page.errors.location_required"));
            return;
        }

        if (isLocatingProfile) {
            return;
        }

        setIsLocatingProfile(true);

        let originalLat: number;
        let originalLon: number;

        try {
            // Decode starting position
            const decoded = decodeGeohash(geohash);
            originalLat = (decoded.lat[0] + decoded.lat[1]) / 2;
            originalLon = (decoded.lon[0] + decoded.lon[1]) / 2;
        } catch (error) {
            reportFinder(
                "error",
                error instanceof Error
                    ? error.message
                    : t("browse_page.errors.location_read_failed"),
            );
            setIsLocatingProfile(false);
            return;
        }

        const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        const putServerLocation = async (lat: number, lon: number, targetGeohash: string) => {
            const payloads = [
                { lat, lon },
                { latitude: lat, longitude: lon },
                { geohash: targetGeohash },
                { nearbyGeoHash: targetGeohash },
            ];

            for (const payload of payloads) {
                try {
                    const response = await apiFunctions.request("/v4/location", {
                        method: "PUT",
                        body: payload,
                    });
                    if (response.status >= 200 && response.status < 300) return;
                } catch (e) {
                    continue;
                }
            }
            throw new Error("Failed to update server location across all payload types.");
        };

        const getDistanceFromProfile = async (): Promise<number | null> => {
            try {
                const profile = await apiFunctions.getProfileDetail(targetProfileId);
                return typeof profile.distance === "number" && Number.isFinite(profile.distance)
                    ? profile.distance
                    : null;
            } catch {
                return null;
            }
        };

        try {
            const initialDist = await getDistanceFromProfile();
            if (initialDist === null) {
                reportFinder("error", t("profile_details.location_finder_error_distance"));
                return;
            }

            let currentLat = originalLat;
            let currentLon = originalLon;
            const targetPrecision = 15;
            let rounds = Math.ceil(Math.log(initialDist / targetPrecision) / Math.log(3));
            rounds = Math.max(2, Math.min(rounds, 6));

            // Degrees per meter (approximate)
            let offset = (initialDist*1.5) / 111320;

            reportFinder("info", t("profile_details.location_finder_start", { distance: Math.round(initialDist), rounds }));

            for (let i = 0; i < rounds; i++) {
                const points = [
                    { lat: currentLat + offset, lon: currentLon }, // Top
                    { lat: currentLat - (offset / 2), lon: currentLon + (offset * 0.866) }, // Bottom Right
                    { lat: currentLat - (offset / 2), lon: currentLon - (offset * 0.866) }, // Bottom Left
                ];

                const results: { lat: number, lon: number, dist: number }[] = [];

                for (const p of points) {
                    await putServerLocation(p.lat, p.lon, encodeGeohash(p.lat, p.lon));
                    await waitMs(5000); // Wait for distance calculation to propagate on server
                    const d = await getDistanceFromProfile();
                    if (d !== null) results.push({ lat: p.lat, lon: p.lon, dist: d });
                }

                if (results.length === 3) {
                    const estimate = solveTrilateration(results);
                    currentLat = estimate.lat;
                    currentLon = estimate.lon;
                    offset /= 3; // Zoom in for the next round

                    reportFinder("info", t("profile_details.location_finder_round_complete", {
                        round: i + 1,
                        lat: currentLat.toFixed(6),
                        lon: currentLon.toFixed(6),
                        distance: Math.round(results[0].dist)
                    }));

                    reportFinder("info", t("profile_details.location_finder_error_estimate", {
                        round: i + 1,
                        error: Math.round(offset * 111320)
                    }));
                }
            }

            const finalCoords = `${currentLat.toFixed(6)}, ${currentLon.toFixed(6)}`;
            reportFinder("success", t("profile_details.location_finder_final_location", {
                lat: currentLat.toFixed(6),
                lon: currentLon.toFixed(6),
                error: Math.round(offset * 111320)
            }));
            setFinderResult({ lat: currentLat, lon: currentLon, errorMeters: Math.round(offset * 111320) });

            try {
                await navigator.clipboard.writeText(finalCoords);
                reportFinder("info", t("profile_details.location_finder_location_copied"));
            } catch (err) {
                appLog.error("Failed to copy location to clipboard", err);
            }
        } catch (error) {
            reportFinder("error", error instanceof Error ? error.message : t("profile_details.location_finder_error_general"));
        } finally {
            await waitMs(10000);
            await putServerLocation(originalLat, originalLon, geohash);
            setIsLocatingProfile(false);
        }
    };

    const openLocationFinder = (targetProfileId: string) => {
        // A run already going (possibly hidden) is shown, not restarted.
        if (!isLocatingProfile) {
            setFinderTargetId(targetProfileId);
            setFinderStage("confirm");
            setFinderEvents([]);
            setFinderResult(null);
            setFinderStartedAt(null);
        }
        setIsFinderOpen(true);
    };

    const startLocationFinder = async () => {
        if (!finderTargetId) return;
        setFinderStage("running");
        setFinderStartedAt(Date.now());
        await handleTriangleProfile(finderTargetId);
        setFinderStage("finished");
        // Hidden during the run: bring the result back up.
        setIsFinderOpen(true);
    };

    const closeLocationFinder = () => {
        setIsFinderOpen(false);
    };

	const handleTagClick = async (tag: string) => {
		const persistedDraft = await loadBrowseFiltersDraft();
		navigate("/", {
			state: { browseFiltersDraft: { ...persistedDraft, tags: [tag] } },
		});
		toast.success(t("browse_page.toasts.tag_filter_applied", { tag }));
	};

	return (
		<>
			{unavailableProfile && profileId ? (
			<UnavailableProfileView
				variant={isDesktopLike ? "modal" : "page"}
				profileId={profileId}
				profile={unavailableProfile}
				onClose={() => {
					navigate(safeReturnTo, { replace: true });
				}}
				onUnblock={handleUnblockProfile}
				isUnblocking={isUnblockingProfile}
				onBlock={handleBlockProfile}
				isBlocking={isBlockingProfile}
				onOpenChat={(conversationId) => {
					navigate(`/chat/${encodeURIComponent(conversationId)}`);
				}}
				onRetry={() => setReloadToken((token) => token + 1)}
				isRetrying={isLoadingActiveProfile}
				onTagClick={handleTagClick}
				chatContactStatus={chatContactStatus}
				genderOptions={genderOptions}
				pronounOptions={pronounOptions}
			/>
			) : (
			<ProfileDetailsModal
				variant={isDesktopLike ? "modal" : "page"}
				isOpen
				onClose={() => {
					navigate(safeReturnTo, { replace: true });
				}}
				onPrevProfile={handlePrevProfile}
				onNextProfile={handleNextProfile}
				onMessageProfile={handleMessageProfile}
				onTagClick={handleTagClick}
				onSendQuickMessage={handleSendQuickMessage}
				onSendProfilePhotoReply={handleSendProfilePhotoReply}
				onTriangleProfile={locationFinderEnabled ? openLocationFinder : undefined}
				onBlockProfile={handleBlockProfile}
				onUnblockProfile={handleUnblockProfile}
				onToggleFavoriteProfile={handleToggleFavoriteProfile}
				isFavorite={Boolean(activeProfile?.isFavorite)}
				isTogglingFavorite={Boolean(
					profileId && mutatingFavoriteProfileId === profileId,
				)}
				isBlocked={profileId ? blockedProfileIds.has(profileId) : false}
				isBlockingProfile={isBlockingProfile || isUnblockingProfile}
				isLocatingProfile={isLocatingProfile}
				onTapProfile={handleTapProfile}
				isTappingProfile={isTappingProfile}
				isTapBlocked={hasSentTapRecently}
				tapVisualState={resolvedTapVisualState}
				activeProfile={activeProfile}
				selectedBrowseCard={null}
				isLoadingActiveProfile={isLoadingActiveProfile}
				activeProfileError={activeProfileError}
				activeProfilePhotoHashes={activeProfilePhotoHashes}
				chatContactStatus={chatContactStatus}
				localNickname={localNickname}
				genderOptions={genderOptions}
				pronounOptions={pronounOptions}
			/>
			)}

			<LocationFinderDialog
				isOpen={isFinderOpen}
				stage={finderStage}
				profileName={activeProfile?.displayName?.trim() || (finderTargetId ? `Profile ${finderTargetId}` : "")}
				distanceMeters={activeProfile?.distance}
				events={finderEvents}
				result={finderResult}
				startedAt={finderStartedAt}
				onStart={() => void startLocationFinder()}
				onClose={closeLocationFinder}
			/>

			<ConfirmDialog
				isOpen={pendingProfileConfirm !== null}
				title={
					pendingProfileConfirm?.action === "unblock"
						? t("profile_details.unblock")
						: t("profile_details.block")
				}
				message={
					pendingProfileConfirm?.action === "unblock"
						? t("profile_details.unblock_confirm")
						: t("profile_details.block_confirm")
				}
				confirmLabel={
					pendingProfileConfirm?.action === "unblock"
						? t("profile_details.unblock")
						: t("profile_details.block")
				}
				cancelLabel={t("chat.actions.cancel")}
				onConfirm={handleConfirmProfileAction}
				onCancel={handleCancelProfileConfirm}
				isProcessing={isBlockingProfile || isUnblockingProfile}
				confirmTone={
					pendingProfileConfirm?.action === "unblock" ? "default" : "danger"
				}
				dontAskAgainLabel={t("profile_details.dont_ask_again")}
				dontAskAgainChecked={dontAskAgainChecked}
				onDontAskAgainChange={setDontAskAgainChecked}
			/>
		</>
	);
}
