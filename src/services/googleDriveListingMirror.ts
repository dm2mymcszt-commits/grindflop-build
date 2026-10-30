import type {
	GoogleDriveChangeList,
	GoogleDriveFileList,
	GoogleDriveFileMetadata,
	GoogleDriveStartPageToken,
} from "./googleDriveSyncNative";

/**
 * An in-memory copy of this account's Google Drive app folder listing, kept
 * current through Drive's changes feed.
 *
 * Every sync used to list the whole folder seven times (three inventories,
 * one before uploading, three anchor checks per uploaded package): ~1,940
 * files each time on the PC in October 2026, about 7 s per listing, which was
 * almost all of a one-minute sync. Now the first listing of an app run is a
 * full one, and every later one asks Drive only what changed since the last.
 *
 * Correctness does not rest on the feed alone. A full listing still runs at
 * least every `fullListIntervalMs`, after any failed or interrupted read of
 * the feed, whenever a caller asks for a fresh one, and after the controller
 * sees anything inconsistent; files this device creates or deletes are noted
 * directly. Changes are read completely before any of them is applied, so a
 * failure part way through leaves the copy as it was.
 */

export interface GoogleDriveListingSource {
	listAppData(pageToken: string | null): Promise<GoogleDriveFileList>;
	getStartPageToken(): Promise<GoogleDriveStartPageToken>;
	listChanges(pageToken: string): Promise<GoogleDriveChangeList>;
}

export type GoogleDriveListingMode = "full" | "changes";

export type GoogleDriveListing = Readonly<{
	files: readonly GoogleDriveFileMetadata[];
	mode: GoogleDriveListingMode;
}>;

/** Run each remote read through the caller's retry and cancellation rules. */
export type GoogleDriveListingRead = <T>(read: () => Promise<T>) => Promise<T>;

export const GOOGLE_DRIVE_FULL_LIST_INTERVAL_MS = 60 * 60 * 1_000;

/** After the feed itself fails, how long to stop trying it. */
const CHANGES_FEED_BACKOFF_MS = 15 * 60 * 1_000;

export class GoogleDriveListingMirror {
	readonly #now: () => number;
	readonly #fullListIntervalMs: number;
	#files = new Map<string, GoogleDriveFileMetadata>();
	#pageToken: string | null = null;
	#fullListedAtMs: number | null = null;
	#feedUnavailableUntilMs = 0;

	constructor(
		options: Readonly<{ now?: () => number; fullListIntervalMs?: number }> = {},
	) {
		this.#now = options.now ?? Date.now;
		this.#fullListIntervalMs =
			options.fullListIntervalMs ?? GOOGLE_DRIVE_FULL_LIST_INTERVAL_MS;
	}

	/** The next listing is a full one. */
	invalidate(): void {
		this.#pageToken = null;
		this.#fullListedAtMs = null;
	}

	/** A file this device just created, before the feed reports it. */
	noteCreated(metadata: GoogleDriveFileMetadata): void {
		if (this.#fullListedAtMs !== null) this.#files.set(metadata.id, metadata);
	}

	/** A file this device just deleted, before the feed reports it. */
	noteDeleted(fileId: string): void {
		this.#files.delete(fileId);
	}

	async list(
		source: GoogleDriveListingSource,
		read: GoogleDriveListingRead,
		options: Readonly<{ fresh?: boolean }> = {},
	): Promise<GoogleDriveListing> {
		const now = this.#now();
		const canUseFeed =
			!options.fresh &&
			this.#pageToken !== null &&
			this.#fullListedAtMs !== null &&
			now - this.#fullListedAtMs < this.#fullListIntervalMs &&
			now >= this.#feedUnavailableUntilMs;
		if (canUseFeed) {
			try {
				await this.#applyChanges(source, read, this.#pageToken as string);
				return { files: [...this.#files.values()], mode: "changes" };
			} catch (error) {
				if (isCancellation(error)) throw error;
				// A feed that cannot be read (an expired token, a refused request)
				// is never retried blindly: list everything, then rest the feed.
				this.#feedUnavailableUntilMs = now + CHANGES_FEED_BACKOFF_MS;
				this.invalidate();
			}
		}
		await this.#listEverything(source, read);
		return { files: [...this.#files.values()], mode: "full" };
	}

	async #listEverything(
		source: GoogleDriveListingSource,
		read: GoogleDriveListingRead,
	): Promise<void> {
		// The token comes first: a change made while the listing pages through is
		// then replayed by the next feed read, which is harmless if the listing
		// already saw it and essential if it did not.
		let startToken: string | null = null;
		if (this.#now() >= this.#feedUnavailableUntilMs) {
			try {
				startToken = (await read(() => source.getStartPageToken())).startPageToken;
			} catch (error) {
				if (isCancellation(error)) throw error;
				this.#feedUnavailableUntilMs = this.#now() + CHANGES_FEED_BACKOFF_MS;
			}
		}
		const files = new Map<string, GoogleDriveFileMetadata>();
		let pageToken: string | null = null;
		const seen = new Set<string>();
		do {
			const page: GoogleDriveFileList = await read(() => source.listAppData(pageToken));
			for (const file of page.files) files.set(file.id, file);
			pageToken = page.nextPageToken;
			if (pageToken) {
				if (seen.has(pageToken)) {
					throw new Error("Google Drive returned a repeated pagination token.");
				}
				seen.add(pageToken);
			}
		} while (pageToken);
		this.#files = files;
		this.#pageToken = startToken;
		this.#fullListedAtMs = startToken === null ? null : this.#now();
	}

	async #applyChanges(
		source: GoogleDriveListingSource,
		read: GoogleDriveListingRead,
		startToken: string,
	): Promise<void> {
		const staged: Array<
			Readonly<{ fileId: string; file: GoogleDriveFileMetadata | null }>
		> = [];
		const seen = new Set<string>([startToken]);
		let token = startToken;
		for (;;) {
			const page = await read(() => source.listChanges(token));
			for (const change of page.changes) {
				staged.push({
					fileId: change.fileId,
					file: change.removed || !change.file ? null : change.file,
				});
			}
			if (page.newStartPageToken) {
				for (const change of staged) {
					if (change.file) this.#files.set(change.fileId, change.file);
					else this.#files.delete(change.fileId);
				}
				this.#pageToken = page.newStartPageToken;
				return;
			}
			if (!page.nextPageToken || seen.has(page.nextPageToken)) {
				throw new Error("Google Drive's change feed ended without a new start token.");
			}
			seen.add(page.nextPageToken);
			token = page.nextPageToken;
		}
	}
}

function isCancellation(error: unknown): boolean {
	return error instanceof Error && error.name === "GoogleDriveSyncCancelledError";
}
