import { describe, expect, test } from "bun:test";
import {
	deletionNeedsConfirmation,
	describeDeletionConfirmation,
	isSelectableMediaMessage,
	planMediaDeletion,
	type MediaSelectionItem,
} from "../src/pages/app/chat/mediaSelection";

const url = { url: "https://cdns.grindr.com/image.jpg" };

function item(messageId: string | null, mine: boolean): MediaSelectionItem {
	return { messageId, mine, kind: "image", source: url };
}

describe("isSelectableMediaMessage", () => {
	test("photos and videos can be picked", () => {
		expect(isSelectableMediaMessage({ type: "Image", chat1Type: null, unsent: false })).toBe(true);
		expect(isSelectableMediaMessage({ type: "ExpiringImage", chat1Type: null, unsent: false })).toBe(true);
		expect(isSelectableMediaMessage({ type: "Unknown", chat1Type: "private_video", unsent: false })).toBe(true);
	});

	test("albums, GIFs, voice notes, profile-photo replies and unsent messages cannot", () => {
		for (const type of ["Album", "ExpiringAlbum", "Giphy", "Audio", "ProfilePhotoReply", "Text"]) {
			expect(isSelectableMediaMessage({ type, chat1Type: null, unsent: false })).toBe(false);
		}
		expect(isSelectableMediaMessage({ type: "Image", chat1Type: null, unsent: true })).toBe(false);
	});
});

describe("planMediaDeletion", () => {
	test("unsends the user's own, deletes theirs for the user, and counts what has no message", () => {
		const plan = planMediaDeletion([item("a", true), item("b", false), item(null, false), item("a", true)]);
		expect(plan).toEqual({ unsend: ["a"], deleteForMe: ["b"], notDeletable: 1 });
	});

	test("asks for confirmation only when something of the user's is unsent", () => {
		expect(deletionNeedsConfirmation(planMediaDeletion([item("b", false), item("c", false)]))).toBe(false);
		expect(deletionNeedsConfirmation(planMediaDeletion([item("a", true), item("b", false)]))).toBe(true);
	});

	test("says what will happen to each side", () => {
		expect(describeDeletionConfirmation(planMediaDeletion([item("a", true), item("b", true), item("c", false)]))).toBe(
			"2 photos and videos you sent will be unsent for both of you, and 1 of theirs deleted for you. They are also removed from this device.",
		);
		expect(describeDeletionConfirmation(planMediaDeletion([item("a", true)]))).toBe(
			"1 photo or video you sent will be unsent for both of you. They are also removed from this device.",
		);
	});
});
