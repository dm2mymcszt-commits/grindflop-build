import { describe, expect, test } from "bun:test";
import { presenceFromProfileAnswer } from "../src/services/chatPresenceSync";

const DAY = 24 * 60 * 60_000;
const THEN = 1_791_463_810_000;

/** The chat as it was left the day Grindr stopped listing it. */
const savedChat = { lastOnline: THEN, onlineUntil: null, distanceMetres: 4743.5 };

describe("chat presence from a profile answer", () => {
	test("the distance follows the profile", () => {
		expect(
			presenceFromProfileAnswer(savedChat, { seen: THEN, onlineUntil: null, distance: 739_500 }),
		).toEqual({ lastOnline: THEN, onlineUntil: null, distanceMetres: 739_500 });
	});

	test("a later last-online time replaces the saved one, with its online window", () => {
		const seen = THEN + 2 * DAY;
		expect(
			presenceFromProfileAnswer(savedChat, {
				seen,
				onlineUntil: seen + 600_000,
				distance: 4743.5,
			}),
		).toEqual({ lastOnline: seen, onlineUntil: seen + 600_000, distanceMetres: 4743.5 });
	});

	test("an online window that has ended is cleared with the same last-online time", () => {
		expect(
			presenceFromProfileAnswer(
				{ ...savedChat, onlineUntil: THEN + 600_000 },
				{ seen: THEN, onlineUntil: null, distance: 4743.5 },
			),
		).toEqual({ lastOnline: THEN, onlineUntil: null, distanceMetres: 4743.5 });
	});

	test("an answer that says the same changes nothing", () => {
		expect(
			presenceFromProfileAnswer(savedChat, { seen: THEN, onlineUntil: null, distance: 4743.9 }),
		).toBeNull();
	});

	test("what the answer does not carry leaves what the chat has", () => {
		// Hidden distance, and the server's 0 for a masked last-online time.
		expect(presenceFromProfileAnswer(savedChat, { seen: 0, onlineUntil: 0, distance: null })).toBeNull();
		expect(
			presenceFromProfileAnswer(savedChat, { seen: undefined, onlineUntil: undefined, distance: undefined }),
		).toBeNull();
	});

	test("a last-online time older than the chat's is never written", () => {
		expect(
			presenceFromProfileAnswer(savedChat, { seen: THEN - DAY, onlineUntil: null, distance: 4743.5 }),
		).toBeNull();
	});

	test("a chat that knew nothing takes whatever the answer has", () => {
		expect(
			presenceFromProfileAnswer(
				{ lastOnline: null, onlineUntil: null, distanceMetres: null },
				{ seen: THEN, onlineUntil: null, distance: 0 },
			),
		).toEqual({ lastOnline: THEN, onlineUntil: null, distanceMetres: 0 });
	});
});
