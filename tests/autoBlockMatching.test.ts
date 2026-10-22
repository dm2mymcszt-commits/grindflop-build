import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// autoblock.ts imports the Tauri notification plugin for the notify half of
// the module, which has no browserless implementation to import. `mock.module`
// is process-wide and permanent in bun — it replaces the module for every file
// that runs afterwards too — so stub the one thing that genuinely cannot be
// loaded and nothing else. In particular chatDb must NOT be stubbed here: the
// Drive-sync and backup suites import the real one, and a partial stub of it
// silently strips exports out from under them.
mock.module("@tauri-apps/plugin-notification", () => ({
	isPermissionGranted: async () => false,
	requestPermission: async () => "denied",
	sendNotification: () => {},
}));

const store = new Map<string, string>();
const globalScope = globalThis as unknown as { window?: unknown };
const previousWindow = globalScope.window;
// Bun shares one global object across test files, and a bare `window` is
// enough to make DOM-sniffing libraries in later files take their browser
// path and then reach for `document`. Put it back when this file is done.
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
};

const {
	getFirstMessageWords,
	getForbiddenWords,
	getKeywordsToReview,
	getMatchedForbiddenWord,
	getMatchedFirstMessageWord,
	hasRightNowStatus,
	hasTwitterAccount,
	loadAutomationCache,
} = await import("../src/utils/autoblock");
const chatDb = await import("../src/services/chatDb");

function setKeywords(list: string): void {
	store.set("fg-forbidden-words", list);
}

describe("forbidden keyword matching", () => {
	beforeEach(() => {
		store.clear();
	});

	test("matches a display name that is exactly the keyword", () => {
		setKeywords("fem, femboy, chaud");
		expect(getMatchedForbiddenWord("fem", "name")).toBe("fem");
		expect(getMatchedForbiddenWord("Fem", "name")).toBe("fem");
		expect(getMatchedForbiddenWord(" fem ", "name")).toBe("fem");
	});

	test("still requires a whole word, so it cannot block by accident", () => {
		setKeywords("fem, sub");
		expect(getMatchedForbiddenWord("femboy", "name")).toBeNull();
		expect(getMatchedForbiddenWord("submit", "message")).toBeNull();
		expect(getMatchedForbiddenWord("confemination", "bio")).toBeNull();
	});

	test("a keyword the engine cannot compile does not disable the rest of the list", () => {
		// A lone surrogate — what a truncated emoji in a pasted or imported
		// list looks like — is rejected outright by the unicode-mode regex.
		setKeywords(`fem, \uD800, chaud`);
		expect(getMatchedForbiddenWord("fem", "name")).toBe("fem");
		expect(getMatchedForbiddenWord("chaud", "message")).toBe("chaud");
	});

	test("editing the list takes effect on the next check", () => {
		setKeywords("chaud");
		expect(getMatchedForbiddenWord("fem", "name")).toBeNull();
		setKeywords("chaud, fem");
		expect(getMatchedForbiddenWord("fem", "name")).toBe("fem");
	});

	test("the per-field toggles still gate their own field only", () => {
		setKeywords("fem");
		store.set("fg-block-name", "false");
		expect(getMatchedForbiddenWord("fem", "name")).toBeNull();
		expect(getMatchedForbiddenWord("fem", "bio")).toBe("fem");
	});
});

// "tu cherches" blocked someone who wrote "Salut, tu cherches quoi ?". A quoted
// entry is the fix: it only matches when that is the entire message.
describe("whole-message keywords", () => {
	beforeEach(() => {
		store.clear();
	});

	test("a quoted phrase blocks only a message that is exactly that phrase", () => {
		setKeywords('"tu cherches"');
		expect(getMatchedForbiddenWord("Tu cherches ?", "message")).toBe("tu cherches");
		expect(getMatchedForbiddenWord("  tu   cherches ", "message")).toBe("tu cherches");
		expect(getMatchedForbiddenWord("Salut, tu cherches quoi ?", "message")).toBeNull();
	});

	test("a bare phrase still matches anywhere", () => {
		setKeywords("best gay space");
		expect(getMatchedForbiddenWord("Join the best gay space now", "message")).toBe("best gay space");
	});

	test("a quoted entry means the whole name or bio too", () => {
		setKeywords('"fem"');
		expect(getMatchedForbiddenWord("Fem", "name")).toBe("fem");
		expect(getMatchedForbiddenWord("fem sub", "name")).toBeNull();
	});

	test("both kinds work side by side", () => {
		setKeywords('telegram, "tu cherches"');
		expect(getMatchedForbiddenWord("add me on telegram", "message")).toBe("telegram");
		expect(getMatchedForbiddenWord("tu cherches", "message")).toBe("tu cherches");
	});
});

// The inbox entry carries only the RightNowStatus string, so these three
// values are the whole input space this check sees there.
describe("right now status", () => {
	beforeEach(() => {
		store.clear();
		store.set("fg-block-right-now", "true");
	});

	test("only an active hosting status counts", () => {
		expect(hasRightNowStatus({ rightNow: "HOSTING" })).toBe(true);
		expect(hasRightNowStatus({ rightNow: "NOT_HOSTING" })).toBe(true);
	});

	test("NOT_ACTIVE and a missing status never count", () => {
		expect(hasRightNowStatus({ rightNow: "NOT_ACTIVE" })).toBe(false);
		expect(hasRightNowStatus({ rightNow: null })).toBe(false);
		expect(hasRightNowStatus({})).toBe(false);
	});

	test("the setting still gates it", () => {
		store.set("fg-block-right-now", "false");
		expect(hasRightNowStatus({ rightNow: "HOSTING" })).toBe(false);
	});
});

// Only the X link is a signal — Instagram and Facebook handles are ordinary
// and must never be what gets someone blocked.
describe("X / Twitter account", () => {
	beforeEach(() => {
		store.clear();
		store.set("fg-block-twitter", "true");
	});

	test("a linked X handle counts", () => {
		expect(hasTwitterAccount({ socialNetworks: { twitter: { userId: "EpsyPuppy" } } })).toBe(true);
	});

	test("an empty, missing or absent handle never counts", () => {
		expect(hasTwitterAccount({ socialNetworks: { twitter: { userId: "  " } } })).toBe(false);
		expect(hasTwitterAccount({ socialNetworks: { twitter: { userId: null } } })).toBe(false);
		expect(hasTwitterAccount({ socialNetworks: {} })).toBe(false);
		expect(hasTwitterAccount({})).toBe(false);
		expect(hasTwitterAccount(null)).toBe(false);
	});

	test("the other networks are left alone", () => {
		expect(
			hasTwitterAccount({
				socialNetworks: { instagram: { userId: "epsy_404" }, facebook: { userId: "epsy" } },
			} as never),
		).toBe(false);
	});

	test("the setting still gates it", () => {
		store.set("fg-block-twitter", "false");
		expect(hasTwitterAccount({ socialNetworks: { twitter: { userId: "EpsyPuppy" } } })).toBe(false);
	});
});

// The openers list exists precisely because these words are unremarkable in
// the middle of a conversation — matching must be the whole message, not a
// substring, or it collapses back into the forbidden-keywords rule.
describe("first-message-only openers", () => {
	beforeEach(() => {
		store.clear();
		store.set("fg-first-message-words", "hot, hey sexy, ?");
	});

	test("matches an opener that is exactly the entry", () => {
		expect(getMatchedFirstMessageWord("hot")).toBe("hot");
		expect(getMatchedFirstMessageWord("Hot")).toBe("hot");
		expect(getMatchedFirstMessageWord("  Hot  ")).toBe("hot");
		expect(getMatchedFirstMessageWord("hey sexy")).toBe("hey sexy");
	});

	test("ignores the punctuation people put around a one-word opener", () => {
		expect(getMatchedFirstMessageWord("Hot!")).toBe("hot");
		expect(getMatchedFirstMessageWord("hot...")).toBe("hot");
		expect(getMatchedFirstMessageWord("*hot*")).toBe("hot");
		expect(getMatchedFirstMessageWord("?")).toBe("?");
	});

	test("does not match when the word is only part of the message", () => {
		expect(getMatchedFirstMessageWord("Hello, hot")).toBeNull();
		expect(getMatchedFirstMessageWord("hot?? you free")).toBeNull();
		expect(getMatchedFirstMessageWord("you look hot")).toBeNull();
		expect(getMatchedFirstMessageWord("hotel")).toBeNull();
	});

	test("is independent of the forbidden keyword list", () => {
		store.clear();
		store.set("fg-forbidden-words", "hot");
		expect(getMatchedFirstMessageWord("hot")).toBeNull();
	});

	test("an empty list matches nothing", () => {
		store.clear();
		expect(getMatchedFirstMessageWord("hot")).toBeNull();
		expect(getMatchedFirstMessageWord("")).toBeNull();
	});

	test("an opener with a comma in it is one entry", () => {
		store.set("fg-first-message-words", '"salut, ça va", hot');
		expect(getMatchedFirstMessageWord("Salut, ça va ?")).toBe("salut, ça va");
		expect(getMatchedFirstMessageWord("salut")).toBeNull();
	});
});

// An opener can now match anywhere in the first message, which is the rule
// for a fragment like "looking for" that is only worth blocking as an opener.
describe("openers that match anywhere in the first message", () => {
	afterEach(async () => {
		store.clear();
		const getSetting = spyOn(chatDb, "getSetting").mockResolvedValue(null as never);
		try {
			await loadAutomationCache();
		} finally {
			getSetting.mockRestore();
		}
	});

	async function withStoredOpeners(settings: Record<string, unknown>, run: () => void): Promise<void> {
		store.clear();
		const getSetting = spyOn(chatDb, "getSetting").mockResolvedValue(settings as never);
		try {
			await loadAutomationCache();
			run();
		} finally {
			getSetting.mockRestore();
		}
	}

	test("an anywhere opener catches a first message that merely contains it", async () => {
		await withStoredOpeners({ firstMessageWords: 'looking for, "hot"', openerFormat: 2 }, () => {
			expect(getMatchedFirstMessageWord("ey looking for")).toBe("looking for");
			expect(getMatchedFirstMessageWord("Looking for?")).toBe("looking for");
			// The quoted one stays whole-message, side by side with it.
			expect(getMatchedFirstMessageWord("hot")).toBe("hot");
			expect(getMatchedFirstMessageWord("hey hot")).toBeNull();
		});
	});

	test("an anywhere opener still needs whole words", async () => {
		await withStoredOpeners({ firstMessageWords: "looking for", openerFormat: 2 }, () => {
			expect(getMatchedFirstMessageWord("ey lookin")).toBeNull();
			expect(getMatchedFirstMessageWord("overlooking foreign")).toBeNull();
		});
	});

	test("a list saved before openers had modes keeps matching whole messages only", async () => {
		await withStoredOpeners({ firstMessageWords: "hot, looking for" }, () => {
			expect(getMatchedFirstMessageWord("ey looking for")).toBeNull();
			expect(getMatchedFirstMessageWord("looking for")).toBe("looking for");
			expect(getFirstMessageWords()).toBe('"hot", "looking for"');
		});
	});
});

// Kept last: loading the cache makes it, not localStorage, the source of the
// list, so the suites above would read stale values if this ran first.
describe("keyword format upgrade", () => {
	afterEach(async () => {
		// Leave an empty cache behind so later files fall back to localStorage.
		store.clear();
		const getSetting = spyOn(chatDb, "getSetting").mockResolvedValue(null as never);
		try {
			await loadAutomationCache();
		} finally {
			getSetting.mockRestore();
		}
	});

	test("an old list is read with its phrases as whole messages, without being written back", async () => {
		store.clear();
		const getSetting = spyOn(chatDb, "getSetting").mockResolvedValue({
			forbiddenWords: "telegram, tu cherches",
		} as never);
		const setSetting = spyOn(chatDb, "setSetting").mockResolvedValue(undefined as never);
		try {
			await loadAutomationCache();
			expect(getForbiddenWords()).toBe('telegram, "tu cherches"');
			expect(getKeywordsToReview()).toEqual(["tu cherches"]);
			expect(getMatchedForbiddenWord("salut tu cherches quoi", "message")).toBeNull();
			expect(getMatchedForbiddenWord("telegram", "message")).toBe("telegram");
			// A device that has not synced yet must not replace a newer list.
			expect(setSetting).not.toHaveBeenCalled();
		} finally {
			getSetting.mockRestore();
			setSetting.mockRestore();
		}
	});

	test("a list already in the new format is read as written", async () => {
		store.clear();
		const getSetting = spyOn(chatDb, "getSetting").mockResolvedValue({
			forbiddenWords: "hey sexy",
			keywordFormat: 2,
		} as never);
		try {
			await loadAutomationCache();
			expect(getForbiddenWords()).toBe("hey sexy");
			expect(getKeywordsToReview()).toEqual([]);
			expect(getMatchedForbiddenWord("well hey sexy", "message")).toBe("hey sexy");
		} finally {
			getSetting.mockRestore();
		}
	});
});
