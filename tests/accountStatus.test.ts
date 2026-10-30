import { describe, expect, test } from "bun:test";
import {
	accountStatusKey,
	expiryToMillis,
	humanizeCode,
	parseAccountStatus,
	parseBanInfo,
	restrictionStatus,
	type AccountStatus,
} from "../src/utils/accountStatus";

// The shapes below are what the Rust side serialises; its own tests pin the
// same field names from the other end.
const deviceBan = {
	kind: "banned",
	info: {
		kind: "device",
		code: 28,
		message: "ACCOUNT_BANNED",
		reason: null,
		subReason: null,
		automated: true,
	},
};

const timedBan = {
	kind: "restriction",
	restriction: {
		kind: "timedBan",
		code: "TIMED_BAN",
		region: null,
		reason: "SPAM",
		expiresAt: 1_800_000_000,
		subReason: "MASS_MESSAGING",
		automated: false,
	},
};

describe("parseAccountStatus", () => {
	test("reads a refused renewal", () => {
		expect(parseAccountStatus(deviceBan)).toEqual(deviceBan as AccountStatus);
	});

	test("reads a restriction", () => {
		expect(parseAccountStatus(timedBan)).toEqual(timedBan as AccountStatus);
	});

	test("reads a token sign-in that has run out", () => {
		expect(parseAccountStatus({ kind: "sessionExpired" })).toEqual({ kind: "sessionExpired" });
	});

	test("nothing to report is null", () => {
		expect(parseAccountStatus(null)).toBeNull();
		expect(parseAccountStatus(undefined)).toBeNull();
	});

	// The screen it feeds covers the whole app, so anything unreadable has to
	// come out as "nothing to show" and never as a broken screen.
	test("anything it cannot read is null", () => {
		expect(parseAccountStatus({ kind: "somethingNew" })).toBeNull();
		expect(parseAccountStatus({ kind: "banned" })).toBeNull();
		expect(parseAccountStatus({ kind: "banned", info: { kind: "device" } })).toBeNull();
		expect(parseAccountStatus({ kind: "restriction", restriction: "TIMED_BAN" })).toBeNull();
		expect(parseAccountStatus("banned")).toBeNull();
		expect(parseAccountStatus(28)).toBeNull();
		expect(parseAccountStatus([])).toBeNull();
	});

	test("fields it does not know are dropped, the rest is kept", () => {
		const parsed = parseAccountStatus({
			kind: "banned",
			info: { kind: "profile", code: 27, message: "PROFILE_BANNED", addedLater: 1 },
		});
		expect(parsed).toEqual({
			kind: "banned",
			info: { kind: "profile", code: 27, message: "PROFILE_BANNED" },
		});
	});
});

describe("restrictionStatus", () => {
	test("a sign-in without a restriction has no status", () => {
		expect(restrictionStatus(null)).toBeNull();
		expect(restrictionStatus(undefined)).toBeNull();
	});

	test("a restriction becomes the status the screen shows", () => {
		expect(restrictionStatus(timedBan.restriction)).toEqual(timedBan as AccountStatus);
	});

	test("something that is not a restriction has no status", () => {
		expect(restrictionStatus("AGE_RESTRICTED")).toBeNull();
		expect(restrictionStatus({ region: "uk" })).toBeNull();
	});
});

describe("parseBanInfo", () => {
	test("reads the details a refused sign-in carries", () => {
		expect(parseBanInfo(deviceBan.info)).toEqual(deviceBan.info);
	});

	test("an ordinary error is not a ban", () => {
		expect(parseBanInfo("Not logged in")).toBeNull();
		expect(parseBanInfo({ code: 4, message: "Invalid input parameters" })).toBeNull();
		expect(parseBanInfo(undefined)).toBeNull();
	});
});

describe("accountStatusKey", () => {
	const key = (value: unknown) => accountStatusKey(parseAccountStatus(value)!);

	test("the same answer has the same key however it is spelt out", () => {
		expect(key(deviceBan)).toBe(
			key({ kind: "banned", info: { kind: "device", code: 28, message: "ACCOUNT_BANNED", automated: true } }),
		);
	});

	test("a different answer has a different key", () => {
		const base = key(deviceBan);
		expect(key({ ...deviceBan, info: { ...deviceBan.info, code: 27, kind: "profile" } })).not.toBe(base);
		expect(key({ ...deviceBan, info: { ...deviceBan.info, reason: "SPAM" } })).not.toBe(base);
		expect(key(timedBan)).not.toBe(base);
		expect(key({ kind: "sessionExpired" })).not.toBe(base);
	});

	test("a timed ban that was extended counts as new", () => {
		expect(
			key({ ...timedBan, restriction: { ...timedBan.restriction, expiresAt: 1_900_000_000 } }),
		).not.toBe(key(timedBan));
	});
});

describe("humanizeCode", () => {
	test("turns a code into words", () => {
		expect(humanizeCode("DRUG_SALES")).toBe("Drug sales");
		expect(humanizeCode("SPAM")).toBe("Spam");
		expect(humanizeCode(" MASS__MESSAGING ")).toBe("Mass messaging");
		expect(humanizeCode("LEVEL_2_WARNING")).toBe("Level 2 warning");
	});

	test("leaves text written for people alone", () => {
		expect(humanizeCode("Device risk too high")).toBe("Device risk too high");
		expect(humanizeCode("Drug Selling")).toBe("Drug Selling");
		expect(humanizeCode("spam")).toBe("spam");
	});

	test("leaves a bare number alone", () => {
		expect(humanizeCode("12")).toBe("12");
	});

	test("has nothing to say about nothing", () => {
		expect(humanizeCode("")).toBe("");
		expect(humanizeCode("   ")).toBe("");
	});
});

describe("expiryToMillis", () => {
	test("reads Unix seconds", () => {
		expect(expiryToMillis(1_800_000_000)).toBe(1_800_000_000_000);
	});

	test("takes a number too large for seconds as milliseconds", () => {
		expect(expiryToMillis(1_800_000_000_000)).toBe(1_800_000_000_000);
	});

	test("has no date for what is not a moment", () => {
		expect(expiryToMillis(null)).toBeNull();
		expect(expiryToMillis(undefined)).toBeNull();
		expect(expiryToMillis(0)).toBeNull();
		expect(expiryToMillis(-5)).toBeNull();
		expect(expiryToMillis(Number.NaN)).toBeNull();
		expect(expiryToMillis(Number.POSITIVE_INFINITY)).toBeNull();
		expect(expiryToMillis(9e18)).toBeNull();
	});
});
