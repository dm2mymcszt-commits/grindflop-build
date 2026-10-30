import type { JsonValue } from "./types";
import { isJsonValue } from "./types";

function serializeCanonical(value: JsonValue): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${(value as readonly JsonValue[]).map(serializeCanonical).join(",")}]`;
	}
	const objectValue = value as { readonly [key: string]: JsonValue };
	const keys = Object.keys(objectValue).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${serializeCanonical(objectValue[key])}`)
		.join(",")}}`;
}

/** Stable JSON encoding used for package hashes and operation fingerprints. */
export function canonicalJson(value: JsonValue): string {
	if (!isJsonValue(value)) {
		throw new TypeError(
			"Canonical JSON input must be a bounded, safe JSON value",
		);
	}
	return serializeCanonical(value);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	if (!globalThis.crypto?.subtle) {
		throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
	}
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		Uint8Array.from(bytes).buffer,
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function equalHexDigest(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}
