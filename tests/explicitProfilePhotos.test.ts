import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
const globalScope = globalThis as unknown as { window?: unknown };
const previousWindow = globalScope.window;
afterAll(() => {
	if (previousWindow === undefined) delete globalScope.window;
	else globalScope.window = previousWindow;
});
// One hash already on record, as after a restart.
store.set("fg-explicit-profile-photos", JSON.stringify(["a".repeat(40)]));
globalScope.window = {
	localStorage: {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
	},
	dispatchEvent: () => true,
	addEventListener: () => {},
	removeEventListener: () => {},
	// Present, so the app counts as running inside Tauri.
	__TAURI_INTERNALS__: { invoke: async () => { throw new Error("not in this test"); } },
};

const {
	isExplicitProfilePhoto,
	isExplicitProfilePhotoUrl,
	rememberExplicitProfilePhoto,
	showProfilePhotosAnyway,
	showProfilePhotoUrlAnyway,
	subscribeToExplicitProfilePhotos,
} = await import("../src/services/explicitProfilePhotos");

const REMEMBERED = "a".repeat(40);
const NEW = "b".repeat(40);
const OTHER = "c".repeat(40);

describe("explicit profile photos", () => {
	beforeEach(() => {
		store.set("fg-explicit-filter", "true");
		store.delete("fg-explicit-hide-profile-photos");
	});

	test("a photo on record from an earlier session is left out from the first render", () => {
		expect(isExplicitProfilePhoto(REMEMBERED)).toBe(true);
	});

	test("any other photo is drawn as before", () => {
		expect(isExplicitProfilePhoto(OTHER)).toBe(false);
		expect(isExplicitProfilePhoto(null)).toBe(false);
	});

	test("a photo newly found explicit is remembered, kept across restarts, and announced once", () => {
		let announced = 0;
		const unsubscribe = subscribeToExplicitProfilePhotos(() => {
			announced += 1;
		});
		rememberExplicitProfilePhoto(NEW);
		rememberExplicitProfilePhoto(NEW);
		unsubscribe();
		expect(announced).toBe(1);
		expect(isExplicitProfilePhoto(NEW)).toBe(true);
		expect(JSON.parse(store.get("fg-explicit-profile-photos")!)).toContain(NEW);
	});

	test("a photo is recognised from its link too", () => {
		expect(isExplicitProfilePhotoUrl(`https://cdns.grindr.com/images/thumb/320x320/${REMEMBERED}`)).toBe(true);
		expect(isExplicitProfilePhotoUrl(`https://cdns.grindr.com/images/profile/1024x1024/${OTHER}`)).toBe(false);
		expect(isExplicitProfilePhotoUrl(null)).toBe(false);
	});

	test("shown anyway, it is no longer hidden, and whoever draws it is told", () => {
		const hash = "d".repeat(40);
		rememberExplicitProfilePhoto(hash);
		let announced = 0;
		const unsubscribe = subscribeToExplicitProfilePhotos(() => {
			announced += 1;
		});
		showProfilePhotosAnyway([hash, OTHER]);
		unsubscribe();
		expect(isExplicitProfilePhoto(hash)).toBe(false);
		expect(announced).toBe(1);
	});

	test("shown anyway from its link, it is no longer hidden", () => {
		const hash = "e".repeat(40);
		rememberExplicitProfilePhoto(hash);
		const url = `https://cdns.grindr.com/images/thumb/320x320/${hash}`;
		expect(isExplicitProfilePhotoUrl(url)).toBe(true);
		showProfilePhotoUrlAnyway(url);
		expect(isExplicitProfilePhotoUrl(url)).toBe(false);
	});

	test("with its own switch off nothing is hidden, though the filter is on", () => {
		store.set("fg-explicit-hide-profile-photos", "false");
		expect(isExplicitProfilePhoto(REMEMBERED)).toBe(false);
		expect(isExplicitProfilePhotoUrl(`https://cdns.grindr.com/images/thumb/320x320/${REMEMBERED}`)).toBe(false);
	});

	test("with the filter off nothing is left out", () => {
		store.set("fg-explicit-filter", "false");
		expect(isExplicitProfilePhoto(REMEMBERED)).toBe(false);
	});
});
