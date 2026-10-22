import { describe, expect, test } from "bun:test";
import {
	getDeviceId,
	getGoogleDriveSyncDeviceId,
	resolveGoogleDriveSyncDeviceId,
} from "../src/services/backupPeers";

function installWindow(localStorage: unknown): () => void {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { localStorage },
	});
	return () => {
		if (previous) {
			Object.defineProperty(globalThis, "window", previous);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	};
}

describe("Google Drive sync device identity", () => {
	test("fails closed when local storage is unavailable while manual backup keeps its fallback", () => {
		const restore = installWindow({
			getItem: () => {
				throw new Error("storage unavailable");
			},
			setItem: () => {
				throw new Error("storage unavailable");
			},
		});

		try {
			expect(() => getGoogleDriveSyncDeviceId()).toThrow(
				"Google Drive sync requires durable local storage for this device id",
			);
			expect(getDeviceId()).toBeTruthy();
		} finally {
			restore();
		}
	});

	test("fails closed when local storage cannot persist the generated id", () => {
		const restore = installWindow({
			getItem: () => null,
			setItem: () => {
				throw new Error("write failed");
			},
		});

		try {
			expect(() => getGoogleDriveSyncDeviceId()).toThrow(
				"Google Drive sync requires durable local storage for this device id",
			);
		} finally {
			restore();
		}
	});

	test("reuses a persisted id after confirming it remains durable", () => {
		const values = new Map<string, string>([
			["fg-device-id", "persisted-device-id"],
		]);
		const restore = installWindow({
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		});

		try {
			expect(getGoogleDriveSyncDeviceId()).toBe("persisted-device-id");
			expect(getGoogleDriveSyncDeviceId()).toBe("persisted-device-id");
		} finally {
			restore();
		}
	});

	test("restores a missing browser id from the authoritative store binding", () => {
		const values = new Map<string, string>();
		const restore = installWindow({
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		});

		try {
			expect(resolveGoogleDriveSyncDeviceId("bound-device-id", false)).toBe(
				"bound-device-id",
			);
			expect(values.get("fg-device-id")).toBe("bound-device-id");
		} finally {
			restore();
		}
	});

	test("rejects a browser/store identity conflict without overwriting either value", () => {
		const values = new Map<string, string>([["fg-device-id", "browser-device-id"]]);
		const restore = installWindow({
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		});

		try {
			expect(() => resolveGoogleDriveSyncDeviceId("bound-device-id", false)).toThrow(
				"browser and bound device ids conflict",
			);
			expect(values.get("fg-device-id")).toBe("browser-device-id");
		} finally {
			restore();
		}
	});

	test("does not mint a browser id for an unbound store with prior sync state", () => {
		const values = new Map<string, string>();
		const restore = installWindow({
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		});

		try {
			expect(resolveGoogleDriveSyncDeviceId(null, false)).toBeNull();
			expect(values.has("fg-device-id")).toBe(false);
		} finally {
			restore();
		}
	});
});
