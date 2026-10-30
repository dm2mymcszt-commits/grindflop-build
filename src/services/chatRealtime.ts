import { decode } from "@msgpack/msgpack";
import type {
	ChatRealtimeManagerOptions,
	RealtimeEnvelope,
	RealtimeStatus,
	RealtimeStatusReason,
} from "../types/chat-realtime";
import { appLog } from "../utils/logger";
import { traceEventType, traceSocketFrame } from "../utils/backgroundTrace";

async function normalizeSocketData(data: unknown): Promise<{
	kind: "text" | "blob" | "arraybuffer" | "unknown";
	size: number | null;
	text: string | null;
	bytes: Uint8Array | null;
	raw: unknown;
}> {
	if (typeof data === "string") {
		return {
			kind: "text",
			size: data.length,
			text: data,
			bytes: null,
			raw: data,
		};
	}

	if (data instanceof Blob) {
		const buffer = await data.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		const text = new TextDecoder().decode(bytes);
		return {
			kind: "blob",
			size: data.size,
			text,
			bytes,
			raw: data,
		};
	}

	if (data instanceof ArrayBuffer) {
		const bytes = new Uint8Array(data);
		const text = new TextDecoder().decode(bytes);
		return {
			kind: "arraybuffer",
			size: data.byteLength,
			text,
			bytes,
			raw: data,
		};
	}

	return {
		kind: "unknown",
		size: null,
		text: null,
		bytes: null,
		raw: data,
	};
}

export class ChatRealtimeManager {
	private readonly options: ChatRealtimeManagerOptions;
	private socket: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	private heartbeatTimer: number | null = null;
	private livenessTimer: number | null = null;
	private reconnectAttempts = 0;
	private stopped = true;
	private suppressDisconnectStatus = false;
	private lastActivityAt = 0;
	/** Set right before we close the socket ourselves, so onclose reports our reason, not a bare code. */
	private closeIntent: RealtimeStatusReason | null = null;
	/** The error text of the current socket, handed to its close when the close itself says nothing. */
	private lastErrorMessage: string | null = null;
	private currentToken: string | null = null;
	private pendingCommands = new Map<
		string,
		{ resolve: (result: unknown) => void; reject: (err: Error) => void; timer: number }
	>();
	// FIFO queue of refs for chat.v1.message.send — server responds with chat.v1.message_sent but ref is always null
	private pendingSendRefs: string[] = [];
	private readonly handleOnline = () => {
		if (this.stopped) {
			return;
		}
		// appLog.debug("[chat-ws] browser online event triggered");
		if (!this.socket) {
			void this.connect();
		}
	};
	private readonly handleOffline = () => {
		if (this.stopped) {
			return;
		}
		// appLog.debug("[chat-ws] browser offline event triggered");
		this.setStatus("disconnected", { kind: "offline" });
		if (this.socket) {
			this.closeIntent = { kind: "offline" };
			this.socket.close();
		}
	};

	constructor(options: ChatRealtimeManagerOptions) {
		this.options = {
			heartbeatMs: 15_000,
			maxSilenceMs: 300_000,
			maxBackoffMs: 20_000,
			...options,
		};
	}

	start() {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		this.suppressDisconnectStatus = false;
		window.addEventListener("online", this.handleOnline);
		window.addEventListener("offline", this.handleOffline);
		void this.connect();
	}

	stop(options?: { suppressStatus?: boolean }) {
		this.stopped = true;
		this.suppressDisconnectStatus = options?.suppressStatus ?? false;
		window.removeEventListener("online", this.handleOnline);
		window.removeEventListener("offline", this.handleOffline);
		this.clearReconnect();
		this.clearHeartbeat();
		this.clearLiveness();
		if (this.socket) {
			this.socket.close();
			this.socket = null;
			return;
		}

		if (!this.suppressDisconnectStatus) {
			this.setStatus("disconnected", { kind: "stopped" });
		}
	}

	send(commandType: string, token: string, payload: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				reject(new Error("WebSocket not connected"));
				return;
			}
			const ref = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
			const timer = window.setTimeout(() => {
				this.pendingCommands.delete(ref);
				reject(new Error("WebSocket command timed out"));
			}, 10_000);
			this.pendingCommands.set(ref, { resolve, reject, timer });
			if (commandType === "chat.v1.message.send") {
				this.pendingSendRefs.push(ref);
			}
			try {
				const msg = { type: commandType, ref, token, payload };
				appLog.debug("[chat-ws:send] outgoing", JSON.stringify(msg));
				this.socket.send(JSON.stringify(msg));
			} catch (err) {
				window.clearTimeout(timer);
				this.pendingCommands.delete(ref);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	getActiveToken(): string | null {
		return this.currentToken;
	}

	private setStatus(next: RealtimeStatus, reason?: RealtimeStatusReason) {
		this.options.onStatusChange?.(next, reason);
	}

	private clearPendingCommands(err: Error) {
		for (const pending of this.pendingCommands.values()) {
			window.clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pendingCommands.clear();
		this.pendingSendRefs = [];
	}

	private dispatchEvent(envelope: RealtimeEnvelope) {
		appLog.debug("[chat-ws:recv] incoming", JSON.stringify(envelope));
		const eventType = (envelope as Record<string, unknown>).type as string | undefined;
		// Server responds to chat.v1.message.send with chat.v1.message_sent but always ref=null,
		// so match against the FIFO queue of pending sends instead.
		if (eventType === "chat.v1.message_sent" && this.pendingSendRefs.length > 0) {
			const pendingRef = this.pendingSendRefs.shift()!;
			const pending = this.pendingCommands.get(pendingRef);
			if (pending) {
				window.clearTimeout(pending.timer);
				this.pendingCommands.delete(pendingRef);
				pending.resolve(envelope.payload);
				// Fall through to onEvent so ChatRealtimeBridge still persists the message
			}
		}
		// Ref-based matching for other command types
		const ref = (envelope as Record<string, unknown>).ref as string | undefined;
		if (ref) {
			const pending = this.pendingCommands.get(ref);
			if (pending) {
				window.clearTimeout(pending.timer);
				this.pendingCommands.delete(ref);
				const status = (envelope as Record<string, unknown>).status as number | undefined;
				if (status !== undefined && status >= 400) {
					pending.reject(new Error(`WS command failed with status ${status}`));
				} else {
					pending.resolve(envelope.payload);
				}
				return;
			}
		}
		traceEventType(envelope.type);
		this.options.onEvent(envelope);
	}

	private clearReconnect() {
		if (this.reconnectTimer != null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private clearHeartbeat() {
		if (this.heartbeatTimer != null) {
			window.clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private clearLiveness() {
		if (this.livenessTimer != null) {
			window.clearInterval(this.livenessTimer);
			this.livenessTimer = null;
		}
	}

	private markActivity() {
		this.lastActivityAt = Date.now();
	}

	private buildUrlWithToken(baseUrl: string, token: string | null): string {
		if (!token) {
			return baseUrl;
		}

		try {
			const url = new URL(baseUrl);
			url.searchParams.set("token", token);
			return url.toString();
		} catch {
			return baseUrl;
		}
	}

	private scheduleReconnect(reason?: RealtimeStatusReason) {
		if (this.stopped) {
			return;
		}

		const exp = Math.min(this.reconnectAttempts, 6);
		const delay = Math.min(
			this.options.maxBackoffMs ?? 25_000,
			1000 * Math.pow(2, exp),
		);
		const jitter = Math.floor(Math.random() * 300);

		// Without internet the retries keep going, but "Offline" is the true
		// state: it stays red until the network is back instead of flipping
		// to orange on every retry.
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			this.setStatus("disconnected", { kind: "offline" });
		} else {
			this.setStatus("reconnecting", reason);
		}
		this.clearReconnect();
		this.reconnectTimer = window.setTimeout(() => {
			void this.connect();
		}, delay + jitter);
	}

	private startHeartbeat() {
		this.clearHeartbeat();
		// We disable the manual JSON ping for now because the server is returning
		// "Could not convert frame to command". The Rust backend (tungstenite)
		// already handles low-level WebSocket pings automatically.
		/*
		const heartbeatMs = this.options.heartbeatMs ?? 25_000;
		this.heartbeatTimer = window.setInterval(() => {
			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				return;
			}

			try {
				this.socket.send(
					JSON.stringify({
						type: "ping",
					}),
				);
			} catch {
				this.socket.close();
			}
		}, heartbeatMs);
		*/
	}

	private startLivenessWatchdog() {
		this.clearLiveness();
		const silenceMs = this.options.maxSilenceMs ?? 180_000;
		const heartbeatMs = this.options.heartbeatMs ?? 25_000;
		this.livenessTimer = window.setInterval(
			() => {
				if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
					return;
				}
				if (this.lastActivityAt <= 0) {
					return;
				}
				if (Date.now() - this.lastActivityAt > silenceMs) {
					appLog.warn("[chat-ws] liveness watchdog triggered; closing socket");
					this.closeIntent = { kind: "silent", seconds: Math.round(silenceMs / 1000) };
					this.socket.close();
				}
			},
			Math.max(heartbeatMs, 10_000),
		);
	}

	private async connect() {
		if (this.stopped) {
			return;
		}

		this.setStatus("connecting", { kind: "starting", attempt: this.reconnectAttempts + 1 });
		// appLog.debug("[chat-ws] connect() invoked");
		this.clearReconnect();

		if (this.socket) {
			// appLog.debug("[chat-ws] cleaning up existing socket before new connect");
			const oldSocket = this.socket;
			this.socket = null;
			try {
				oldSocket.onopen = null;
				oldSocket.onmessage = null;
				oldSocket.onerror = null;
				oldSocket.onclose = null;
				oldSocket.close();
			} catch (error) {
				appLog.warn("[chat-ws] error closing old socket", error);
			}
		}
		this.closeIntent = null;
		this.lastErrorMessage = null;

		try {
			// appLog.debug("[chat-ws] fetching token...");
			const token = this.options.getToken
				? await this.options.getToken()
				: null;
			this.currentToken = token;

			const url = this.buildUrlWithToken(this.options.url, token);
			// appLog.debug("[chat-ws] building socket instance...", { url_len: url.length });

			const socket = this.options.buildSocket
				? this.options.buildSocket(url)
				: new WebSocket(url);

			this.socket = socket;

			socket.onopen = () => {
				if (this.socket !== socket) {
					// appLog.debug("[chat-ws] ignoring onopen for stale socket");
					return;
				}
				// appLog.debug("[chat-ws] onopen triggered");
				this.reconnectAttempts = 0;
				this.markActivity();
				this.setStatus("connected", { kind: "opened" });
				this.startHeartbeat();
				this.startLivenessWatchdog();
			};

			socket.onmessage = (event) => {
				if (this.socket !== socket) return;
				void (async () => {
					const normalized = await normalizeSocketData(event.data);
					// Ensure we don't process data if the socket was replaced or stopped during normalization
					if (this.socket !== socket || this.stopped) return;

					this.markActivity();
					traceSocketFrame();
					this.options.onRawMessage?.(normalized);

					// Prefer JSON text decoding; fallback to msgpack for binary frames.
					if (normalized.text) {
						try {
							const parsed = JSON.parse(normalized.text) as RealtimeEnvelope;
							this.dispatchEvent(parsed);
							return;
						} catch {
							// Continue to msgpack fallback.
						}
					}

					if (normalized.bytes) {
						try {
							const decoded = decode(normalized.bytes);
							if (decoded && typeof decoded === "object") {
								this.dispatchEvent(decoded as RealtimeEnvelope);
								return;
							}
						} catch {
							// Will report below.
						}
					}

					this.options.onParseError?.(normalized, "Unable to decode frame");
				})();
			};

			socket.onerror = (event) => {
				if (this.socket !== socket) return;
				appLog.warn("[chat-ws] onerror triggered", event);
				// The desktop and iPhone socket hands the native error text over
				// on the event; a browser WebSocket never says why.
				const message = (event as Partial<ErrorEvent>).message;
				if (message) this.lastErrorMessage = message;
				this.setStatus("error", { kind: "error", message: message || undefined });
			};

			socket.onclose = (event) => {
				if (this.socket !== socket) {
					// appLog.debug("[chat-ws] ignoring onclose for stale socket");
					return;
				}
				appLog.debug("[chat-ws] onclose triggered", { code: event.code, reason: event.reason });
				this.clearHeartbeat();
				this.clearLiveness();
				this.clearPendingCommands(new Error("WebSocket closed"));
				this.socket = null;
				const reason: RealtimeStatusReason = this.closeIntent ?? {
					kind: "closed",
					code: event.code,
					reason: event.reason || this.lastErrorMessage || undefined,
				};
				this.closeIntent = null;
				this.lastErrorMessage = null;
				if (this.stopped) {
					if (!this.suppressDisconnectStatus) {
						this.setStatus("disconnected", { kind: "stopped" });
					}
					this.suppressDisconnectStatus = false;
					return;
				}
				// 4401 = server closed because an expired token was used in a command.
				// Reset backoff so we reconnect immediately with a fresh token instead
				// of waiting through exponential delay.
				if (event.code === 4401) {
					appLog.debug("[chat-ws] token expired (4401); reconnecting immediately");
					this.reconnectAttempts = 0;
				} else {
					this.reconnectAttempts += 1;
				}
				this.scheduleReconnect(reason);
			};
		} catch (error) {
			appLog.error("[chat-ws] connect failed during setup", error);
			this.reconnectAttempts += 1;
			this.scheduleReconnect({
				kind: "setup_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

let _activeManager: ChatRealtimeManager | null = null;

export function setActiveRealtimeManager(
	manager: ChatRealtimeManager | null,
) {
	_activeManager = manager;
}

export function sendViaRealtime(
	commandType: string,
	payload: unknown,
): Promise<unknown> {
	const token = _activeManager?.getActiveToken() ?? null;
	if (!_activeManager || !token) {
		return Promise.reject(new Error("WebSocket not available"));
	}
	return _activeManager.send(commandType, token, payload);
}
