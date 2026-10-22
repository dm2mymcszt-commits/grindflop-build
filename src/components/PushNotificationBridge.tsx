import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../services/tauriWebSocket";
import { appLog } from "../utils/logger";
import { clickedNotification } from "../utils/notificationClick";

type NativePushNotificationDetail = {
	event?: string;
	action?: string | null;
	conversationId?: string | null;
};

declare global {
	interface Window {
		__FG_PUSH_NOTIFICATIONS?: NativePushNotificationDetail[];
	}
}

function isPushNotificationDetail(value: unknown): value is NativePushNotificationDetail {
	return typeof value === "object" && value !== null;
}

function detailKey(detail: NativePushNotificationDetail): string {
	const event = typeof detail.event === "string" ? detail.event : "";
	const action = typeof detail.action === "string" ? detail.action : "";
	const conversationId =
		typeof detail.conversationId === "string" ? detail.conversationId : "";
	return `${event}|${action}|${conversationId}`;
}

function removeQueuedPushNotification(detail: NativePushNotificationDetail) {
	if (!Array.isArray(window.__FG_PUSH_NOTIFICATIONS)) {
		return;
	}

	const targetKey = detailKey(detail);
	window.__FG_PUSH_NOTIFICATIONS = window.__FG_PUSH_NOTIFICATIONS.filter(
		(queuedDetail) => detailKey(queuedDetail) !== targetKey,
	);
}

function consumePendingPushNotifications(
	handleDetail: (detail: NativePushNotificationDetail) => void,
) {
	const queue = Array.isArray(window.__FG_PUSH_NOTIFICATIONS)
		? [...window.__FG_PUSH_NOTIFICATIONS]
		: [];
	window.__FG_PUSH_NOTIFICATIONS = [];
	for (const detail of queue) {
		handleDetail(detail);
	}
}

function getConversationId(detail: NativePushNotificationDetail): string | null {
	if (typeof detail.conversationId === "string" && detail.conversationId.trim()) {
		return detail.conversationId.trim();
	}

	if (typeof detail.action === "string" && detail.action.startsWith("chat:")) {
		const conversationId = detail.action.slice(5).trim();
		return conversationId || null;
	}

	if (
		typeof detail.action === "string" &&
		detail.action.startsWith("grindr://conversation")
	) {
		try {
			const url = new URL(detail.action);
			const conversationId = url.searchParams.get("id")?.trim() ?? "";
			return conversationId || null;
		} catch {
			return null;
		}
	}

	return null;
}

function getNotificationRoute(detail: NativePushNotificationDetail): string | null {
	const conversationId = getConversationId(detail);
	if (conversationId) {
		return `/chat/${encodeURIComponent(conversationId)}`;
	}

	if (detail.action === "taps") {
		// The tab is named: the page may open on views by default, and a tap
		// notification is about the taps.
		return "/interest?tab=taps";
	}

	return null;
}

export function PushNotificationBridge() {
	const navigate = useNavigate();
	const recentlyHandledKeysRef = useRef<Map<string, number>>(new Map());


	useEffect(() => {
		const markHandled = (detail: NativePushNotificationDetail): boolean => {
			const key = detailKey(detail);
			const now = Date.now();
			const recentWindowMs = 10_000;
			const lastHandledAt = recentlyHandledKeysRef.current.get(key);
			if (typeof lastHandledAt === "number" && now - lastHandledAt < recentWindowMs) {
				return false;
			}

			recentlyHandledKeysRef.current.set(key, now);
			for (const [existingKey, handledAt] of recentlyHandledKeysRef.current) {
				if (now - handledAt >= recentWindowMs) {
					recentlyHandledKeysRef.current.delete(existingKey);
				}
			}

			return true;
		};

		// A native push can arrive twice, once from the queue and once as an
		// event, so those are checked against what was handled a moment ago.
		// A click on a desktop notification arrives once, and two clicks in a
		// row are two requests.
		const handleDetail = (detail: NativePushNotificationDetail, mayRepeat = false) => {
			if (!mayRepeat && !markHandled(detail)) {
				appLog.info("[PUSH_EVENT] Skipping duplicate push payload", detail);
				return;
			}

			appLog.info("[PUSH_EVENT] Received native push payload", detail);

			if (detail.event === "opened") {
				const route = getNotificationRoute(detail);
				if (route) {
					try {
						// The time goes along because the address alone may not
						// change: on a desktop the chat page keeps its own
						// selection, so a notification for the conversation the
						// address already names would otherwise move nothing.
						navigate(route, { state: { notificationClickedAt: Date.now() } });
					} catch (error) {
						appLog.error(
							"[PUSH_EVENT] Failed to navigate to notification route",
							error,
						);
						navigate("/chat");
					}
				}
			}
		};

		const onPushNotification = (event: Event) => {
			const detail = (event as CustomEvent).detail;
			if (!isPushNotificationDetail(detail)) {
				appLog.warn("[PUSH_EVENT] Ignoring malformed native push payload", detail);
				return;
			}

			removeQueuedPushNotification(detail);
			handleDetail(detail);
		};

		window.addEventListener(
			"fg:push-notification",
			onPushNotification as EventListener,
		);
		consumePendingPushNotifications(handleDetail);

		// Windows: the Rust side reports a clicked notification here, with the
		// group it was posted under.
		let cancelled = false;
		let stopListening: (() => void) | undefined;
		if (isTauriRuntime()) {
			void listen<unknown>("fg:notification-clicked", (event) => {
				const detail = clickedNotification(event.payload);
				if (detail) {
					handleDetail(detail, true);
				}
			})
				.then((stop) => {
					if (cancelled) {
						stop();
					} else {
						stopListening = stop;
					}
				})
				.catch((error) => {
					appLog.warn("[PUSH_EVENT] Cannot listen for clicked notifications", error);
				});
		}

		return () => {
			cancelled = true;
			stopListening?.();
			window.removeEventListener(
				"fg:push-notification",
				onPushNotification as EventListener,
			);
		};
	}, [navigate]);

	return null;
}