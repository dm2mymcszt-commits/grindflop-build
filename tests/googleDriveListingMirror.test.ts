import { describe, expect, test } from "bun:test";
import {
	GOOGLE_DRIVE_FULL_LIST_INTERVAL_MS,
	GoogleDriveListingMirror,
	type GoogleDriveListingSource,
} from "../src/services/googleDriveListingMirror";
import type {
	GoogleDriveChangeList,
	GoogleDriveFileList,
	GoogleDriveFileMetadata,
} from "../src/services/googleDriveSyncNative";

function file(id: string, md5 = `md5-${id}`): GoogleDriveFileMetadata {
	return {
		id,
		name: `name-${id}`,
		mimeType: "application/octet-stream",
		size: "10",
		modifiedTime: "2026-10-30T12:00:00Z",
		md5Checksum: md5,
	};
}

/** Google Drive's app folder with a real-shaped changes feed. */
class FakeDrive implements GoogleDriveListingSource {
	readonly files = new Map<string, GoogleDriveFileMetadata>();
	/** Every change ever made, in order; a page token is an index into it. */
	readonly history: Array<{ fileId: string; file: GoogleDriveFileMetadata | null }> = [];
	pageSize = 1_000;
	changesPageSize = 1_000;
	listCalls = 0;
	changeCalls = 0;
	failChanges = 0;
	failStartToken = false;
	onList: (() => void) | null = null;

	put(metadata: GoogleDriveFileMetadata): void {
		this.files.set(metadata.id, metadata);
		this.history.push({ fileId: metadata.id, file: metadata });
	}

	remove(id: string): void {
		this.files.delete(id);
		this.history.push({ fileId: id, file: null });
	}

	async getStartPageToken() {
		if (this.failStartToken) throw new Error("start token refused");
		return { startPageToken: `t${this.history.length}` };
	}

	async listAppData(pageToken: string | null): Promise<GoogleDriveFileList> {
		this.listCalls += 1;
		this.onList?.();
		const all = [...this.files.values()];
		const start = pageToken ? Number(pageToken) : 0;
		const end = start + this.pageSize;
		return {
			files: all.slice(start, end),
			nextPageToken: end < all.length ? String(end) : null,
		};
	}

	async listChanges(pageToken: string): Promise<GoogleDriveChangeList> {
		this.changeCalls += 1;
		if (this.failChanges > 0) {
			this.failChanges -= 1;
			throw new Error("change feed refused");
		}
		const start = Number(pageToken.slice(1));
		const slice = this.history.slice(start, start + this.changesPageSize);
		const end = start + slice.length;
		const done = end >= this.history.length;
		return {
			changes: slice.map((change) => ({
				fileId: change.fileId,
				removed: change.file === null,
				file: change.file,
			})),
			nextPageToken: done ? null : `t${end}`,
			newStartPageToken: done ? `t${end}` : null,
		};
	}
}

const direct = <T>(read: () => Promise<T>) => read();
const ids = (files: readonly GoogleDriveFileMetadata[]) => files.map((f) => f.id).sort();

describe("Google Drive listing mirror", () => {
	test("lists everything once, then asks only for what changed", async () => {
		const drive = new FakeDrive();
		drive.pageSize = 2;
		for (const id of ["a", "b", "c"]) drive.put(file(id));
		const mirror = new GoogleDriveListingMirror();

		const first = await mirror.list(drive, direct);
		expect(first.mode).toBe("full");
		expect(ids(first.files)).toEqual(["a", "b", "c"]);
		expect(drive.listCalls).toBe(2);

		const second = await mirror.list(drive, direct);
		expect(second.mode).toBe("changes");
		expect(ids(second.files)).toEqual(["a", "b", "c"]);
		expect(drive.listCalls).toBe(2);
		expect(drive.changeCalls).toBe(1);
	});

	test("new and removed files show up from the feed", async () => {
		const drive = new FakeDrive();
		drive.put(file("a"));
		drive.put(file("b"));
		const mirror = new GoogleDriveListingMirror();
		await mirror.list(drive, direct);
		drive.put(file("c"));
		drive.remove("a");
		drive.put(file("b", "md5-b-changed"));
		const listing = await mirror.list(drive, direct);
		expect(listing.mode).toBe("changes");
		expect(ids(listing.files)).toEqual(["b", "c"]);
		expect(listing.files.find((f) => f.id === "b")?.md5Checksum).toBe("md5-b-changed");
	});

	test("a change made while the full listing pages through is not lost", async () => {
		const drive = new FakeDrive();
		drive.pageSize = 1;
		drive.put(file("a"));
		drive.put(file("b"));
		const mirror = new GoogleDriveListingMirror();
		let once = false;
		drive.onList = () => {
			if (once) return;
			once = true;
			// Created after the listing's token was taken, past its first page.
			drive.put(file("z"));
		};
		await mirror.list(drive, direct);
		drive.onList = null;
		expect(ids((await mirror.list(drive, direct)).files)).toEqual(["a", "b", "z"]);
	});

	test("a feed that fails falls back to a full listing, then rests", async () => {
		let now = 1_000;
		const drive = new FakeDrive();
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror({ now: () => now });
		await mirror.list(drive, direct);
		drive.put(file("b"));
		drive.failChanges = 1;
		const listing = await mirror.list(drive, direct);
		expect(listing.mode).toBe("full");
		expect(ids(listing.files)).toEqual(["a", "b"]);
		// Within the rest period the feed is not tried again.
		now += 60_000;
		const calls = drive.changeCalls;
		expect((await mirror.list(drive, direct)).mode).toBe("full");
		expect(drive.changeCalls).toBe(calls);
		now += 15 * 60_000;
		await mirror.list(drive, direct);
		expect((await mirror.list(drive, direct)).mode).toBe("changes");
	});

	test("a feed read that stops part way through changes nothing", async () => {
		const drive = new FakeDrive();
		drive.changesPageSize = 1;
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror();
		await mirror.list(drive, direct);
		drive.put(file("b"));
		drive.put(file("c"));
		let reads = 0;
		const failSecondPage = <T>(read: () => Promise<T>) => {
			reads += 1;
			if (reads === 2) throw new Error("connection lost");
			return read();
		};
		// The second page fails: nothing from the first page may be applied on
		// its own; the mirror lists everything instead.
		const listing = await mirror.list(drive, failSecondPage);
		expect(listing.mode).toBe("full");
		expect(ids(listing.files)).toEqual(["a", "b", "c"]);
	});

	test("lists everything again at least once an hour", async () => {
		let now = 0;
		const drive = new FakeDrive();
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror({ now: () => now });
		await mirror.list(drive, direct);
		now = GOOGLE_DRIVE_FULL_LIST_INTERVAL_MS - 1;
		expect((await mirror.list(drive, direct)).mode).toBe("changes");
		now = GOOGLE_DRIVE_FULL_LIST_INTERVAL_MS;
		expect((await mirror.list(drive, direct)).mode).toBe("full");
	});

	test("a caller can always ask for a fresh listing", async () => {
		const drive = new FakeDrive();
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror();
		await mirror.list(drive, direct);
		expect((await mirror.list(drive, direct, { fresh: true })).mode).toBe("full");
		mirror.invalidate();
		expect((await mirror.list(drive, direct)).mode).toBe("full");
	});

	test("without a start token every listing is a full one", async () => {
		const drive = new FakeDrive();
		drive.failStartToken = true;
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror();
		expect((await mirror.list(drive, direct)).mode).toBe("full");
		drive.failStartToken = false;
		expect((await mirror.list(drive, direct)).mode).toBe("full");
	});

	test("files this device creates or deletes are reflected at once", async () => {
		const drive = new FakeDrive();
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror();
		await mirror.list(drive, direct);
		mirror.noteCreated(file("mine"));
		mirror.noteDeleted("a");
		// Drive has not reported either yet (the history has no entries for them).
		drive.files.set("mine", file("mine"));
		drive.files.delete("a");
		expect(ids((await mirror.list(drive, direct)).files)).toEqual(["mine"]);
	});

	test("a cancelled read is passed on, not turned into a full listing", async () => {
		const drive = new FakeDrive();
		drive.put(file("a"));
		const mirror = new GoogleDriveListingMirror();
		await mirror.list(drive, direct);
		const cancelled = new Error("cancelled");
		cancelled.name = "GoogleDriveSyncCancelledError";
		await expect(
			mirror.list(drive, () => {
				throw cancelled;
			}),
		).rejects.toBe(cancelled);
		expect((await mirror.list(drive, direct)).mode).toBe("changes");
	});
});
