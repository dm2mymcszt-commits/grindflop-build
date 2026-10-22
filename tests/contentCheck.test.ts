import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// contentCheck talks to the detector through Tauri's invoke, which reads
// window.__TAURI_INTERNALS__ at call time, so a stub there stands in for the
// detector without replacing any module. Everything else (chatDb's own
// invokes included) is refused, which is what a device with no database
// looks like: the checks must still work, and must still fail closed.
type Detection = { label: string; score: number };

const store = new Map<string, string>();
let detectorCalls = 0;
let detectorAnswer: Detection[] | Error = [];

const globalScope = globalThis as unknown as { window?: unknown };
const previousWindow = globalScope.window;
afterAll(() => {
	if (previousWindow === undefined) delete globalScope.window;
	else globalScope.window = previousWindow;
});
globalScope.window = {
	localStorage: {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
	},
	dispatchEvent: () => true,
	addEventListener: () => {},
	removeEventListener: () => {},
	__TAURI_INTERNALS__: {
		invoke: async (command: string) => {
			if (command !== "detect_image_content") {
				throw new Error(`no ${command} in this test`);
			}
			detectorCalls += 1;
			if (detectorAnswer instanceof Error) throw detectorAnswer;
			return { detections: detectorAnswer, imageWidth: 10, imageHeight: 10, elapsedMs: 1 };
		},
	},
};

const {
	checkMediaBytes,
	getContentCoverForMessage,
	isExplicitBlockEnabled,
	isExplicitFilterEnabled,
	getExplicitFilterSince,
	requestChecksForMessages,
	setExplicitBlockEnabled,
	setExplicitFilterEnabled,
	setExplicitVerdictHandler,
	verdictOf,
} = await import("../src/services/contentCheck");

const EXPLICIT: Detection[] = [{ label: "MALE_GENITALIA_EXPOSED", score: 0.9 }];
const SHIRTLESS: Detection[] = [
	{ label: "MALE_BREAST_EXPOSED", score: 0.9 },
	{ label: "FACE_MALE", score: 0.8 },
];

let nextId = 0;
function photo(overrides: Partial<Parameters<typeof checkMediaBytes>[0]> = {}) {
	nextId += 1;
	return {
		mediaKey: `image:test-${nextId}`,
		messageId: `message-${nextId}`,
		conversationId: "1:2",
		kind: "image" as const,
		base64: "AAAA",
		mimeType: "image/jpeg",
		...overrides,
	};
}

describe("explicit filter switches", () => {
	beforeEach(() => {
		store.clear();
	});

	test("off until switched on", () => {
		expect(isExplicitFilterEnabled()).toBe(false);
		expect(isExplicitBlockEnabled()).toBe(false);
		expect(getExplicitFilterSince()).toBeNull();
	});

	test("switching it on starts the clock, and blocking comes with it", () => {
		const before = Date.now();
		setExplicitFilterEnabled(true);
		expect(isExplicitFilterEnabled()).toBe(true);
		expect(isExplicitBlockEnabled()).toBe(true);
		expect(getExplicitFilterSince()).toBeGreaterThanOrEqual(before);
	});

	test("blocking can be switched off on its own", () => {
		setExplicitFilterEnabled(true);
		setExplicitBlockEnabled(false);
		expect(isExplicitFilterEnabled()).toBe(true);
		expect(isExplicitBlockEnabled()).toBe(false);
	});

	test("switching it on again restarts the clock", () => {
		setExplicitFilterEnabled(true);
		store.set("fg-explicit-filter-since", "1000");
		setExplicitFilterEnabled(true);
		expect(getExplicitFilterSince()).toBe(1000);
		setExplicitFilterEnabled(false);
		setExplicitFilterEnabled(true);
		expect(getExplicitFilterSince()).toBeGreaterThan(1000);
	});
});

describe("checkMediaBytes", () => {
	const announced: string[] = [];

	beforeEach(() => {
		store.clear();
		setExplicitFilterEnabled(true);
		detectorCalls = 0;
		detectorAnswer = [];
		announced.length = 0;
		setExplicitVerdictHandler((event) => {
			announced.push(event.messageId);
		});
	});

	test("an explicit photo is recorded, stays covered, and is announced with its message", async () => {
		detectorAnswer = EXPLICIT;
		const input = photo();
		const check = await checkMediaBytes(input);
		expect(verdictOf(check)).toBe("explicit");
		expect(getContentCoverForMessage(input.messageId!)).toBe("explicit");
		expect(announced).toEqual([input.messageId!]);
	});

	test("a shirtless photo is clear: uncovered and not announced", async () => {
		detectorAnswer = SHIRTLESS;
		const input = photo();
		const check = await checkMediaBytes(input);
		expect(verdictOf(check)).toBe("clear");
		expect(getContentCoverForMessage(input.messageId!)).toBeNull();
		expect(announced).toEqual([]);
	});

	test("a photo nobody has checked is covered", () => {
		expect(getContentCoverForMessage("never-seen")).toBe("unchecked");
	});

	test("a detector that fails leaves no verdict, and the photo stays covered", async () => {
		detectorAnswer = new Error("could not decode image");
		const input = photo();
		expect(await checkMediaBytes(input)).toBeNull();
		expect(getContentCoverForMessage(input.messageId!)).toBe("unchecked");
		expect(announced).toEqual([]);
	});

	test("a failed photo is not retried straight away", async () => {
		detectorAnswer = new Error("could not decode image");
		const input = photo();
		await checkMediaBytes(input);
		await checkMediaBytes(input);
		expect(detectorCalls).toBe(1);
	});

	test("the same photo in a new message is not checked twice, but is announced for the new message", async () => {
		detectorAnswer = EXPLICIT;
		const first = photo();
		await checkMediaBytes(first);
		const second = { ...first, messageId: "the-same-photo-again" };
		await checkMediaBytes(second);
		expect(detectorCalls).toBe(1);
		expect(getContentCoverForMessage("the-same-photo-again")).toBe("explicit");
		expect(announced).toEqual([first.messageId!, "the-same-photo-again"]);
	});

	test("two checks of one photo at once run the detector once", async () => {
		detectorAnswer = EXPLICIT;
		const input = photo();
		const [a, b] = await Promise.all([checkMediaBytes(input), checkMediaBytes(input)]);
		expect(detectorCalls).toBe(1);
		expect(verdictOf(a)).toBe("explicit");
		expect(verdictOf(b)).toBe("explicit");
	});

	test("audio is never sent to the detector", async () => {
		expect(await checkMediaBytes(photo({ kind: "audio" }))).toBeNull();
		expect(detectorCalls).toBe(0);
	});

	test("a photo without a message is checked but announced to nobody", async () => {
		detectorAnswer = EXPLICIT;
		const check = await checkMediaBytes(photo({ messageId: null }));
		expect(verdictOf(check)).toBe("explicit");
		expect(announced).toEqual([]);
	});

	test("a handler that throws does not lose the verdict", async () => {
		detectorAnswer = EXPLICIT;
		setExplicitVerdictHandler(() => {
			throw new Error("handler broke");
		});
		const input = photo();
		expect(verdictOf(await checkMediaBytes(input))).toBe("explicit");
		expect(getContentCoverForMessage(input.messageId!)).toBe("explicit");
	});
});

describe("requestChecksForMessages", () => {
	beforeEach(() => {
		store.clear();
		detectorCalls = 0;
	});

	test("does nothing while the filter is off", async () => {
		await requestChecksForMessages([
			{ messageId: "m-off", conversationId: "1:2", mediaKey: "image:off", sender: null },
		]);
		expect(detectorCalls).toBe(0);
	});

	test("a message with nothing stored yet is left covered, not guessed at", async () => {
		setExplicitFilterEnabled(true);
		await requestChecksForMessages([
			{ messageId: "m-nothing-stored", conversationId: "1:2", mediaKey: "image:none", sender: null },
		]);
		expect(detectorCalls).toBe(0);
		expect(getContentCoverForMessage("m-nothing-stored")).toBe("unchecked");
	});
});
