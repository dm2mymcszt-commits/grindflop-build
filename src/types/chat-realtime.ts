export type RealtimeStatus =
	| "idle"
	| "polling"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected"
	| "error";

/**
 * Why the live connection just changed state. Carried next to the status so
 * the connection history can say what happened, not only that it happened.
 */
export type RealtimeStatusReason =
	| { kind: "starting"; attempt: number }
	| { kind: "opened" }
	/** The socket closed: a close frame from Grindr, or 1006 when none came. */
	| { kind: "closed"; code: number; reason?: string }
	| { kind: "error"; message?: string }
	/** Our own watchdog closed a socket that had gone quiet for too long. */
	| { kind: "silent"; seconds: number }
	| { kind: "setup_failed"; message?: string }
	| { kind: "offline" }
	| { kind: "stopped" };

export interface RealtimeEnvelope {
	type?: string;
	event?: string;
	timestamp?: number;
	payload?: unknown;
	data?: unknown;
	[key: string]: unknown;
}

export interface ChatRealtimeManagerOptions {
	url: string;
	getToken?: () => Promise<string | null> | string | null;
	onEvent: (event: RealtimeEnvelope) => void;
	onStatusChange?: (status: RealtimeStatus, reason?: RealtimeStatusReason) => void;
	onRawMessage?: (raw: unknown) => void;
	onParseError?: (raw: unknown, error: unknown) => void;
	heartbeatMs?: number;
	maxSilenceMs?: number;
	maxBackoffMs?: number;
	buildSocket?: (url: string) => WebSocket;
}
