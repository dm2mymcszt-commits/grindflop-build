import { describe, expect, test } from "bun:test";
import {
	createFavoriteSync,
	FAVORITE_SETTLE_MS,
	type FavoriteChangedDetail,
} from "../src/services/favoriteSync";
import {
	getCachedProfileDetail,
	setCachedProfileDetail,
	setCachedProfileFavorite,
} from "../src/pages/app/gridpage/cache";
import type { ProfileDetail } from "../src/types/grid";

const ACCOUNT = 1;
const THEM = "926487985";

/** A profile as Grindr answers it for someone who can be seen. */
const answer = (isFavorite: boolean | undefined, overrides: Partial<ProfileDetail> = {}) =>
	({
		profileId: THEM,
		displayName: "Someone",
		age: 30,
		aboutMe: "Hello",
		lastUpdatedTime: 1_790_000_000_000,
		isFavorite,
		...overrides,
	}) as ProfileDetail;

function harness(rowFavorite: boolean | null) {
	const state = { row: rowFavorite, now: 1_000_000, account: ACCOUNT as number | null };
	const announced: FavoriteChangedDetail[] = [];
	const cached: FavoriteChangedDetail[] = [];
	const sync = createFavoriteSync({
		// Like the database: nothing changes without a chat, or when it agrees.
		setChatRowFavorite: async (_profileId, favorite) => {
			if (state.row === null || state.row === favorite) return false;
			state.row = favorite;
			return true;
		},
		setCachedProfileFavorite: (profileId, favorite) => cached.push({ profileId, favorite }),
		announce: (detail) => announced.push(detail),
		activeAccount: () => state.account,
		now: () => state.now,
	});
	return { sync, state, announced, cached };
}

describe("favourite star", () => {
	test("a star set anywhere reaches the chat row, the cached profile and the open screens", async () => {
		const { sync, state, announced, cached } = harness(false);
		await sync.toggled(THEM, true);
		expect(state.row).toBe(true);
		expect(cached).toEqual([{ profileId: THEM, favorite: true }]);
		expect(announced).toEqual([{ profileId: THEM, favorite: true }]);
	});

	test("a star set on someone with no chat is still announced", async () => {
		const { sync, state, announced } = harness(null);
		await sync.toggled(THEM, true);
		expect(state.row).toBeNull();
		expect(announced).toEqual([{ profileId: THEM, favorite: true }]);
	});

	test("a chat Grindr no longer lists loses the star Grindr no longer has", async () => {
		const { sync, state, announced } = harness(true);
		await sync.seenInProfileAnswer(ACCOUNT, answer(false), state.now);
		expect(state.row).toBe(false);
		expect(announced).toEqual([{ profileId: THEM, favorite: false }]);
	});

	test("an answer that agrees with the chat changes and announces nothing", async () => {
		const { sync, state, announced } = harness(true);
		await sync.seenInProfileAnswer(ACCOUNT, answer(true), state.now);
		expect(state.row).toBe(true);
		expect(announced).toEqual([]);
	});

	test("an answer asked before a tap on the star had settled cannot undo it", async () => {
		const { sync, state, announced } = harness(false);
		const askedBefore = state.now - 500;
		await sync.toggled(THEM, true);
		announced.length = 0;

		await sync.seenInProfileAnswer(ACCOUNT, answer(false), askedBefore);
		await sync.seenInProfileAnswer(ACCOUNT, answer(false), state.now + FAVORITE_SETTLE_MS);
		expect(state.row).toBe(true);
		expect(announced).toEqual([]);

		await sync.seenInProfileAnswer(ACCOUNT, answer(false), state.now + FAVORITE_SETTLE_MS + 1);
		expect(state.row).toBe(false);
	});

	test("an answer that says nothing about the star is left alone", async () => {
		const { sync, state, announced } = harness(true);
		// No favourite field at all.
		await sync.seenInProfileAnswer(ACCOUNT, answer(undefined), state.now);
		// The empty shell of a blocked profile.
		await sync.seenInProfileAnswer(
			ACCOUNT,
			answer(false, { displayName: "4", age: null, aboutMe: null, lastUpdatedTime: null }),
			state.now,
		);
		expect(state.row).toBe(true);
		expect(announced).toEqual([]);
	});

	test("an answer that arrives after an account switch is not written to the other account", async () => {
		const { sync, state, announced } = harness(true);
		state.account = 2;
		await sync.seenInProfileAnswer(ACCOUNT, answer(false), state.now);
		await sync.seenInProfileAnswer(null, answer(false), state.now);
		expect(state.row).toBe(true);
		expect(announced).toEqual([]);
	});

	test("the cached profile follows the star and keeps the rest", () => {
		setCachedProfileDetail(THEM, answer(false));
		setCachedProfileFavorite(THEM, true);
		expect(getCachedProfileDetail(THEM)).toMatchObject({ isFavorite: true, displayName: "Someone" });
		// Nobody cached: nothing is made up.
		setCachedProfileFavorite("12", true);
		expect(getCachedProfileDetail("12")).toBeNull();
	});
});
