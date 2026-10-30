export type BrowseFilters = {
	onlineOnly: boolean;
	hasAlbum: boolean;
	photoOnly: boolean;
	faceOnly: boolean;
	notRecentlyChatted: boolean;
	fresh: boolean;
	rightNow: boolean;
	favorites: boolean;
	shuffle: boolean;
	hot: boolean;
	isVisiting: boolean;
};

export type BrowseSortOption =
	| "default"
	| "distance"
	| "age-asc"
	| "age-desc"
	| "popular"
	| "name";

export const defaultBrowseFilters: BrowseFilters = {
	onlineOnly: false,
	hasAlbum: false,
	photoOnly: false,
	faceOnly: false,
	notRecentlyChatted: false,
	fresh: false,
	rightNow: false,
	favorites: false,
	shuffle: false,
	hot: false,
	isVisiting: false,
};

export type BrowseFiltersDraft = {
	sortBy: BrowseSortOption;
	browseFilters: BrowseFilters;
	ageMin: string;
	ageMax: string;
	heightCmMin: string;
	heightCmMax: string;
	weightGramsMin: string;
	weightGramsMax: string;
	tribes: number[];
	lookingFor: number[];
	relationshipStatuses: number[];
	bodyTypes: number[];
	sexualPositions: number[];
	meetAt: number[];
	nsfwPics: number[];
	tags: string[];
	nicknameFilter: string;
};

type BrowseFiltersDraftInput = {
	sortBy?: BrowseSortOption;
	browseFilters?: Partial<BrowseFilters>;
	ageMin?: string;
	ageMax?: string;
	heightCmMin?: string;
	heightCmMax?: string;
	weightGramsMin?: string;
	weightGramsMax?: string;
	tribes?: number[];
	lookingFor?: number[];
	relationshipStatuses?: number[];
	bodyTypes?: number[];
	sexualPositions?: number[];
	meetAt?: number[];
	nsfwPics?: number[];
	tags?: string[];
	nicknameFilter?: string;
};

import { getActiveChatDbUser, getSetting, setSetting } from "../../services/chatDb";

const STORAGE_KEY = "browseFilters";

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function getDefaultBrowseFiltersDraft(): BrowseFiltersDraft {
	return {
		sortBy: "default",
		browseFilters: { ...defaultBrowseFilters },
		ageMin: "",
		ageMax: "",
		heightCmMin: "",
		heightCmMax: "",
		weightGramsMin: "",
		weightGramsMax: "",
		tribes: [],
		lookingFor: [],
		relationshipStatuses: [],
		bodyTypes: [],
		sexualPositions: [],
		meetAt: [],
		nsfwPics: [],
		tags: [],
		nicknameFilter: "",
	};
}

export function normalizeBrowseFiltersDraft(
	input: BrowseFiltersDraftInput | null | undefined,
): BrowseFiltersDraft {
	const defaults = getDefaultBrowseFiltersDraft();
	const draft = input ?? {};

	return {
		sortBy:
			draft.sortBy === "default" ||
			draft.sortBy === "distance" ||
			draft.sortBy === "age-asc" ||
			draft.sortBy === "age-desc" ||
			draft.sortBy === "popular" ||
			draft.sortBy === "name"
				? draft.sortBy
				: defaults.sortBy,
		browseFilters: {
			...defaultBrowseFilters,
			...(draft.browseFilters ?? {}),
		},
		ageMin: typeof draft.ageMin === "string" ? draft.ageMin : defaults.ageMin,
		ageMax: typeof draft.ageMax === "string" ? draft.ageMax : defaults.ageMax,
		heightCmMin:
			typeof draft.heightCmMin === "string"
				? draft.heightCmMin
				: defaults.heightCmMin,
		heightCmMax:
			typeof draft.heightCmMax === "string"
				? draft.heightCmMax
				: defaults.heightCmMax,
		weightGramsMin:
			typeof draft.weightGramsMin === "string"
				? draft.weightGramsMin
				: defaults.weightGramsMin,
		weightGramsMax:
			typeof draft.weightGramsMax === "string"
				? draft.weightGramsMax
				: defaults.weightGramsMax,
		tribes: isNumberArray(draft.tribes) ? draft.tribes : defaults.tribes,
		lookingFor: isNumberArray(draft.lookingFor)
			? draft.lookingFor
			: defaults.lookingFor,
		relationshipStatuses: isNumberArray(draft.relationshipStatuses)
			? draft.relationshipStatuses
			: defaults.relationshipStatuses,
		bodyTypes: isNumberArray(draft.bodyTypes) ? draft.bodyTypes : defaults.bodyTypes,
		sexualPositions: isNumberArray(draft.sexualPositions)
			? draft.sexualPositions
			: defaults.sexualPositions,
		meetAt: isNumberArray(draft.meetAt) ? draft.meetAt : defaults.meetAt,
		nsfwPics: isNumberArray(draft.nsfwPics) ? draft.nsfwPics : defaults.nsfwPics,
		tags: isStringArray(draft.tags) ? draft.tags : defaults.tags,
		nicknameFilter: typeof draft.nicknameFilter === "string" ? draft.nicknameFilter : defaults.nicknameFilter,
	};
}

// The grid unmounts and remounts on every trip away from "/" and back, so its
// filter state used to restart from the defaults and wait for the database to
// answer. For that moment the filters looked gone, and the first request for
// the grid went out unfiltered. This copy outlives the remount (not a restart)
// so the grid can begin from the draft it last knew.
//
// It remembers whose it is: the filters are stored per account, and without
// that the first render after switching accounts would start from the previous
// account's filters.
let lastKnownBrowseFiltersDraft: { owner: number | null; draft: BrowseFiltersDraft } | null = null;

export function getCachedBrowseFiltersDraft(): BrowseFiltersDraft | null {
	if (!lastKnownBrowseFiltersDraft) {
		return null;
	}
	return lastKnownBrowseFiltersDraft.owner === getActiveChatDbUser()
		? lastKnownBrowseFiltersDraft.draft
		: null;
}

export async function loadBrowseFiltersDraft(): Promise<BrowseFiltersDraft> {
	// Read before the wait: an account switch during it must not relabel the
	// draft that comes back as the new account's.
	const owner = getActiveChatDbUser();
	try {
		const stored = await getSetting<BrowseFiltersDraftInput>(STORAGE_KEY);
		const normalized = normalizeBrowseFiltersDraft(stored);
		lastKnownBrowseFiltersDraft = { owner, draft: normalized };
		return normalized;
	} catch {
		return getDefaultBrowseFiltersDraft();
	}
}

export async function saveBrowseFiltersDraft(draft: BrowseFiltersDraft): Promise<void> {
	lastKnownBrowseFiltersDraft = { owner: getActiveChatDbUser(), draft };
	try {
		await setSetting(STORAGE_KEY, draft);
	} catch {
		// Ignore storage failures to avoid blocking filter interactions.
	}
}
