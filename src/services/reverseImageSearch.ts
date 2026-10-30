import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readMediaBytes } from "./mediaBytes";
import { isTauriRuntime } from "./tauriWebSocket";
import { appLog } from "../utils/logger";

/**
 * Reverse image search links for Google Lens and Yandex; the viewer lets the
 * user pick which one to open.
 *
 * Both engines only take an image by URL when opened from outside, and most
 * photos the app shows are saved copies (data: URIs) or signed links that
 * expire — which is why the old Lens button stopped working. So the image is
 * uploaded to Yandex first: Yandex answers with a search id and a public copy
 * of the image, and Google Lens is then opened on that public copy. The
 * uploads never touch Google directly, so Google's consent screen still comes
 * up in the user's own browser as usual.
 */

const YANDEX_UPLOAD_URL =
	"https://yandex.com/images/search?rpt=imageview&format=json&request=" +
	encodeURIComponent(JSON.stringify({ blocks: [{ block: "b-page_type_search-by-image__link" }] }));

export type ReverseSearchLinks = { googleLens: string; yandex: string };

type YandexUploadResponse = {
	blocks?: { params?: { cbirId?: unknown; originalImageUrl?: unknown; url?: unknown } }[];
};

export function yandexSearchUrlForId(cbirId: string): string {
	return `https://yandex.com/images/search?rpt=imageview&cbir_id=${encodeURIComponent(cbirId)}`;
}

export function yandexSearchUrlForImage(imageUrl: string): string {
	return `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`;
}

export function googleLensUrlForImage(imageUrl: string): string {
	return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
}

/** Search links from Yandex's upload answer, or null when it holds no search id. */
export function linksFromYandexUpload(response: unknown): ReverseSearchLinks | null {
	const params = (response as YandexUploadResponse | null)?.blocks?.[0]?.params;
	const cbirId = typeof params?.cbirId === "string" ? params.cbirId : null;
	if (!cbirId) return null;
	const publicCopy =
		typeof params?.originalImageUrl === "string" && params.originalImageUrl.startsWith("https://")
			? params.originalImageUrl
			: null;
	return {
		yandex: yandexSearchUrlForId(cbirId),
		// Without a public copy there is nothing Lens can fetch; its upload page still opens.
		googleLens: publicCopy ? googleLensUrlForImage(publicCopy) : "https://lens.google.com/",
	};
}

function isPublicUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

function extensionFor(mimeType: string | null): string {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "jpg";
}

async function uploadToYandex(imageUrl: string): Promise<ReverseSearchLinks> {
	const { bytes, mimeType } = await readMediaBytes(imageUrl);
	const type = mimeType?.startsWith("image/") ? mimeType : "image/jpeg";
	const form = new FormData();
	form.append("upfile", new Blob([bytes], { type }), `image.${extensionFor(type)}`);
	const fetchImpl = isTauriRuntime() ? tauriFetch : window.fetch.bind(window);
	const response = await fetchImpl(YANDEX_UPLOAD_URL, { method: "POST", body: form });
	if (!response.ok) {
		throw new Error(`Yandex upload failed (${response.status})`);
	}
	const links = linksFromYandexUpload(await response.json());
	if (!links) {
		throw new Error("Yandex returned no search id");
	}
	return links;
}

/** Links for both engines: from an upload, or straight from the image's own URL if the upload fails. */
export async function resolveReverseSearchLinks(imageUrl: string): Promise<ReverseSearchLinks> {
	try {
		return await uploadToYandex(imageUrl);
	} catch (error) {
		if (!isPublicUrl(imageUrl)) throw error;
		appLog.warn("[reverse-search] upload failed, searching by the image's own URL", error);
		return { googleLens: googleLensUrlForImage(imageUrl), yandex: yandexSearchUrlForImage(imageUrl) };
	}
}

export async function openExternal(url: string): Promise<void> {
	try {
		await openUrl(url);
	} catch {
		window.open(url, "_blank");
	}
}
