import * as chatDb from "./chatDb";
import * as contactIndex from "./chatContactIndex";
import {
	exportInterestViewRows,
	importInterestViewRows,
	interestViewsStore,
	type StoredInterestView,
} from "./interestViewsStore";
import {
	DEVICE_LOCAL_KEYS,
	getDeviceId,
	getDeviceName,
	getAckForPeer,
	getPeer,
	recordPeerImport,
} from "./backupPeers";
import { appLog } from "../utils/logger";
import { translate } from "../utils/translate";
import { BLOCK_IMPORT_STORAGE_PREFIX } from "../utils/blockListImportRules";

/**
 * Backup v2 — a device transfer, not just a chat archive.
 *
 * v1 dumped ten tables of the per-account chat database into a single
 * JSON.stringify. That had two problems this format exists to solve:
 *
 *  1. It missed most of what makes two installs look alike. The contact
 *     index (tens of thousands of rows, device-global, in its own sqlite
 *     file), the banked viewer identities in IndexedDB, the block history,
 *     and every localStorage-backed setting — auto-block rules, ghost mode,
 *     whitelist, theme — were all absent. Restoring a v1 file gave you your
 *     messages back and left you re-configuring everything by hand.
 *
 *  2. It could not physically write a large account. Cached media lives as
 *     base64 TEXT inside sqlite, so a well-used profile is a few hundred
 *     megabytes; building that as one JS string, then a second copy inside a
 *     Blob, exhausts the webview before a byte reaches disk.
 *
 * So v2 is NDJSON: a header line, then one self-describing line per row.
 * Both directions stream — the exporter pages each table and hands off
 * batches, the importer decodes the file in chunks — so peak memory is a
 * page, not an account. Rows are grouped into sections the user can pick
 * from, which is what makes a settings-only sync a few megabytes while a
 * full mirror stays possible.
 */

export const BACKUP_VERSION = 2;
const BACKUP_KIND = "free-grind-backup";

export type BackupSection =
	| "core"
	| "index"
	| "views"
	| "local"
	| "chatMedia"
	| "albumMedia"
	| "avatars";

/** Sections in the order they're written, and shown, on the export screen. */
export const BACKUP_SECTIONS: BackupSection[] = [
	"core",
	"index",
	"views",
	"local",
	"chatMedia",
	"albumMedia",
	"avatars",
];

/**
 * Always exported. Without conversations and settings the file can't
 * reconstruct an account at all, so it isn't offered as a choice.
 */
export const REQUIRED_SECTIONS: BackupSection[] = ["core"];

export function isBackupSection(value: string): value is BackupSection {
	return (BACKUP_SECTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Table registry
// ---------------------------------------------------------------------------

type TableSource = "chatDb" | "contactIndex";

type TableSpec = {
	section: BackupSection;
	table: string;
	source: TableSource;
	/**
	 * Columns deliberately left out of this section's rows. On import these
	 * are skipped rather than written as NULL, so a section that carries a
	 * lighter version of a row can't blank out a column another section owns.
	 */
	omitColumns?: string[];
	/** Rows per page. Small for tables whose rows carry base64 payloads. */
	pageSize: number;
	/** TEXT columns measured for the size estimate. */
	sizeColumns?: string[];
	/**
	 * Monotonic column an incremental export filters on. Tables without one
	 * are always sent in full — all of them are small enough (settings is a
	 * dozen rows, conversation_meta one per conversation) that filtering them
	 * would buy nothing and risk dropping a row that changed in place.
	 */
	sinceColumn?: string;
	/** Columns merged by keeping the larger of the two values. */
	maxColumns?: string[];
};

/**
 * `albums` appears twice on purpose: `core` carries the metadata with the
 * cover image omitted, `albumMedia` carries the same rows with it. Import is
 * upsert-by-primary-key and the omitted column is skipped rather than
 * nulled, so the two compose in either order and each section stays
 * independently selectable.
 */
const TABLE_SPECS: TableSpec[] = [
	{ section: "core", table: "conversations", source: "chatDb", pageSize: 2000, sinceColumn: "updated_at" },
	{
		section: "core",
		table: "conversation_meta",
		source: "chatDb",
		pageSize: 5000,
		// A read cursor only ever moves forward, so the two sides are merged
		// by taking the later mark rather than letting the import win.
		maxColumns: ["last_read_timestamp"],
	},
	{ section: "core", table: "messages", source: "chatDb", pageSize: 2000, sinceColumn: "updated_at" },
	{ section: "core", table: "settings", source: "chatDb", pageSize: 500 },
	{ section: "core", table: "saved_phrases", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "saved_locations", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "block_events", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "stats_block_log", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "stats_location_log", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "stats_coverage_log", source: "chatDb", pageSize: 5000, sinceColumn: "created_at" },
	{ section: "core", table: "stats_profile_edit_log", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "stats_profile_open_log", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "stats_view_distance_log", source: "chatDb", pageSize: 2000, sinceColumn: "created_at" },
	{ section: "core", table: "past_contacts", source: "chatDb", pageSize: 2000, sinceColumn: "updated_at" },
	{ section: "core", table: "past_messages", source: "chatDb", pageSize: 2000, sinceColumn: "updated_at" },
	{ section: "core", table: "past_views", source: "chatDb", pageSize: 500, sinceColumn: "updated_at" },
	{
		section: "core",
		table: "albums",
		source: "chatDb",
		omitColumns: ["preview_cover_base64"],
		pageSize: 2000,
		sinceColumn: "updated_at",
	},

	{ section: "index", table: "chat_contact_index", source: "contactIndex", pageSize: 5000, sinceColumn: "updated_at" },
	{ section: "index", table: "chat_local_profile_meta", source: "contactIndex", pageSize: 5000, sinceColumn: "updated_at" },

	{
		section: "chatMedia",
		table: "media_files",
		source: "chatDb",
		pageSize: 25,
		sizeColumns: ["data_base64"],
		sinceColumn: "fetched_at",
	},
	{
		section: "albumMedia",
		table: "album_media",
		source: "chatDb",
		pageSize: 10,
		sizeColumns: ["data_base64", "thumb_data_base64"],
		sinceColumn: "fetched_at",
	},
	{
		section: "albumMedia",
		table: "albums",
		source: "chatDb",
		pageSize: 100,
		sizeColumns: ["preview_cover_base64"],
		sinceColumn: "updated_at",
	},
	{
		section: "avatars",
		table: "avatars",
		source: "chatDb",
		pageSize: 100,
		sizeColumns: ["data_base64"],
		sinceColumn: "fetched_at",
	},
];

/** Pseudo-table names for the two sections that aren't SQL-backed. */
const VIEWS_TABLE = "__interest_views__";
const LOCAL_TABLE = "__local_storage__";

function specsFor(section: BackupSection): TableSpec[] {
	return TABLE_SPECS.filter((spec) => spec.section === section);
}

function findSpec(section: string, table: string): TableSpec | null {
	return (
		TABLE_SPECS.find((spec) => spec.section === section && spec.table === table) ?? null
	);
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

/**
 * Keys that describe *this device* rather than this account's preferences.
 * Everything else is carried, so settings added later travel automatically
 * — the point of the feature is not having to set the app up twice.
 */
const LOCAL_STORAGE_DENYLIST = new Set([
	// Written by auth. Importing it would let the interest store resolve the
	// wrong (or a stale) account before login settles.
	"fg-user-id",
	// Per-device push registration; copying it breaks notifications on the
	// device whose token got overwritten.
	"fg-fcm-token",
	"fg-fcm-token-synced",
	// This device's own list of signed-in accounts.
	"fg-saved-account-profiles",
	// One-shot migration markers. Carrying a "done" flag to an install that
	// never ran the migration would skip it permanently.
	"fg-settings-migrated-to-db",
	"fg-interest-db-legacy-adopted",
	// Local scheduling state; meaningless on another device.
	"fg-view-scanner-last-run",
	// This device's own id and its sync watermarks. Carrying them would make a
	// restored install impersonate the exporter and inherit its watermarks, so
	// the next incremental export would skip everything it thought it had
	// already sent.
	...DEVICE_LOCAL_KEYS,
]);

/**
 * Keys denied by prefix, for stores that keep one key per account. A block
 * list import in progress belongs to the device running it: restored
 * elsewhere, two devices would block the same list at once.
 */
const LOCAL_STORAGE_DENIED_PREFIXES = [BLOCK_IMPORT_STORAGE_PREFIX];

function isDeniedLocalStorageKey(key: string): boolean {
	return (
		LOCAL_STORAGE_DENYLIST.has(key) ||
		LOCAL_STORAGE_DENIED_PREFIXES.some((prefix) => key.startsWith(prefix))
	);
}

/**
 * `fg-view-autoblock-state:<accountId>` is deliberately *not* denied. It is
 * the watermark of which interest views the auto-blocker already judged, so
 * carrying it means the restored device skips them rather than re-evaluating
 * a month of history. Omitting it is also safe (the store just takes a fresh
 * baseline), but carrying it is the higher-fidelity of two safe options.
 */
function exportLocalStorageEntries(): { k: string; v: string }[] {
	const entries: { k: string; v: string }[] = [];
	try {
		for (let index = 0; index < window.localStorage.length; index += 1) {
			const key = window.localStorage.key(index);
			if (!key || isDeniedLocalStorageKey(key)) {
				continue;
			}
			const value = window.localStorage.getItem(key);
			if (value != null) {
				entries.push({ k: key, v: value });
			}
		}
	} catch (error) {
		appLog.warn("[backup] localStorage unreadable", error);
	}
	return entries;
}

function importLocalStorageEntry(entry: { k?: unknown; v?: unknown }): boolean {
	if (typeof entry?.k !== "string" || typeof entry.v !== "string") {
		return false;
	}
	if (isDeniedLocalStorageKey(entry.k)) {
		return false;
	}
	try {
		window.localStorage.setItem(entry.k, entry.v);
		return true;
	} catch (error) {
		appLog.warn("[backup] failed to restore localStorage key", entry.k, error);
		return false;
	}
}

function clearImportableLocalStorage(): void {
	try {
		const doomed: string[] = [];
		for (let index = 0; index < window.localStorage.length; index += 1) {
			const key = window.localStorage.key(index);
			if (key && !isDeniedLocalStorageKey(key)) {
				doomed.push(key);
			}
		}
		for (const key of doomed) {
			window.localStorage.removeItem(key);
		}
	} catch (error) {
		appLog.warn("[backup] failed to clear localStorage", error);
	}
}

// ---------------------------------------------------------------------------
// Size estimation
// ---------------------------------------------------------------------------

export type SectionEstimate = {
	section: BackupSection;
	rows: number;
	/** Approximate encoded size in bytes. */
	bytes: number;
};

/**
 * Rough NDJSON overhead per row: the wrapper object, the column names, and
 * JSON escaping of the payload. Good enough to tell a 15 MB export from a
 * 400 MB one, which is all the picker needs.
 */
const ROW_OVERHEAD_BYTES = 120;

async function estimateSection(
	section: BackupSection,
	since = 0,
): Promise<SectionEstimate> {
	if (section === "views") {
		const all = (await exportInterestViewRows()) ?? [];
		const rows = since > 0 ? all.filter((row) => (row.updatedAt ?? 0) > since) : all;
		const sample = rows.length > 0 ? JSON.stringify(rows[0]).length : 0;
		return { section, rows: rows.length, bytes: rows.length * (sample + ROW_OVERHEAD_BYTES) };
	}

	if (section === "local") {
		// Always full: a few dozen keys with no timestamps to filter on.
		const entries = exportLocalStorageEntries();
		const bytes = entries.reduce(
			(total, entry) => total + entry.k.length + entry.v.length + ROW_OVERHEAD_BYTES,
			0,
		);
		return { section, rows: entries.length, bytes };
	}

	let rows = 0;
	let bytes = 0;
	for (const spec of specsFor(section)) {
		const delta = since > 0 && spec.sinceColumn;
		const count =
			spec.source === "chatDb"
				? delta
					? await chatDb.countTableRowsSince(spec.table, spec.sinceColumn as string, since)
					: await chatDb.countTableRows(spec.table)
				: delta
					? await contactIndex.countContactIndexRowsSince(
							spec.table as contactIndex.ContactIndexTableName,
							since,
						)
					: await contactIndex.countContactIndexRows(
							spec.table as contactIndex.ContactIndexTableName,
						);
		rows += count;
		bytes += count * ROW_OVERHEAD_BYTES;
		if (spec.source === "chatDb" && spec.sizeColumns) {
			const full = await chatDb.sumColumnLengths(spec.table, spec.sizeColumns);
			if (!delta) {
				bytes += full;
			} else {
				// Measuring only the changed rows would mean a second scan of a
				// multi-hundred-megabyte table; scaling the total by the share of
				// rows involved is close enough for a size preview.
				const total = await chatDb.countTableRows(spec.table);
				bytes += total > 0 ? Math.round((full * count) / total) : 0;
			}
		}
	}
	return { section, rows, bytes };
}

/**
 * Sections a user may remove from this device. "core" is deliberately absent:
 * it is the account itself, and the export screen does not offer it as a choice
 * for the same reason. "local" is a settings reset rather than stored data.
 */
export const DELETABLE_BACKUP_SECTIONS: readonly BackupSection[] = [
	"index",
	"views",
	"chatMedia",
	"albumMedia",
	"avatars",
];

/** Sections cloud sync carries, so removing them can reach other devices. */
export const SYNCED_BACKUP_SECTIONS: readonly BackupSection[] = ["index", "views"];

/**
 * Remove stored data for the chosen sections. Media rows are dropped outright;
 * cached columns on a shared table are blanked so the rows that own them
 * survive. Sections outside the deletable set are ignored rather than trusted.
 */
export async function deleteStoredSections(
	sections: readonly BackupSection[],
): Promise<void> {
	const chosen = new Set(
		sections.filter((section) => DELETABLE_BACKUP_SECTIONS.includes(section)),
	);
	if (chosen.size === 0) return;

	if (chosen.has("index")) {
		await contactIndex.clearContactIndexTables([
			"chat_contact_index",
			"chat_local_profile_meta",
		]);
	}
	if (chosen.has("views")) {
		await interestViewsStore.clear();
	}

	const tables: string[] = [];
	if (chosen.has("chatMedia")) tables.push("media_files");
	if (chosen.has("albumMedia")) tables.push("album_media");
	if (chosen.has("avatars")) tables.push("avatars");
	if (tables.length > 0) await chatDb.clearPortableTables(tables);

	if (chosen.has("albumMedia")) {
		// The album rows themselves belong to "core" and must survive.
		await chatDb.blankPortableTableColumns("albums", [
			"preview_cover_base64",
			"preview_cover_mime_type",
		]);
	}
}

export async function estimateBackupSections(since = 0): Promise<SectionEstimate[]> {
	const estimates: SectionEstimate[] = [];
	for (const section of BACKUP_SECTIONS) {
		try {
			estimates.push(await estimateSection(section, since));
		} catch (error) {
			appLog.error("[backup] failed to estimate section", section, error);
			estimates.push({ section, rows: 0, bytes: 0 });
		}
	}
	return estimates;
}

/**
 * The watermark a delta export to this peer would start from, or 0 when a
 * full export is the only correct choice — either we've never sent them
 * anything, or they aren't a known peer at all.
 */
export function deltaSinceForPeer(peerDeviceId: string | null): number {
	if (!peerDeviceId) {
		return 0;
	}
	return getPeer(peerDeviceId)?.lastExportAt ?? 0;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type BackupWriter = {
	write(chunk: string): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
};

export type BackupHeader = {
	kind: typeof BACKUP_KIND;
	version: number;
	exportedAt: number;
	ownerUserId: number;
	sections: BackupSection[];
	counts: Partial<Record<BackupSection, number>>;
	/** Which install wrote this file, so the receiver can track it as a peer. */
	deviceId: string;
	deviceName: string;
	/** "delta" carries only rows changed since `since`. */
	mode: "full" | "delta";
	since: number;
	/**
	 * Delivery receipt: "the newest file of yours I imported was stamped
	 * ackUpTo". Only meaningful to the device named by ackFor, which uses it
	 * to advance its own watermark on proof of receipt.
	 */
	ackFor?: string | null;
	ackUpTo?: number | null;
};

export type BackupProgress = {
	section: BackupSection;
	rowsDone: number;
	rowsTotal: number;
};

/** Accumulates lines and flushes on a byte budget rather than per row. */
const FLUSH_BYTES = 2 * 1024 * 1024;

class ChunkBuffer {
	private parts: string[] = [];
	private size = 0;

	constructor(private readonly writer: BackupWriter) {}

	async push(line: string): Promise<void> {
		this.parts.push(line);
		this.size += line.length;
		if (this.size >= FLUSH_BYTES) {
			await this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.parts.length === 0) {
			return;
		}
		const chunk = this.parts.join("");
		this.parts = [];
		this.size = 0;
		await this.writer.write(chunk);
	}
}

function encodeRow(section: BackupSection, table: string, row: unknown): string {
	return `${JSON.stringify({ s: section, t: table, r: row })}\n`;
}

export type ExportOptions = {
	/**
	 * Peer this file is meant for. When set and we've exported to them before,
	 * only rows changed since then are written and their watermark is advanced.
	 */
	targetPeerId?: string | null;
	/** Forces a full export even when a delta is available. */
	full?: boolean;
};

export async function exportBackup(
	ownerUserId: number,
	sections: BackupSection[],
	writer: BackupWriter,
	onProgress?: (progress: BackupProgress) => void,
	options: ExportOptions = {},
): Promise<{ rowsWritten: number; mode: "full" | "delta"; since: number }> {
	const selected = BACKUP_SECTIONS.filter(
		(section) => sections.includes(section) || REQUIRED_SECTIONS.includes(section),
	);

	const since = options.full ? 0 : deltaSinceForPeer(options.targetPeerId ?? null);
	const mode: "full" | "delta" = since > 0 ? "delta" : "full";
	// Stamped before any row is read, so anything written to the database while
	// a long media export is still streaming falls after the mark and is picked
	// up next time rather than being skipped.
	const startedAt = Date.now();

	const estimates = new Map<BackupSection, number>();
	for (const section of selected) {
		estimates.set(section, (await estimateSection(section, since)).rows);
	}

	const header: BackupHeader = {
		kind: BACKUP_KIND,
		version: BACKUP_VERSION,
		exportedAt: startedAt,
		ownerUserId,
		sections: selected,
		counts: Object.fromEntries(estimates) as Partial<Record<BackupSection, number>>,
		deviceId: getDeviceId(),
		deviceName: getDeviceName(),
		mode,
		since,
		ackFor: options.targetPeerId ?? null,
		ackUpTo: getAckForPeer(options.targetPeerId ?? null),
	};

	const buffer = new ChunkBuffer(writer);
	let rowsWritten = 0;

	try {
		await buffer.push(`${JSON.stringify(header)}\n`);

		for (const section of selected) {
			const rowsTotal = estimates.get(section) ?? 0;
			let rowsDone = 0;
			const report = () => onProgress?.({ section, rowsDone, rowsTotal });
			report();

			if (section === "views") {
				const all = (await exportInterestViewRows()) ?? [];
				const rows =
					since > 0 ? all.filter((row) => (row.updatedAt ?? 0) > since) : all;
				for (const row of rows) {
					await buffer.push(encodeRow(section, VIEWS_TABLE, row));
					rowsDone += 1;
					rowsWritten += 1;
				}
				report();
				continue;
			}

			if (section === "local") {
				for (const entry of exportLocalStorageEntries()) {
					await buffer.push(encodeRow(section, LOCAL_TABLE, entry));
					rowsDone += 1;
					rowsWritten += 1;
				}
				report();
				continue;
			}

			for (const spec of specsFor(section)) {
				let offset = 0;
				for (;;) {
					// A table with no watermark column is always sent whole, even
					// in delta mode — they're the small ones, and rows there
					// change in place with nothing to filter on.
					const rowSince = spec.sinceColumn ? since : 0;
					const page =
						spec.source === "chatDb"
							? await chatDb.selectTablePage(spec.table, offset, spec.pageSize, {
									omitColumns: spec.omitColumns,
									sinceColumn: spec.sinceColumn,
									since: rowSince,
								})
							: await contactIndex.selectContactIndexPage(
									spec.table as contactIndex.ContactIndexTableName,
									offset,
									spec.pageSize,
									{ since: rowSince },
								);
					if (page.length === 0) {
						break;
					}
					for (const row of page) {
						await buffer.push(encodeRow(section, spec.table, row));
						rowsDone += 1;
						rowsWritten += 1;
					}
					report();
					offset += page.length;
					if (page.length < spec.pageSize) {
						break;
					}
				}
			}
			report();
		}

		await buffer.flush();
		await writer.close();
	} catch (error) {
		await writer.abort().catch(() => {});
		throw error;
	}

	return { rowsWritten, mode, since };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportBackupResult =
	| {
			ok: true;
			rowsImported: number;
			sections: BackupSection[];
			mode: "full" | "delta";
			deviceName: string;
		}
	| { ok: false; error: "wrong_owner" | "invalid_format" };

export type ImportOptions = {
	/** Wipe everything the file's sections cover before writing. */
	mirror?: boolean;
};

/** 4 MB read window. Lines longer than this are still handled correctly. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Yields the file's lines without ever holding more than a chunk plus the
 * current line in memory. `TextDecoder({ stream: true })` is what makes the
 * chunk boundaries safe — a multi-byte character split across two slices is
 * carried over rather than corrupted.
 */
async function* readLines(file: File): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let remainder = "";

	for (let offset = 0; offset < file.size; offset += READ_CHUNK_BYTES) {
		const slice = file.slice(offset, Math.min(offset + READ_CHUNK_BYTES, file.size));
		const text = decoder.decode(new Uint8Array(await slice.arrayBuffer()), { stream: true });
		const parts = (remainder + text).split("\n");
		remainder = parts.pop() ?? "";
		for (const part of parts) {
			// Trim-checked rather than length-checked so a blank or whitespace
			// line anywhere in the file is skipped the same way the final one
			// is, instead of reaching the parser and logging a bogus warning.
			if (part.trim().length > 0) {
				yield part;
			}
		}
	}

	remainder += decoder.decode();
	if (remainder.trim().length > 0) {
		yield remainder;
	}
}

/** Buffers rows per table and flushes on a byte budget, mirroring the export. */
class RowBatcher {
	private rows: Record<string, unknown>[] = [];
	private bytes = 0;
	private current: { section: string; table: string } | null = null;

	constructor(
		private readonly flushBatch: (
			section: string,
			table: string,
			rows: Record<string, unknown>[],
		) => Promise<number>,
	) {}

	async add(
		section: string,
		table: string,
		row: Record<string, unknown>,
		approxBytes: number,
	): Promise<number> {
		let written = 0;
		if (
			this.current &&
			(this.current.section !== section || this.current.table !== table)
		) {
			written += await this.flush();
		}
		this.current = { section, table };
		this.rows.push(row);
		this.bytes += approxBytes;
		if (this.bytes >= FLUSH_BYTES) {
			written += await this.flush();
		}
		return written;
	}

	async flush(): Promise<number> {
		if (!this.current || this.rows.length === 0) {
			this.rows = [];
			this.bytes = 0;
			return 0;
		}
		const { section, table } = this.current;
		const rows = this.rows;
		this.rows = [];
		this.bytes = 0;
		return this.flushBatch(section, table, rows);
	}
}

function parseHeader(line: string): BackupHeader | null {
	try {
		const parsed = JSON.parse(line) as Partial<BackupHeader>;
		if (
			parsed?.kind === BACKUP_KIND &&
			parsed.version === BACKUP_VERSION &&
			typeof parsed.ownerUserId === "number" &&
			Array.isArray(parsed.sections)
		) {
			return parsed as BackupHeader;
		}
	} catch {
		// Not NDJSON — the caller falls back to the v1 whole-file format.
	}
	return null;
}

/** Reads just enough of the file to classify it, without decoding the rest. */
async function readFirstLine(file: File): Promise<string> {
	const slice = file.slice(0, Math.min(READ_CHUNK_BYTES, file.size));
	const text = new TextDecoder().decode(new Uint8Array(await slice.arrayBuffer()));
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

export async function isBackupV2File(file: File): Promise<boolean> {
	return parseHeader(await readFirstLine(file)) !== null;
}

/** Reads the header alone, so the import screen can show what's inside. */
export async function readBackupHeader(file: File): Promise<BackupHeader | null> {
	return parseHeader(await readFirstLine(file));
}

async function clearSections(sections: BackupSection[]): Promise<void> {
	const chatTables = new Set<string>();
	const indexTables = new Set<contactIndex.ContactIndexTableName>();

	for (const section of sections) {
		for (const spec of specsFor(section)) {
			if (spec.source === "chatDb") {
				// A section that only carries part of a row (core's cover-less
				// albums) must not delete rows another selected section owns.
				if (!spec.omitColumns || sections.includes("albumMedia")) {
					chatTables.add(spec.table);
				}
			} else if (contactIndex.isContactIndexTable(spec.table)) {
				indexTables.add(spec.table);
			}
		}
	}

	await chatDb.clearPortableTables([...chatTables]);
	await contactIndex.clearContactIndexTables([...indexTables]);

	if (sections.includes("views")) {
		await interestViewsStore.clear();
	}
	if (sections.includes("local")) {
		clearImportableLocalStorage();
	}
}

export async function importBackup(
	file: File,
	currentUserId: number,
	options: ImportOptions = {},
	onProgress?: (progress: BackupProgress) => void,
): Promise<ImportBackupResult> {
	const header = await readBackupHeader(file);
	if (!header) {
		return { ok: false, error: "invalid_format" };
	}
	if (header.ownerUserId !== currentUserId) {
		return { ok: false, error: "wrong_owner" };
	}

	const sections = header.sections.filter(isBackupSection);
	const totals = header.counts ?? {};
	const mode = header.mode === "delta" ? "delta" : "full";

	// A delta only ever contains changed rows, so wiping first would destroy
	// everything the file doesn't happen to mention. Mirroring is only
	// meaningful against a full export.
	if (options.mirror && mode === "full") {
		await clearSections(sections);
	}

	let rowsImported = 0;
	let currentSection: BackupSection = sections[0] ?? "core";
	let rowsDone = 0;

	// Interest-view rows are restored in one verbatim put rather than through
	// the row batcher: the store's own writer is what preserves firstSeenAt
	// and viewTimestamps, which the expiry sweep reads as age anchors.
	const viewRows: StoredInterestView[] = [];

	const batcher = new RowBatcher(async (section, table, rows) => {
		const spec = findSpec(section, table);
		if (!spec) {
			return 0;
		}
		if (spec.source === "chatDb") {
			return chatDb.upsertTableRows(table, rows, {
				skipColumns: spec.omitColumns,
				// The same column that identifies a changed row also decides who
				// wins a conflict, so importing an older backup can't drag live
				// rows backwards.
				newerThanColumn: spec.sinceColumn,
				maxColumns: spec.maxColumns,
			});
		}
		if (contactIndex.isContactIndexTable(table)) {
			return contactIndex.upsertContactIndexRows(table, rows);
		}
		return 0;
	});

	let isFirstLine = true;
	for await (const line of readLines(file)) {
		if (isFirstLine) {
			isFirstLine = false;
			continue;
		}

		let entry: { s?: unknown; t?: unknown; r?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			// A truncated or hand-edited file shouldn't abort everything that
			// already imported cleanly.
			appLog.warn("[backup] skipping unparseable line");
			continue;
		}

		if (typeof entry.s !== "string" || typeof entry.t !== "string" || !entry.r) {
			continue;
		}
		if (!isBackupSection(entry.s)) {
			continue;
		}

		if (entry.s !== currentSection) {
			rowsImported += await batcher.flush();
			currentSection = entry.s;
			rowsDone = 0;
		}

		if (entry.t === VIEWS_TABLE) {
			viewRows.push(entry.r as StoredInterestView);
			rowsDone += 1;
			rowsImported += 1;
		} else if (entry.t === LOCAL_TABLE) {
			if (importLocalStorageEntry(entry.r as { k?: unknown; v?: unknown })) {
				rowsImported += 1;
			}
			rowsDone += 1;
		} else {
			rowsImported += await batcher.add(
				entry.s,
				entry.t,
				entry.r as Record<string, unknown>,
				line.length,
			);
			rowsDone += 1;
		}

		if (rowsDone % 200 === 0) {
			onProgress?.({
				section: currentSection,
				rowsDone,
				rowsTotal: totals[currentSection] ?? 0,
			});
		}
	}

	rowsImported += await batcher.flush();

	if (viewRows.length > 0) {
		const wrote = await importInterestViewRows(viewRows);
		if (!wrote) {
			appLog.error("[backup] failed to restore interest view rows");
		}
	}

	// Remember where this came from, so the next export back to that device can
	// offer to carry only what changed since.
	if (header.deviceId) {
		recordPeerImport(
			header.deviceId,
			header.deviceName,
			header.exportedAt,
			// Their receipt only speaks for us; a file addressed to a different
			// device must never move this install's watermark.
			header.ackFor === getDeviceId() ? header.ackUpTo : null,
		);
	}

	return {
		ok: true,
		rowsImported,
		sections,
		mode,
		deviceName: header.deviceName || translate("data_backup.another_device", { defaultValue: "another device" }),
	};
}
