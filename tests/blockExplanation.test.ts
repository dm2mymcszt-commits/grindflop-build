import { describe, expect, test } from "bun:test";
import { explainBlock, type BlockLogEntry } from "../src/utils/blockExplanation";

const AT = 1_791_035_400_000;

function entry(overrides: Partial<BlockLogEntry>): BlockLogEntry {
	return {
		eventType: "block",
		timestamp: AT,
		method: "auto",
		source: "view_scan",
		reasonKind: "other",
		reasonDetail: null,
		reasonLabel: null,
		ruleName: null,
		...overrides,
	};
}

describe("explainBlock", () => {
	test("nothing logged explains nothing", () => {
		expect(explainBlock(null)).toBeNull();
		expect(explainBlock(undefined)).toBeNull();
	});

	// An unblock since then means whatever blocks them now was not recorded;
	// the older block's reason must not be passed off as this one's.
	test("an unblock as the newest entry explains nothing", () => {
		expect(explainBlock(entry({ eventType: "unblock", method: "manual", source: "manual" }))).toBeNull();
	});

	test("a row without a usable time explains nothing", () => {
		expect(explainBlock(entry({ timestamp: 0 }))).toBeNull();
		expect(explainBlock(entry({ timestamp: Number.NaN }))).toBeNull();
	});

	test("a manual block has no reason to give", () => {
		expect(
			explainBlock(entry({ method: "manual", source: "manual", reasonKind: null })),
		).toEqual({ timestamp: AT, automatic: false, trigger: "manual", reason: null });
		// Several people blocked at once from a selection are still manual.
		expect(
			explainBlock(entry({ method: "manual", source: "multi_select", reasonKind: null }))?.trigger,
		).toBe("manual");
	});

	test("an automatic block carries what triggered it and the keyword", () => {
		expect(
			explainBlock(
				entry({
					reasonKind: "name_keyword",
					reasonDetail: "now",
					reasonLabel: "Name keyword: now",
				}),
			),
		).toEqual({
			timestamp: AT,
			automatic: true,
			trigger: "view_scan",
			reason: { kind: "name_keyword", detail: "now", label: "Name keyword: now" },
		});
	});

	test("each automatic source is kept as the trigger", () => {
		for (const source of ["view_scan", "inbox_scan", "inbox_filter", "live_chat", "automation", "counter_block"]) {
			expect(explainBlock(entry({ source }))?.trigger).toBe(source);
		}
	});

	test("an automatic block from a source this version does not know is still automatic", () => {
		const explained = explainBlock(entry({ source: "something_new" }));
		expect(explained?.automatic).toBe(true);
		expect(explained?.trigger).toBe("unknown");
	});

	test("the age is the detail", () => {
		expect(
			explainBlock(entry({ reasonKind: "age", reasonDetail: "26", reasonLabel: "Age limit (26)" }))
				?.reason,
		).toEqual({ kind: "age", detail: "26", label: "Age limit (26)" });
	});

	test("a keyword kind without its keyword falls back to the plain one", () => {
		expect(
			explainBlock(entry({ reasonKind: "bio_keyword", reasonDetail: null, reasonLabel: "Bio keyword:" }))
				?.reason?.kind,
		).toBe("keyword");
		expect(explainBlock(entry({ reasonKind: "age", reasonDetail: "  " }))?.reason?.kind).toBe("other");
	});

	test("the three faceless findings are told apart by their sentence", () => {
		const kindOf = (reasonLabel: string) =>
			explainBlock(entry({ source: "inbox_scan", reasonKind: "faceless", reasonLabel }))?.reason?.kind;
		expect(kindOf("Faceless profile: No media sent 5min after first message")).toBe("faceless_no_media");
		expect(kindOf("Faceless profile: No face in the photos they sent")).toBe("faceless_sent_photos");
		expect(kindOf("Faceless profile: No face in profile photos")).toBe("faceless_profile_photos");
		expect(kindOf("Faceless profile")).toBe("faceless");
	});

	test("explicit photo, video and profile photo are told apart, with what was seen", () => {
		const reasonOf = (reasonLabel: string, reasonDetail: string | null = null) =>
			explainBlock(entry({ source: "inbox_scan", reasonKind: "explicit_media", reasonLabel, reasonDetail }))
				?.reason;
		expect(reasonOf("Explicit photo")?.kind).toBe("explicit_photo");
		expect(reasonOf("Explicit video")?.kind).toBe("explicit_video");
		expect(reasonOf("Explicit profile photo: bare buttocks", "bare buttocks")).toEqual({
			kind: "explicit_profile_photo",
			detail: "bare buttocks",
			label: "Explicit profile photo: bare buttocks",
		});
	});

	test("the scanner prefix is dropped from the sentence", () => {
		expect(
			explainBlock(
				entry({
					source: "inbox_scan",
					reasonKind: "first_media",
					reasonLabel: "Scanner: First message was media (Bot evasion)",
				}),
			)?.reason,
		).toEqual({ kind: "first_media", detail: null, label: "First message was media (Bot evasion)" });
	});

	test("an automation rule is named", () => {
		expect(
			explainBlock(
				entry({ source: "automation", reasonKind: "rule", ruleName: "Age limit block", reasonLabel: null }),
			)?.reason,
		).toEqual({ kind: "rule", detail: "Age limit block", label: null });
	});

	test("a kind this version has no wording for keeps the blocker's own sentence", () => {
		expect(
			explainBlock(entry({ reasonKind: "brand_new_kind", reasonLabel: "Some new rule fired" }))?.reason,
		).toEqual({ kind: "other", detail: null, label: "Some new rule fired" });
	});
});
