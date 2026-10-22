import { describe, expect, spyOn, test } from "bun:test";
import * as chatDb from "../src/services/chatDb";
import * as contactIndex from "../src/services/chatContactIndex";
import { interestViewsStore } from "../src/services/interestViewsStore";
import {
	DELETABLE_BACKUP_SECTIONS,
	SYNCED_BACKUP_SECTIONS,
	deleteStoredSections,
} from "../src/services/backup";

function stubStores() {
	const clearTables = spyOn(chatDb, "clearPortableTables").mockResolvedValue(undefined);
	const blankColumns = spyOn(chatDb, "blankPortableTableColumns").mockResolvedValue(
		undefined,
	);
	const clearContacts = spyOn(contactIndex, "clearContactIndexTables").mockResolvedValue(
		undefined,
	);
	const clearViews = spyOn(interestViewsStore, "clear").mockResolvedValue(undefined);
	return {
		clearTables,
		blankColumns,
		clearContacts,
		clearViews,
		restore: () => {
			clearTables.mockRestore();
			blankColumns.mockRestore();
			clearContacts.mockRestore();
			clearViews.mockRestore();
		},
	};
}

describe("stored data manager", () => {
	test("removing album media keeps the albums it belongs to", async () => {
		const stubs = stubStores();
		try {
			await deleteStoredSections(["albumMedia"]);

			// The albums table carries both album metadata, which belongs to the
			// core section and is never offered for removal, and the cached cover
			// image. Dropping the table would delete the album with its cover.
			const clearedTables = stubs.clearTables.mock.calls.flatMap((call) => call[0]);
			expect(clearedTables).toContain("album_media");
			expect(clearedTables).not.toContain("albums");
			expect(stubs.blankColumns).toHaveBeenCalledWith("albums", [
				"preview_cover_base64",
				"preview_cover_mime_type",
			]);
		} finally {
			stubs.restore();
		}
	});

	test("removing the profile index touches only the contact index", async () => {
		const stubs = stubStores();
		try {
			await deleteStoredSections(["index"]);
			expect(stubs.clearContacts).toHaveBeenCalledWith([
				"chat_contact_index",
				"chat_local_profile_meta",
			]);
			expect(stubs.clearTables).not.toHaveBeenCalled();
			expect(stubs.clearViews).not.toHaveBeenCalled();
		} finally {
			stubs.restore();
		}
	});

	test("sections outside the deletable set are ignored", async () => {
		const stubs = stubStores();
		try {
			// "core" is the account itself and "local" is a settings reset; neither
			// is offered, and passing them must not fall through to a wipe.
			await deleteStoredSections(["core", "local"] as never);
			expect(stubs.clearTables).not.toHaveBeenCalled();
			expect(stubs.clearContacts).not.toHaveBeenCalled();
			expect(stubs.clearViews).not.toHaveBeenCalled();
			expect(stubs.blankColumns).not.toHaveBeenCalled();
		} finally {
			stubs.restore();
		}
	});

	test("the offered sections exclude the account itself", () => {
		expect(DELETABLE_BACKUP_SECTIONS).not.toContain("core");
		expect(DELETABLE_BACKUP_SECTIONS).not.toContain("local");
		// Media is never uploaded, so only these two can reach another device.
		expect([...SYNCED_BACKUP_SECTIONS].sort()).toEqual(["index", "views"]);
	});
});
