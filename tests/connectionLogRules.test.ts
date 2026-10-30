import { describe, expect, test } from "bun:test";
import type { RealtimeStatus, RealtimeStatusReason } from "../src/types/chat-realtime";
import {
	APP_CLOSED_GAP_MS,
	MAX_EPISODES,
	SETTLE_MS,
	applyRawStatus,
	createConnectionLogState,
	currentConnectionState,
	episodeEnd,
	parseStoredEpisodes,
	scrubDetail,
	serializeEpisodes,
	settleIfDue,
	type ConnectionLogState,
} from "../src/utils/connectionLogRules";

const t0 = Date.UTC(2026, 9, 22, 8, 0, 0);

/** Feeds raw states in order, settling whenever enough time has passed, like the store's timer does. */
function run(
	state: ConnectionLogState,
	steps: [atMs: number, status: RealtimeStatus, reason?: RealtimeStatusReason][],
): ConnectionLogState {
	let current = state;
	for (const [at, status, reason] of steps) {
		current = settleIfDue(current, at).state;
		current = applyRawStatus(current, status, reason, at);
	}
	return current;
}

function settled(state: ConnectionLogState, at: number): ConnectionLogState {
	return settleIfDue(state, at).state;
}

const startedGreen = () => settled(
	run(createConnectionLogState(), [
		[t0, "connecting", { kind: "starting", attempt: 1 }],
		[t0 + 400, "connected", { kind: "opened" }],
	]),
	t0 + 400 + SETTLE_MS,
);

describe("connection dot history", () => {
	test("an app start that connects at once is one green period", () => {
		const state = startedGreen();
		expect(state.episodes).toHaveLength(1);
		expect(state.episodes[0]).toMatchObject({
			color: "green",
			status: "connected",
			appStart: true,
			cause: { kind: "opened" },
			attempts: 1,
		});
		expect(currentConnectionState(state).color).toBe("green");
	});

	test("a failing connection is one orange period, not a flashing dot", () => {
		const drop = t0 + 60_000;
		const steps: [number, RealtimeStatus, RealtimeStatusReason?][] = [
			[drop, "reconnecting", { kind: "closed", code: 1006, reason: "HTTP error: 403 Forbidden" }],
		];
		// Ten failed retries: connecting, error, close.
		for (let i = 1; i <= 10; i += 1) {
			const at = drop + i * 20_000;
			steps.push([at, "connecting", { kind: "starting", attempt: i + 1 }]);
			steps.push([at + 200, "error", { kind: "error", message: "HTTP error: 403 Forbidden" }]);
			steps.push([at + 201, "reconnecting", { kind: "closed", code: 1006, reason: "HTTP error: 403 Forbidden" }]);
		}
		const state = settled(run(startedGreen(), steps), drop + 11 * 20_000);

		expect(state.episodes.map((episode) => episode.color)).toEqual(["green", "orange"]);
		const orange = state.episodes[1];
		expect(orange.since).toBe(drop);
		expect(orange.cause).toEqual({ kind: "closed", code: 1006, reason: "HTTP error: 403 Forbidden" });
		expect(orange.attempts).toBe(10);
		// One problem per failed retry; the socket error itself is not counted twice.
		expect(orange.problems).toBe(10);
		expect(orange.lastProblem?.at).toBe(drop + 10 * 20_000 + 201);
		expect(currentConnectionState(state).color).toBe("orange");
	});

	test("a drop that reconnects within the settle time stays green and is counted", () => {
		const drop = t0 + 60_000;
		const state = settled(
			run(startedGreen(), [
				[drop, "reconnecting", { kind: "closed", code: 1006 }],
				[drop + 300, "connecting", { kind: "starting", attempt: 2 }],
				[drop + 700, "connected", { kind: "opened" }],
			]),
			drop + 10_000,
		);
		expect(state.episodes).toHaveLength(1);
		expect(state.episodes[0]).toMatchObject({ color: "green", problems: 1, attempts: 2 });
		expect(state.episodes[0].lastProblem?.reason).toEqual({ kind: "closed", code: 1006 });
	});

	test("coming back from orange starts a green period with the time it took", () => {
		const drop = t0 + 60_000;
		const back = drop + 5 * 60_000;
		const state = settled(
			run(startedGreen(), [
				[drop, "reconnecting", { kind: "closed", code: 4401, reason: "token expired" }],
				[back, "connecting", { kind: "starting", attempt: 2 }],
				[back + 500, "connected", { kind: "opened" }],
			]),
			back + 500 + SETTLE_MS,
		);
		expect(state.episodes.map((episode) => episode.color)).toEqual(["green", "orange", "green"]);
		// Green from the moment the connection opened; the attempt belongs to the orange period.
		expect(state.episodes[2]).toMatchObject({ since: back + 500, cause: { kind: "opened" } });
		expect(state.episodes[2].appStart).toBeUndefined();
		expect(state.episodes[1].attempts).toBe(1);
		const end = episodeEnd(state.episodes, 1, { now: back + 10_000, isCurrent: false });
		expect(end).toEqual({ end: back + 500, appClosed: false });
	});

	test("no internet is red", () => {
		const cut = t0 + 60_000;
		const state = settled(
			run(startedGreen(), [[cut, "disconnected", { kind: "offline" }]]),
			cut + SETTLE_MS,
		);
		expect(state.episodes[1]).toMatchObject({ color: "red", status: "disconnected", cause: { kind: "offline" } });
	});

	test("the next app start says the app was closed in between", () => {
		const first = startedGreen();
		// The app is closed; hours later it starts again with the stored history.
		const reopenedAt = first.episodes[0].lastAt + 3 * 60 * 60_000;
		const restarted = settled(
			run(createConnectionLogState(first.episodes), [
				[reopenedAt, "connecting", { kind: "starting", attempt: 1 }],
				[reopenedAt + 300, "connected", { kind: "opened" }],
			]),
			reopenedAt + 300 + SETTLE_MS,
		);
		expect(restarted.episodes).toHaveLength(2);
		expect(restarted.episodes[1].appStart).toBe(true);
		expect(episodeEnd(restarted.episodes, 0, { now: reopenedAt + 60_000, isCurrent: false })).toEqual({
			end: first.episodes[0].lastAt,
			appClosed: true,
		});
		expect(reopenedAt - first.episodes[0].lastAt).toBeGreaterThan(APP_CLOSED_GAP_MS);
	});

	test("until this session settles, the dot shows the live state, not yesterday's last line", () => {
		const yesterday = startedGreen().episodes;
		const state = run(createConnectionLogState(yesterday), [
			[t0 + 86_400_000, "connecting", { kind: "starting", attempt: 1 }],
		]);
		expect(currentConnectionState(state)).toMatchObject({ color: "orange", status: "connecting", since: null });
	});

	test("the history keeps the newest periods only", () => {
		let state = startedGreen();
		let at = t0 + 10_000;
		for (let i = 0; i < MAX_EPISODES + 20; i += 1) {
			at += 60_000;
			state = settled(applyRawStatus(state, i % 2 ? "connected" : "reconnecting", undefined, at), at + SETTLE_MS);
		}
		expect(state.episodes).toHaveLength(MAX_EPISODES);
		expect(state.episodes[state.episodes.length - 1].since).toBe(at);
	});
});

describe("connection history storage", () => {
	test("what is stored reads back the same", () => {
		const episodes = startedGreen().episodes;
		expect(parseStoredEpisodes(serializeEpisodes(episodes))).toEqual(episodes);
	});

	test("malformed storage is dropped, never thrown", () => {
		expect(parseStoredEpisodes(null)).toEqual([]);
		expect(parseStoredEpisodes("not json")).toEqual([]);
		expect(parseStoredEpisodes(JSON.stringify({ v: 2, episodes: [] }))).toEqual([]);
		expect(parseStoredEpisodes(JSON.stringify({ v: 1, episodes: [{ color: "blue", since: 1 }, null] }))).toEqual([]);
	});

	test("nothing that looks like a session key is kept", () => {
		expect(scrubDetail("connect wss://grindr.mobi/v1/ws?token=abc.def-123 failed")).toBe(
			"connect wss://grindr.mobi/v1/ws?token=… failed",
		);
		expect(scrubDetail("Authorization: Grindr3 eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe("Authorization: Grindr3 …");
		expect(scrubDetail("bad key Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg here")).toBe("bad key … here");
		expect(scrubDetail("HTTP error: 403 Forbidden")).toBe("HTTP error: 403 Forbidden");
		expect(scrubDetail("   ")).toBeUndefined();
	});

	test("a close reason is cleaned before it is kept", () => {
		const state = applyRawStatus(startedGreen(), "reconnecting", {
			kind: "closed",
			code: 1006,
			reason: "ws connect: url wss://grindr.mobi/v1/ws?token=SECRETSECRET",
		}, t0 + 60_000);
		expect(JSON.stringify(state)).not.toContain("SECRETSECRET");
	});
});
