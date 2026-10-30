import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	APP_DISGUISE_IDS,
	disguiseForNativeIcon,
	nativeIconName,
	parseAppIconReport,
} from "../src/utils/appDisguise";

const root = join(import.meta.dir, "..");

describe("app disguise names", () => {
	test("the app's own icon has no name on the iOS side", () => {
		expect(nativeIconName("default")).toBeNull();
	});

	test("every decoy goes to iOS and back as itself", () => {
		for (const id of APP_DISGUISE_IDS) {
			expect(disguiseForNativeIcon(nativeIconName(id))).toBe(id);
		}
	});

	test("a name iOS reports that is not one of ours is the app's own icon", () => {
		expect(disguiseForNativeIcon("Something")).toBe("default");
		expect(disguiseForNativeIcon(null)).toBe("default");
		expect(disguiseForNativeIcon(undefined)).toBe("default");
		// The page's own ids are not iOS names.
		expect(disguiseForNativeIcon("calculator")).toBe("default");
	});
});

describe("parseAppIconReport", () => {
	test("reads a report", () => {
		expect(parseAppIconReport({ supported: true, current: "Notes", failed: false })).toEqual({
			supported: true,
			current: "notes",
			failed: false,
		});
		expect(parseAppIconReport({ supported: true, current: null, failed: true })).toEqual({
			supported: true,
			current: "default",
			failed: true,
		});
	});

	test("a device that cannot swap icons says so", () => {
		expect(parseAppIconReport({ supported: false, current: null })).toEqual({
			supported: false,
			current: "default",
			failed: false,
		});
	});

	test("anything that is not a report is ignored", () => {
		expect(parseAppIconReport(null)).toBeNull();
		expect(parseAppIconReport("Notes")).toBeNull();
		expect(parseAppIconReport({ current: "Notes" })).toBeNull();
		expect(parseAppIconReport({ supported: "yes" })).toBeNull();
	});
});

// The names are written out in four places that have to agree, three of
// which only ever run on an iPhone: the page, the Swift side that hands them
// to iOS, Info.plist, which declares them, and the icon files themselves.
describe("the decoy icons are the same everywhere", () => {
	const names = APP_DISGUISE_IDS.map(nativeIconName).filter((name): name is string => name != null);

	test("the native side accepts exactly these names", () => {
		const swift = readFileSync(
			join(root, "src-tauri", "ios-keyboard-fix", "ios", "Sources", "AppIconSwitch.swift"),
			"utf8",
		);
		const declared = swift.match(/alternates: Set<String> = \[([^\]]*)\]/);
		expect(declared).not.toBeNull();
		const accepted = [...declared![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		expect(accepted.sort()).toEqual([...names].sort());
	});

	test("Info.plist declares each of them, with files that exist", () => {
		const plist = readFileSync(join(root, "src-tauri", "Info.plist"), "utf8");
		for (const name of names) {
			expect(plist).toContain(`<key>${name}</key>`);
			expect(plist).toContain(`<string>Disguise${name}</string>`);
			for (const suffix of ["@2x", "@3x", "-76@2x", "-83.5@2x"]) {
				const file = join(root, "src-tauri", "ios-launch", "AlternateIcons", `Disguise${name}${suffix}.png`);
				// A PNG starts with these eight bytes.
				expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
			}
		}
	});
});
