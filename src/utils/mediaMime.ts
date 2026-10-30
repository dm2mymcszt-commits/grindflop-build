/**
 * The media type a file really is, read from its first bytes. Saved album
 * previews are stored under the album item's type, so a video's JPEG preview
 * was labelled video/mp4 — and when Grindr sent no separate preview, the
 * "preview" was the video itself. Neither shows in an <img>.
 */

function leadingBytes(base64: string, count: number): Uint8Array | null {
	// Every 4 base64 characters hold 3 bytes.
	const chars = Math.ceil(count / 3) * 4;
	try {
		const binary = atob(base64.slice(0, chars));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.slice(start, end));
}

/** image/jpeg, image/png, video/mp4…, or null when the start of the file is not recognised. */
export function sniffMediaMime(base64: string): string | null {
	const bytes = leadingBytes(base64, 12);
	if (!bytes || bytes.length < 4) return null;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "image/png";
	if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
	if (bytes.length < 12) return null;
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
	if (ascii(bytes, 4, 8) === "ftyp") {
		const brand = ascii(bytes, 8, 12);
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
		if (brand === "qt  ") return "video/quicktime";
		return "video/mp4";
	}
	return null;
}

/** Whether a URL can be shown in an <img>: anything but a saved video or sound. */
export function isPictureUrl(url: string | null | undefined): url is string {
	return !!url && !/^data:(video|audio)\//i.test(url);
}
