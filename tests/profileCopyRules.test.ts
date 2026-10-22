import { describe, expect, test } from "bun:test";
import { profileDetailItemSchema } from "../src/types/grid";
import {
	COPY_REWRITE_INTERVAL_MS,
	compactProfileForStorage,
	countCopiesOverCap,
	isCopyRewriteDue,
	prepareProfileCopyForDisplay,
} from "../src/utils/profileCopyRules";

const profile = profileDetailItemSchema.parse({
	profileId: 924000111,
	displayName: "Tom",
	age: 23,
	onlineUntil: 1_790_000_000_000,
	seen: 1_789_999_000_000,
	lastUpdatedTime: 1_789_000_000_000,
	distance: 3000,
	aboutMe: "Venez parler",
	profileTags: ["oral", "bi"],
	medias: [{ mediaHash: "a".repeat(40) }],
	profileImageMediaHash: "a".repeat(40),
	height: 176,
	weight: 66000,
	lookingFor: [2, 3],
	rightNowText: "free now",
	rightNowThumbnailUrl: "https://example.test/now.jpg",
	isVisiting: true,
	travelPlans: [{ id: 1, locationName: "Paris" }],
});

// The same person as Grindr sends them: every field present, most of them null.
const profileWithGaps = profileDetailItemSchema.parse({
	...profile,
	identity: null,
	nsfw: null,
	bodyType: null,
	ethnicity: null,
	relationshipStatus: null,
	sexualPosition: null,
	hivStatus: null,
	lastTestedDate: null,
	rightNow: null,
	rightNowPosted: null,
	rightNowDistance: null,
	rightNowFullImageUrl: null,
	rightNowShareLocation: null,
	verifiedInstagramId: null,
	lastThrobTimestamp: null,
	lastViewed: null,
	lastChatTimestamp: null,
	lastReceivedTapTimestamp: null,
	arrivalDays: null,
	foundVia: null,
	tapType: null,
	isBlockable: null,
});

describe("compactProfileForStorage", () => {
	test("leaves out what is null and what is empty", () => {
		const compact = compactProfileForStorage(profileWithGaps);
		expect(compact.displayName).toBe("Tom");
		expect(compact.profileTags).toEqual(["oral", "bi"]);
		expect("bodyType" in compact).toBe(false);
		expect("ethnicity" in compact).toBe(false);
		expect("grindrTribes" in compact).toBe(false);
		expect("hashtags" in compact).toBe(false);
	});

	test("keeps false and zero, which are answers and not gaps", () => {
		const compact = compactProfileForStorage(
			profileDetailItemSchema.parse({ profileId: 1, showAge: false, nsfw: 0 }),
		);
		expect(compact.showAge).toBe(false);
		expect(compact.nsfw).toBe(0);
	});

	// What the store relies on: nothing is lost by leaving the gaps out.
	test("reads back through the schema as the same profile", () => {
		const restored = profileDetailItemSchema.parse(compactProfileForStorage(profile));
		expect(restored).toEqual(profile);
	});

	test("is much smaller than the profile written whole", () => {
		const whole = JSON.stringify(profileWithGaps).length;
		const compact = JSON.stringify(compactProfileForStorage(profileWithGaps)).length;
		expect(compact).toBeLessThan(whole * 0.7);
		// The figure the size estimate given to the user rests on.
		expect(compact).toBeLessThan(1024);
	});
});

describe("prepareProfileCopyForDisplay", () => {
	const shown = prepareProfileCopyForDisplay(profile);

	test("takes out what was only true when the copy was saved", () => {
		expect(shown.onlineUntil).toBeNull();
		expect(shown.seen).toBeNull();
		expect(shown.distance).toBeNull();
		expect(shown.rightNowText).toBeNull();
		expect(shown.rightNowThumbnailUrl).toBeNull();
		expect(shown.isVisiting).toBe(false);
		expect(shown.travelPlans).toEqual([]);
	});

	test("keeps who the person is", () => {
		expect(shown.profileId).toBe("924000111");
		expect(shown.displayName).toBe("Tom");
		expect(shown.age).toBe(23);
		expect(shown.aboutMe).toBe("Venez parler");
		expect(shown.profileTags).toEqual(["oral", "bi"]);
		expect(shown.medias).toEqual(profile.medias);
		expect(shown.height).toBe(176);
		expect(shown.lookingFor).toEqual([2, 3]);
	});

	test("does not change the saved copy itself", () => {
		expect(profile.distance).toBe(3000);
		expect(profile.rightNowText).toBe("free now");
	});
});

describe("isCopyRewriteDue", () => {
	test("a profile never written is due", () => {
		expect(isCopyRewriteDue(undefined, 1_000)).toBe(true);
	});

	test("one written moments ago is not", () => {
		expect(isCopyRewriteDue(1_000, 1_000 + COPY_REWRITE_INTERVAL_MS - 1)).toBe(false);
	});

	test("it is due again once the interval has passed", () => {
		expect(isCopyRewriteDue(1_000, 1_000 + COPY_REWRITE_INTERVAL_MS)).toBe(true);
	});
});

describe("countCopiesOverCap", () => {
	test("nothing goes while the tier is within its cap", () => {
		expect(countCopiesOverCap(0, 100)).toBe(0);
		expect(countCopiesOverCap(100, 100)).toBe(0);
	});

	test("only what is over the cap goes", () => {
		expect(countCopiesOverCap(103, 100)).toBe(3);
	});
});
