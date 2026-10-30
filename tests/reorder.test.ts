import { describe, expect, test } from "bun:test";
import { moveItemTo } from "../src/utils/reorder";

describe("moveItemTo", () => {
	const phrases = ["hey", "where are you?", "see you", "thanks"];

	test("moves an item down to where another one is", () => {
		expect(moveItemTo(phrases, "hey", "see you")).toEqual(["where are you?", "see you", "hey", "thanks"]);
	});

	test("moves an item up to where another one is", () => {
		expect(moveItemTo(phrases, "thanks", "where are you?")).toEqual(["hey", "thanks", "where are you?", "see you"]);
	});

	test("moves to either end", () => {
		expect(moveItemTo(phrases, "hey", "thanks")).toEqual(["where are you?", "see you", "thanks", "hey"]);
		expect(moveItemTo(phrases, "thanks", "hey")).toEqual(["thanks", "hey", "where are you?", "see you"]);
	});

	test("an item dropped on itself changes nothing", () => {
		expect(moveItemTo(phrases, "hey", "hey")).toBeNull();
	});

	test("an item that is not in the list changes nothing", () => {
		expect(moveItemTo(phrases, "gone", "hey")).toBeNull();
		expect(moveItemTo(phrases, "hey", "gone")).toBeNull();
		expect(moveItemTo([], "hey", "hey")).toBeNull();
	});

	test("leaves the list it was given alone", () => {
		const before = phrases.slice();
		moveItemTo(phrases, "hey", "thanks");
		expect(phrases).toEqual(before);
	});
});
