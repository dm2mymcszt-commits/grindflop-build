import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "./tauriWebSocket";

export type MediaBytes = { bytes: Uint8Array<ArrayBuffer>; mimeType: string | null };

const DATA_URI_PATTERN = /^data:([^;,]*)(;base64)?,/i;

/**
 * The bytes behind any media URL the app shows. Saved chat media is shown as a
 * data: URI, which the HTTP plugin cannot fetch, so reading those went through
 * a request that could only fail.
 */
export async function readMediaBytes(url: string): Promise<MediaBytes> {
	const dataUri = DATA_URI_PATTERN.exec(url);
	if (dataUri) {
		const payload = url.slice(dataUri[0].length);
		const mimeType = dataUri[1] || null;
		if (dataUri[2]) {
			const binary = atob(payload);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) {
				bytes[index] = binary.charCodeAt(index);
			}
			return { bytes, mimeType };
		}
		return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType };
	}

	// blob: URLs belong to this page, and the HTTP plugin cannot see them.
	const fetchImpl = url.startsWith("blob:") || !isTauriRuntime() ? window.fetch.bind(window) : tauriFetch;
	const response = await fetchImpl(url);
	if (!response.ok) {
		throw new Error(`Failed to read media (${response.status})`);
	}
	return {
		bytes: new Uint8Array(await response.arrayBuffer()),
		mimeType: response.headers.get("content-type")?.split(";")[0].trim() || null,
	};
}
