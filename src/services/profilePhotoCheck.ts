/**
 * profilePhotoCheck.ts — what the detector finds in a profile's own photos.
 *
 * Two questions are answered from here, and neither is decided here:
 *
 * - Is one of their photos explicit? Someone can open with nothing but "hey"
 *   while their profile photo is the explicit thing, and the chat-photo
 *   filter never sees that.
 * - Does any of their photos show a face? Backs the "has photos, but none
 *   shows a face" rule.
 *
 * Both act only on what was actually seen. An explicit photo is one the
 * detector looked at and called explicit. "No face" needs every photo to
 * have been downloaded, checked, and found to be a definite no. A photo that
 * would not download, a profile that could not be read, a detector that is
 * not running, a face the detector is unsure about: those are "unsure", and
 * nothing acts on "unsure".
 *
 * Each photo is checked once, as a whole, and remembered (content_checks,
 * under "profile:<hash>").
 */

import type { ProfileDetail } from "../pages/app/GridPage.types";
import type { StoredContentCheck } from "../types/chat-db";
import * as chatDb from "./chatDb";
import {
	checkImageBytes,
	getCachedCheckForMediaKey,
	saveContentCheck,
	scoresOf,
	verdictOf,
} from "./contentCheck";
import { rememberExplicitProfilePhoto } from "./explicitProfilePhotos";
import { fetchAndEncode } from "./mediaStore";
import { faceVerdict, profileFaceVerdict, type FaceVerdict } from "../utils/explicitContentRules";
import { appLog } from "../utils/logger";
import { getProfileImageUrl, validateMediaHash } from "../utils/media";
import { classifyProfileAccess } from "../utils/profileAccessStatus";

/** Bumped whenever what is recorded for a profile photo changes; older rows are checked again. */
const MODEL = "nudenet-320n-profile-3";

/** More photos than this and the rest are not looked at. */
const MAX_PHOTOS = 8;

const REMEMBER_SETTLED_MS = 30 * 60 * 1000;
const REMEMBER_UNKNOWN_MS = 5 * 60 * 1000;

type ProfileForPhotos = Pick<
	ProfileDetail,
	"displayName" | "lastUpdatedTime" | "medias" | "profileImageMediaHash"
>;

export type ProfilePhotoApi = {
	getProfileDetail: (profileId: string) => Promise<ProfileForPhotos>;
};

/** Every photo on a profile, main one first. */
function photoHashesOf(profile: ProfileForPhotos): string[] {
	const hashes = [
		profile.profileImageMediaHash?.trim() ?? "",
		...(profile.medias ?? []).map((media) => media.mediaHash?.trim() ?? ""),
	].filter((hash) => validateMediaHash(hash));
	return [...new Set(hashes)];
}

/** What the detector found in one profile photo, or null when it could not be checked. */
async function checkProfilePhoto(hash: string): Promise<StoredContentCheck | null> {
	const mediaKey = `profile:${hash}`;
	const stored =
		getCachedCheckForMediaKey(mediaKey) ?? (await chatDb.getContentCheck(mediaKey).catch(() => null));
	if (stored?.model === MODEL) {
		if (verdictOf(stored) === "explicit") rememberExplicitProfilePhoto(hash);
		return stored;
	}

	const fetched = await fetchAndEncode(getProfileImageUrl(hash, "1024x1024"));
	if (!fetched) return null;
	try {
		const scores = await checkImageBytes(fetched.base64);
		const check: StoredContentCheck = {
			mediaKey,
			messageId: null,
			conversationId: null,
			kind: "image",
			explicitLabel: scores.explicitLabel,
			explicitScore: scores.explicitScore,
			coverOnlyScore: scores.coverOnlyScore,
			faceScore: scores.faceScore,
			faceShare: scores.faceShare,
			model: MODEL,
			checkedAt: Date.now(),
		};
		await saveContentCheck(check);
		// So the photo stops being drawn as their avatar in chat.
		if (verdictOf(check) === "explicit") rememberExplicitProfilePhoto(hash);
		return check;
	} catch (error) {
		appLog.warn(`[profile-photo] could not check photo ${hash}`, error);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Is one of their photos explicit?
// ---------------------------------------------------------------------------

type RememberedExplicit = { found: StoredContentCheck | null; at: number; keepFor: number };
const explicitByProfile = new Map<string, RememberedExplicit>();

/**
 * The first of a profile's photos the detector calls explicit, or null when
 * none is — including when none could be checked. The answer is remembered
 * for a while, so a run of messages from one person reads their profile once.
 *
 * `knownProfile` saves the profile request for a caller that already has it.
 */
export async function findExplicitProfilePhoto(
	api: ProfilePhotoApi,
	profileId: string,
	knownProfile?: ProfileForPhotos | null,
): Promise<StoredContentCheck | null> {
	const remembered = explicitByProfile.get(profileId);
	if (remembered && Date.now() - remembered.at < remembered.keepFor) {
		return remembered.found;
	}
	const remember = (found: StoredContentCheck | null, settled: boolean) => {
		explicitByProfile.set(profileId, {
			found,
			at: Date.now(),
			keepFor: settled ? REMEMBER_SETTLED_MS : REMEMBER_UNKNOWN_MS,
		});
		return found;
	};

	let profile = knownProfile ?? null;
	if (!profile) {
		try {
			profile = await api.getProfileDetail(profileId);
		} catch (error) {
			appLog.warn(`[profile-photo] could not read profile ${profileId}`, error);
			return remember(null, false);
		}
	}
	// A blocked or deleted profile comes back as an empty shell.
	if (classifyProfileAccess(profile) !== "accessible") return remember(null, false);

	let everyPhotoChecked = true;
	for (const hash of photoHashesOf(profile).slice(0, MAX_PHOTOS)) {
		const check = await checkProfilePhoto(hash);
		if (!check) {
			everyPhotoChecked = false;
			continue;
		}
		if (verdictOf(check) === "explicit") return remember(check, true);
	}
	return remember(null, everyPhotoChecked);
}

// ---------------------------------------------------------------------------
// Does any of their photos show a face?
// ---------------------------------------------------------------------------

type RememberedFace = { primaryHash: string; verdict: FaceVerdict; at: number };
const faceByProfile = new Map<string, RememberedFace>();

function rememberedFace(profileId: string, primaryHash: string): FaceVerdict | undefined {
	const entry = faceByProfile.get(profileId);
	if (!entry || entry.primaryHash !== primaryHash) return undefined;
	if (entry.verdict === "face") return "face";
	// "No face" and "unsure" are asked again after a while: people add photos,
	// and a failed download may work next time.
	const keepFor = entry.verdict === "no_face" ? REMEMBER_SETTLED_MS : REMEMBER_UNKNOWN_MS;
	return Date.now() - entry.at < keepFor ? entry.verdict : undefined;
}

async function faceVerdictForPhoto(hash: string): Promise<FaceVerdict | null> {
	const check = await checkProfilePhoto(hash);
	return check ? faceVerdict(scoresOf(check)) : null;
}

/**
 * "face": at least one photo shows one. "no_face": every photo was checked
 * and each is a definite no. "unsure": anything else, which nobody may be
 * blocked on.
 */
export async function profileFaceVerdictFor(
	api: ProfilePhotoApi,
	profileId: string,
	primaryHash: string,
): Promise<FaceVerdict> {
	const cached = rememberedFace(profileId, primaryHash);
	if (cached !== undefined) return cached;

	const remember = (verdict: FaceVerdict) => {
		faceByProfile.set(profileId, { primaryHash, verdict, at: Date.now() });
		return verdict;
	};

	if (!validateMediaHash(primaryHash)) return remember("unsure");

	// The main photo first: it is already known from the inbox, and for most
	// people it settles the question without reading the profile at all.
	const primary = await faceVerdictForPhoto(primaryHash);
	if (primary === "face") return remember("face");

	let hashes: string[];
	try {
		const profile = await api.getProfileDetail(profileId);
		// A blocked or deleted profile comes back as an empty shell, which
		// says nothing about what its photos show.
		if (classifyProfileAccess(profile) !== "accessible") {
			return remember("unsure");
		}
		hashes = photoHashesOf(profile).filter((hash) => hash !== primaryHash);
	} catch (error) {
		appLog.warn(`[profile-photo] could not read profile ${profileId}`, error);
		return remember("unsure");
	}

	const photos: (FaceVerdict | null)[] = [primary];
	for (const hash of hashes.slice(0, MAX_PHOTOS - 1)) {
		const photo = await faceVerdictForPhoto(hash);
		if (photo === "face") return remember("face");
		photos.push(photo);
	}
	// Photos past the limit were not looked at, so "none shows a face" cannot be said.
	if (hashes.length > MAX_PHOTOS - 1) photos.push(null);

	return remember(profileFaceVerdict(photos));
}
