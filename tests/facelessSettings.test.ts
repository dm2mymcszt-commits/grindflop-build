import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
const globalScope = globalThis as unknown as { window?: unknown };
const previousWindow = globalScope.window;
afterAll(() => {
	if (previousWindow === undefined) delete globalScope.window;
	else globalScope.window = previousWindow;
});
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
};

const {
	clampNoFacePhotoDelayMinutes,
	DEFAULT_NO_FACE_PHOTO_DELAY_MINUTES,
	getNeedFaceSince,
	getNoFacePhotoDelayMinutes,
	getNoFacePhotoSince,
	getNoPhotoDelayMinutes,
	isNeedFaceEnabled,
	isNoFacePhotoRuleEnabled,
	isNoPhotoRuleEnabled,
	saveFacelessSettings,
} = await import("../src/utils/facelessSettings");

const OFF = {
	noPhotoRule: false,
	noPhotoDelayMinutes: "5",
	needFace: false,
	noFacePhotoRule: false,
	noFacePhotoDelayMinutes: 30,
};

describe("faceless settings", () => {
	beforeEach(() => {
		store.clear();
	});

	test("everything is off until saved on", () => {
		expect(isNoPhotoRuleEnabled()).toBe(false);
		expect(isNoFacePhotoRuleEnabled()).toBe(false);
		expect(isNeedFaceEnabled()).toBe(false);
		expect(getNoPhotoDelayMinutes()).toBe(5);
		expect(getNoFacePhotoDelayMinutes()).toBe(DEFAULT_NO_FACE_PHOTO_DELAY_MINUTES);
		expect(getNoFacePhotoSince()).toBeNull();
		expect(getNeedFaceSince()).toBeNull();
	});

	test("switching the stricter options on stamps the moment", () => {
		const before = Date.now();
		saveFacelessSettings({ ...OFF, needFace: true, noFacePhotoRule: true, noFacePhotoDelayMinutes: 120 });
		expect(isNeedFaceEnabled()).toBe(true);
		expect(isNoFacePhotoRuleEnabled()).toBe(true);
		expect(getNoFacePhotoDelayMinutes()).toBe(120);
		expect(getNoFacePhotoSince()).toBeGreaterThanOrEqual(before);
		expect(getNeedFaceSince()).toBeGreaterThanOrEqual(before);
	});

	test("saving again while on keeps the first moment", () => {
		saveFacelessSettings({ ...OFF, noFacePhotoRule: true });
		store.set("fg-block-faceless-photos-since", "1000");
		saveFacelessSettings({ ...OFF, noFacePhotoRule: true, noFacePhotoDelayMinutes: 45 });
		expect(getNoFacePhotoSince()).toBe(1000);
	});

	test("off and on again starts over", () => {
		saveFacelessSettings({ ...OFF, noFacePhotoRule: true });
		store.set("fg-block-faceless-photos-since", "1000");
		saveFacelessSettings(OFF);
		saveFacelessSettings({ ...OFF, noFacePhotoRule: true });
		expect(getNoFacePhotoSince()).toBeGreaterThan(1000);
	});

	test("an option left on by an older build counts as off until it is saved on again", () => {
		store.set("fg-block-faceless-photos", "true");
		expect(isNoFacePhotoRuleEnabled()).toBe(false);
		const before = Date.now();
		saveFacelessSettings({ ...OFF, noFacePhotoRule: true });
		expect(isNoFacePhotoRuleEnabled()).toBe(true);
		expect(getNoFacePhotoSince()).toBeGreaterThanOrEqual(before);
	});

	test("the wait is kept between a minute and a week", () => {
		expect(clampNoFacePhotoDelayMinutes(0)).toBe(1);
		expect(clampNoFacePhotoDelayMinutes(-5)).toBe(1);
		expect(clampNoFacePhotoDelayMinutes(90.4)).toBe(90);
		expect(clampNoFacePhotoDelayMinutes(999_999)).toBe(7 * 24 * 60);
		expect(clampNoFacePhotoDelayMinutes(Number.NaN)).toBe(DEFAULT_NO_FACE_PHOTO_DELAY_MINUTES);
	});
});
