import { describe, expect, test } from "bun:test";
import {
	blockEventId,
	findSameBlockEvent,
	SAME_BLOCK_EVENT_WINDOW_MS,
} from "../src/utils/blockEventIdentity";

const CONVERSATION = "880000001:900000002";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// The block the PC and the iPhone both recorded, a second apart.
const PC_SAW = 1789407419460;
const PHONE_SAW = 1789407420495;

const row = (id: string, event_type: string, timestamp: number) => ({
	id,
	event_type,
	timestamp,
});

describe("block event identity", () => {
	test("two devices noticing the same block write the same row", () => {
		expect(blockEventId(CONVERSATION, "blocked", PC_SAW)).toBe(
			blockEventId(CONVERSATION, "blocked", PHONE_SAW),
		);
	});

	test("the id keeps the usual shape, with the time rounded to the window", () => {
		const id = blockEventId(CONVERSATION, "blocked", PC_SAW);
		const slot = Number(id.split(":").at(-1));
		expect(id.startsWith(`${CONVERSATION}:blocked:`)).toBe(true);
		expect(slot % SAME_BLOCK_EVENT_WINDOW_MS).toBe(0);
		expect(PC_SAW - slot).toBeLessThan(SAME_BLOCK_EVENT_WINDOW_MS);
	});

	test("a row that synced in from the other device is found again", () => {
		const phoneRow = row(`${CONVERSATION}:blocked:${PHONE_SAW}`, "blocked", PHONE_SAW);
		expect(findSameBlockEvent([phoneRow], "blocked", PC_SAW)).toBe(phoneRow);
	});

	test("sightings either side of a rounding boundary still match", () => {
		const boundary = Math.ceil(PC_SAW / SAME_BLOCK_EVENT_WINDOW_MS) * SAME_BLOCK_EVENT_WINDOW_MS;
		const before = row("a", "blocked", boundary - 1_000);
		expect(blockEventId(CONVERSATION, "blocked", boundary - 1_000)).not.toBe(
			blockEventId(CONVERSATION, "blocked", boundary + 1_000),
		);
		expect(findSameBlockEvent([before], "blocked", boundary + 1_000)).toBe(before);
	});

	test("blocking again weeks later is a new event", () => {
		const first = row("a", "blocked", PC_SAW - 27 * DAY);
		expect(findSameBlockEvent([first], "blocked", PC_SAW)).toBeNull();
	});

	test("an unblock in between makes it a new block, however soon", () => {
		const stored = [
			row("a", "blocked", PC_SAW - 3 * MINUTE),
			row("b", "unblocked", PC_SAW - 2 * MINUTE),
		];
		expect(findSameBlockEvent(stored, "blocked", PC_SAW)).toBeNull();
	});

	test("an unblock is never matched to a block", () => {
		const stored = [row("a", "blocked", PC_SAW)];
		expect(findSameBlockEvent(stored, "unblocked", PC_SAW + 1_000)).toBeNull();
	});

	test("the closest earlier sighting wins", () => {
		const far = row("far", "blocked", PC_SAW - 8 * MINUTE);
		const near = row("near", "blocked", PC_SAW - 1_000);
		expect(findSameBlockEvent([far, near], "blocked", PC_SAW)).toBe(near);
	});
});
