import { describe, expect, test } from "bun:test";
import {
	closeAbandonedLock,
	dropLabel,
	endLock,
	formatReport,
	newReport,
	noteDrop,
	noteInboxCheck,
	noteMessage,
	noteOutcome,
	notePause,
	parseReport,
	startLock,
	summarize,
	toMs,
} from "../src/utils/backgroundReport";

const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("background report", () => {
	test("a message notified within a minute is on time, a later one is late", () => {
		const report = newReport(T0);
		startLock(report, T0, null);
		noteMessage(report, { id: "a", conversationId: "c1", sentAt: T0 + MIN }, "live", T0 + MIN + 2_000);
		noteOutcome(report, "a", "notified", T0 + MIN + 3_000);
		noteMessage(report, { id: "b", conversationId: "c2", sentAt: T0 + 2 * MIN }, "live", T0 + 6 * MIN);
		noteOutcome(report, "b", "notified", T0 + 6 * MIN);
		const s = summarize(report, T0 + 10 * MIN);
		expect(s.messages).toBe(2);
		expect(s.onTime).toBe(1);
		expect(s.late).toEqual([240]);
		expect(s.liveDelayMax).toBe(240);
	});

	test("a message only the inbox check saw is missed by the live connection", () => {
		const report = newReport(T0);
		noteMessage(report, { id: "x", conversationId: "c1", sentAt: T0 }, "inbox", T0 + 2 * MIN);
		const s = summarize(report, T0 + 3 * MIN);
		expect(s.missedByLive).toBe(1);
		expect(s.lostAfterLive).toBe(0);
	});

	test("the inbox and live views of one message are matched, even with different ids", () => {
		const report = newReport(T0);
		noteMessage(report, { id: "inbox-id", conversationId: "c1", sentAt: T0 }, "inbox", T0 + MIN);
		noteMessage(report, { id: "live-id", conversationId: "c1", sentAt: T0 + 800 }, "live", T0 + 3 * MIN);
		noteOutcome(report, "live-id", "notified", T0 + 3 * MIN);
		const s = summarize(report, T0 + 4 * MIN);
		expect(s.messages).toBe(1);
		expect(s.missedByLive).toBe(0);
		expect(s.liveAfterInbox).toBe(1);
		expect(s.late).toEqual([180]);
	});

	test("two messages in one chat a while apart stay two", () => {
		const report = newReport(T0);
		noteMessage(report, { id: "1", conversationId: "c1", sentAt: T0 }, "live", T0);
		noteMessage(report, { id: "2", conversationId: "c1", sentAt: T0 + 10_000 }, "live", T0 + 10_000);
		expect(summarize(report, T0 + MIN).messages).toBe(2);
	});

	test("blocked, not announced and lost messages are told apart", () => {
		const report = newReport(T0);
		noteMessage(report, { id: "b", conversationId: "c1", sentAt: T0 }, "live", T0);
		noteOutcome(report, "b", "blocked", T0);
		noteMessage(report, { id: "o", conversationId: "c2", sentAt: T0 }, "live", T0);
		noteOutcome(report, "o", "chat notifications off", T0);
		noteMessage(report, { id: "l", conversationId: "c3", sentAt: T0 }, "live", T0);
		const s = summarize(report, T0 + MIN);
		expect(s.blocked).toBe(1);
		expect(s.notAnnounced).toEqual({ "chat notifications off": 1 });
		expect(s.lostAfterLive).toBe(1);
	});

	test("only the first outcome counts", () => {
		const report = newReport(T0);
		noteMessage(report, { id: "a", conversationId: "c1", sentAt: T0 }, "live", T0);
		noteOutcome(report, "a", "blocked", T0);
		noteOutcome(report, "a", "notified", T0 + 1000);
		expect(summarize(report, T0 + MIN).blocked).toBe(1);
	});

	test("battery per hour leaves out charging periods and needs a quarter hour", () => {
		const report = newReport(T0);
		startLock(report, T0, { level: 80, charging: false });
		endLock(report, T0 + 2 * HOUR, { level: 76, charging: false });
		startLock(report, T0 + 3 * HOUR, { level: 76, charging: true });
		endLock(report, T0 + 4 * HOUR, { level: 90, charging: true });
		const s = summarize(report, T0 + 5 * HOUR);
		expect(s.batteryPerHour).toBeCloseTo(2, 5);
		expect(s.lockedHours).toBeCloseTo(3, 5);

		const short = newReport(T0);
		startLock(short, T0, { level: 80, charging: false });
		endLock(short, T0 + 5 * MIN, { level: 79, charging: false });
		expect(summarize(short, T0 + HOUR).batteryPerHour).toBeNull();
	});

	test("a lock is opened once and closed once", () => {
		const report = newReport(T0);
		startLock(report, T0, null);
		startLock(report, T0 + MIN, null);
		endLock(report, T0 + 2 * MIN, null);
		endLock(report, T0 + 3 * MIN, null);
		expect(report.locks).toEqual([{ from: T0, to: T0 + 2 * MIN, batteryFrom: undefined, batteryTo: undefined }]);
	});

	test("the copied text has counts but no ids", () => {
		const report = newReport(T0);
		startLock(report, T0, { level: 90, charging: false });
		noteMessage(report, { id: "secret-id", conversationId: "secret-conv", sentAt: T0 }, "live", T0);
		noteOutcome(report, "secret-id", "notified", T0 + 5_000);
		noteDrop(report, "silent 5 min");
		noteInboxCheck(report, true);
		noteInboxCheck(report, false);
		notePause(report, 3 * MIN);
		endLock(report, T0 + HOUR, { level: 88, charging: false });
		const text = formatReport(report, T0 + HOUR, ["build test"]);
		expect(text).not.toContain("secret");
		expect(text).toContain("1 notified < 1 min");
		expect(text).toContain("silent 5 min ×1");
		expect(text).toContain("2.0 %/h");
		expect(text).toContain("1 ok, 1 failed");
		expect(text).toContain("paused 1× (longest 3 min)");
		expect(text).toContain("build test");
	});

	test("a stored report survives the round trip; anything else is refused", () => {
		const report = newReport(T0);
		noteDrop(report, "x");
		expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
		expect(parseReport({ version: 2 })).toBeNull();
		expect(parseReport(null)).toBeNull();
	});

	test("times in seconds are read as seconds", () => {
		expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
		expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	});

	test("a lock the app never came back from is closed at its last sign of life and counted", () => {
		const report = newReport(T0);
		startLock(report, T0, null);
		report.lastBeat = T0 + 30 * MIN;
		expect(closeAbandonedLock(report)).toBe(true);
		expect(report.locks[0].to).toBe(T0 + 30 * MIN);
		expect(summarize(report, T0 + HOUR).ended).toBe(1);
		expect(closeAbandonedLock(report)).toBe(false);
	});

	test("drop reasons are short and never carry an address's query", () => {
		expect(dropLabel({ kind: "closed", code: 1006, reason: "stream-ended" })).toBe("closed 1006 (stream-ended)");
		expect(dropLabel({ kind: "silent", seconds: 300 })).toBe("silent 5 min");
		expect(dropLabel({ kind: "error", message: "HTTP error wss://x/ws?token=abc" })).toBe("error: HTTP error wss://x/ws");
		expect(dropLabel({ kind: "offline" })).toBe("offline");
		expect(dropLabel(undefined)).toBe("unknown");
	});
});
