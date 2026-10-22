import { describe, expect, test } from "bun:test";
import {
	establishViewAutoBlockBaseline,
	isNewViewEvent,
	markViewProcessed,
} from "../src/services/interestViewAutoBlockState";

const MINUTE = 60_000;

describe("viewer auto-block state", () => {
	test("a viewer with no live event is still new when a later viewer was handled first", () => {
		// The 2026-10-21 case: B's live view is handled at once; A had no live
		// event, and the list gives A's view a time a little before B's.
		const account = "880000001";
		const now = Date.now();
		establishViewAutoBlockBaseline(account, [now - 60 * MINUTE]);
		markViewProcessed(account, "920000003", now, 1);
		expect(isNewViewEvent(account, "900000002", now - 20_000, 1)).toBe(true);
	});

	test("a view already handled is not new again", () => {
		const account = "880000002";
		const now = Date.now();
		establishViewAutoBlockBaseline(account, [now - 60 * MINUTE]);
		markViewProcessed(account, "900000002", now - 20_000, 1);
		markViewProcessed(account, "920000003", now, 1);
		expect(isNewViewEvent(account, "900000002", now - 20_000, 1)).toBe(false);
	});

	test("history from before the baseline stays history", () => {
		const account = "880000003";
		const now = Date.now();
		establishViewAutoBlockBaseline(account, [now - 5 * MINUTE]);
		expect(isNewViewEvent(account, "900000002", now - 10 * MINUTE, 1)).toBe(false);
	});

	test("views far behind the newest handled one are history", () => {
		const account = "880000004";
		const now = Date.now();
		establishViewAutoBlockBaseline(account, [now - 3 * 60 * MINUTE]);
		markViewProcessed(account, "920000003", now, 1);
		expect(isNewViewEvent(account, "900000002", now - 60 * MINUTE, 1)).toBe(false);
	});
});
