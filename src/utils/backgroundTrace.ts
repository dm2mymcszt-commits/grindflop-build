/**
 * What the app received and did while it was out of sight, for the
 * "Keep Running in Background" diagnostic details. The phone has no log the
 * user can read, so this is how a background test says where a message
 * stopped: never arrived, arrived but was not announced, or the notification
 * itself failed. Counts only, never names or message text.
 */

const STORAGE_KEY = "fg-background-trace";

type BackgroundTrace = {
	awaySince: number;
	backAt: number;
	status: string;
	statusChanges: number;
	events: number;
	messages: number;
	notify: Record<string, number>;
	/** Last heartbeat, and the longest gap between two: a gap far above
	 * BEAT_MS means iOS paused the page, whatever the switch says. */
	lastBeat?: number;
	longestPause?: number;
	/** Raw socket frames, whatever they carried. */
	frames?: number;
	/** Time-stamped lines, newest last, at most TIMELINE_MAX. */
	timeline?: string[];
};

const TIMELINE_MAX = 40;

const BEAT_MS = 20_000;

function emptyTrace(awaySince: number): BackgroundTrace {
	return {
		awaySince,
		backAt: 0,
		status: "",
		statusChanges: 0,
		events: 0,
		messages: 0,
		notify: {},
		lastBeat: awaySince,
		longestPause: 0,
		frames: 0,
		timeline: [],
	};
}

function load(): BackgroundTrace | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as BackgroundTrace) : null;
	} catch {
		return null;
	}
}

let trace: BackgroundTrace | null = typeof window === "undefined" ? null : load();
let lastStatus = "";
let beat: ReturnType<typeof setInterval> | null = null;

function save(): void {
	try {
		if (trace) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trace));
	} catch {
		// Private storage refused: the counts still live for this session.
	}
}

function isAway(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 8);
}

function note(current: BackgroundTrace, text: string, at = Date.now()): void {
	const lines = current.timeline ?? (current.timeline = []);
	lines.push(`${clock(at)} ${text}`);
	if (lines.length > TIMELINE_MAX) lines.splice(0, lines.length - TIMELINE_MAX);
}

/** Counts only while the page is hidden. */
function record(change: (current: BackgroundTrace) => void): void {
	if (!isAway() || !trace || trace.backAt) return;
	change(trace);
	save();
}

export function traceSocketStatus(status: string): void {
	lastStatus = status;
	record((current) => {
		current.status = status;
		current.statusChanges += 1;
		note(current, `socket ${status}`);
	});
}

export function traceSocketEvent(): void {
	record((current) => {
		current.events += 1;
	});
}

/** Every frame the socket hands over, before any parsing. */
export function traceSocketFrame(): void {
	record((current) => {
		current.frames = (current.frames ?? 0) + 1;
	});
}

/** One line per parsed socket event, with Grindr's event type. */
export function traceEventType(type: string | undefined): void {
	record((current) => note(current, `event ${type ?? "?"}`));
}

export function traceMessages(count: number): void {
	record((current) => {
		current.messages += count;
	});
}

/** One outcome per notification the app tried to show: "sent", "no permission"… */
export function traceNotification(outcome: string): void {
	record((current) => {
		current.notify[outcome] = (current.notify[outcome] ?? 0) + 1;
		note(current, `notification ${outcome}`);
	});
}

function heartbeat(at: number): void {
	if (!trace || trace.backAt) return;
	const last = trace.lastBeat ?? trace.awaySince;
	trace.longestPause = Math.max(trace.longestPause ?? 0, at - last);
	// Written when the page runs again: the line's time is the end of the pause.
	if (at - last > 60_000) note(trace, `paused ${Math.round((at - last) / 60_000)} min`, at);
	trace.lastBeat = at;
	save();
}

export function describeBackgroundTrace(): string {
	if (!trace) return "";
	const end = trace.backAt || Date.now();
	const minutes = Math.max(0, Math.round((end - trace.awaySince) / 60_000));
	const outcomes = Object.entries(trace.notify).map(([outcome, count]) => `${outcome} ×${count}`);
	return [
		`last time away: ${minutes} min`,
		`socket: ${trace.status || "no change"} (${trace.statusChanges} changes)`,
		`${trace.frames ?? 0} frames`,
		`${trace.events} events`,
		`${trace.messages} messages`,
		`notifications: ${outcomes.length ? outcomes.join(", ") : "none tried"}`,
		`longest pause: ${Math.round((trace.longestPause ?? 0) / 60_000)} min`,
	].join(" · ");
}

/** What happened while away, one line each, for the diagnostic details. */
export function backgroundTimeline(): string[] {
	return trace?.timeline ?? [];
}

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (isAway()) {
			trace = emptyTrace(Date.now());
			trace.status = lastStatus;
			note(trace, `away (socket ${lastStatus || "?"})`);
			if (beat == null) beat = setInterval(() => heartbeat(Date.now()), BEAT_MS);
		} else {
			if (beat != null) clearInterval(beat);
			beat = null;
			if (trace && !trace.backAt) {
				// A pause that lasted until now counts too.
				heartbeat(Date.now());
				note(trace, "back");
				trace.backAt = Date.now();
			}
		}
		save();
	});
}
