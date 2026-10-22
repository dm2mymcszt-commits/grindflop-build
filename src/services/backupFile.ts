import { mkdir, open, remove, BaseDirectory } from "@tauri-apps/plugin-fs";
import { AndroidFs, AndroidPublicGeneralPurposeDir } from "tauri-plugin-android-fs-api";
import { isTauriRuntime } from "./tauriWebSocket";
import { isAndroid, isIos } from "./saveMedia";
import type { BackupWriter } from "./backup";
import { appLog } from "../utils/logger";

/** Same folder the app already owns under Downloads, and already has scope for. */
const BACKUP_FOLDER = "FreeGrind";

export function isDesktopTauri(): boolean {
	return isTauriRuntime() && !isIos() && !isAndroid();
}

export function backupFileName(): string {
	return `free-grind-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * Writes straight to a file handle, so an export never exists in memory as a
 * whole. Requires the `open`/`write` commands, which the existing
 * `fs:allow-write-file` grant already covers for $DOWNLOAD/FreeGrind/**.
 */
async function createStreamingWriter(
	fileName: string,
	baseDir: BaseDirectory,
	folder: string | null,
): Promise<BackupWriter> {
	const relativePath = folder ? `${folder}/${fileName}` : fileName;
	if (folder) {
		await mkdir(folder, { baseDir, recursive: true });
	}
	const handle = await open(relativePath, {
		write: true,
		create: true,
		truncate: true,
		baseDir,
	});
	const encoder = new TextEncoder();
	let closed = false;

	return {
		async write(chunk) {
			await handle.write(encoder.encode(chunk));
		},
		async close() {
			if (closed) return;
			closed = true;
			await handle.close();
		},
		async abort() {
			if (!closed) {
				closed = true;
				await handle.close().catch(() => {});
			}
			// Leave no half-written file to be mistaken for a usable backup.
			await remove(relativePath, { baseDir }).catch(() => {});
		},
	};
}

/**
 * Collects chunks as Blob parts rather than one growing string. Browsers keep
 * blob data off the JS heap (spilling large ones to disk), which is what
 * makes a multi-hundred-megabyte export survivable on the platforms with no
 * streaming file API.
 */
class BlobCollector {
	private readonly parts: BlobPart[] = [];

	push(chunk: string): void {
		this.parts.push(chunk);
	}

	toBlob(): Blob {
		return new Blob(this.parts, { type: "application/json" });
	}
}

function createBrowserWriter(fileName: string): BackupWriter {
	const collector = new BlobCollector();
	return {
		async write(chunk) {
			collector.push(chunk);
		},
		async close() {
			const url = URL.createObjectURL(collector.toBlob());
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			document.body.appendChild(anchor);
			anchor.click();
			document.body.removeChild(anchor);
			URL.revokeObjectURL(url);
		},
		async abort() {
			// Nothing was handed to the browser yet, so there is nothing to undo.
		},
	};
}

/**
 * Android's WebView ignores the blob-URL + <a download> trick, so the file is
 * written through MediaStore instead — the same approach the media save path
 * already uses. There is no append API, so the export is buffered as a Blob
 * and written once.
 */
function createAndroidWriter(fileName: string): BackupWriter {
	const collector = new BlobCollector();
	return {
		async write(chunk) {
			collector.push(chunk);
		},
		async close() {
			const bytes = new Uint8Array(await collector.toBlob().arrayBuffer());
			const uri = await AndroidFs.createNewPublicFile(
				AndroidPublicGeneralPurposeDir.Download,
				fileName,
				"application/json",
				{ isPending: true },
			);
			try {
				await AndroidFs.writeFile(uri, bytes);
				await AndroidFs.setPublicFilePending(uri, false);
				await AndroidFs.scanPublicFile(uri);
			} catch (error) {
				await AndroidFs.removeFile(uri).catch(() => {});
				throw error;
			}
		},
		async abort() {
			// Nothing is created until close(), so an abort leaves no file.
		},
	};
}

export type BackupDestination = {
	writer: BackupWriter;
	fileName: string;
	/** Where the finished file landed, for the success message. */
	location: "downloads-folder" | "ios-files-app" | "browser-download";
};

/** Also writes other exports (the block list) to the same places, under their own name. */
export async function createBackupWriter(fileName = backupFileName()): Promise<BackupDestination> {

	if (isAndroid()) {
		return { writer: createAndroidWriter(fileName), fileName, location: "downloads-folder" };
	}

	if (isIos()) {
		// WKWebView ignores the blob-URL + <a download> trick entirely, which is
		// why exporting from iOS used to silently do nothing. Writing into the
		// app's own Documents directory works instead, and UIFileSharingEnabled
		// in Info.plist is what surfaces that directory in the Files app under
		// "On My iPhone → GrindFlop", from where it can be AirDropped.
		try {
			return {
				writer: await createStreamingWriter(fileName, BaseDirectory.Document, null),
				fileName,
				location: "ios-files-app",
			};
		} catch (error) {
			appLog.error("[backup] iOS document writer unavailable", error);
		}
	}

	if (isDesktopTauri()) {
		try {
			return {
				writer: await createStreamingWriter(
					fileName,
					BaseDirectory.Download,
					BACKUP_FOLDER,
				),
				fileName,
				location: "downloads-folder",
			};
		} catch (error) {
			appLog.error("[backup] desktop writer unavailable, falling back to browser", error);
		}
	}

	return { writer: createBrowserWriter(fileName), fileName, location: "browser-download" };
}
