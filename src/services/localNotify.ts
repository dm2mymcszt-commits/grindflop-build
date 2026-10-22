/**
 * localNotify.ts — fire native OS notifications instantly from the chat
 * WebSocket while the app is in the foreground, instead of waiting on FCM's
 * delivery delay.
 *
 * Android is intentionally excluded; it has its own native notification
 * pipeline (FreeGrindFirebaseMessagingService / NotificationPoster) reached
 * via the FreeGrindBridge JS interface, which dedupes against the FCM path.
 * Desktop and iOS have no competing push channel, so this is a plain
 * fire-and-forget call.
 */

import {
	active,
	isPermissionGranted,
	removeActive,
	requestPermission,
	sendNotification,
} from "@tauri-apps/plugin-notification";
import { platform } from "@tauri-apps/plugin-os";
import { isTauriRuntime } from "./tauriWebSocket";
import { appLog } from "../utils/logger";
import { traceNotification } from "../utils/backgroundTrace";
import { isChatNotificationsEnabled, isTapNotificationsEnabled } from "../utils/notificationSettings";
import { TAPS_NOTIFICATION_GROUP } from "../utils/notificationClick";
import { getThumbImageUrl, validateMediaHash } from "../utils/media";
import { isExplicitProfilePhoto } from "./explicitProfilePhotos";

// Matches the Linux .desktop entry's `Icon=`/`StartupWMClass=` value (the
// main binary name, not the bundle `identifier`) — confirmed against the
// installed /usr/share/applications/Free Grind.desktop. Passing this as the
// notification icon lets the icon theme resolve it once the app is properly
// installed with icons bundled (see tauri.conf.json `bundle.icon`).
const APP_ICON_NAME = "free-grind";

let permissionPromise: Promise<boolean> | null = null;
let cachedIsSupported: boolean | null = null;

function detectLocalNotifySupported(): boolean {
	if (cachedIsSupported != null) return cachedIsSupported;
	if (!isTauriRuntime()) {
		cachedIsSupported = false;
		return false;
	}
	try {
		const p = platform();
		cachedIsSupported = p === "macos" || p === "windows" || p === "linux" || p === "ios";
	} catch (error) {
		appLog.warn("[notify] platform() failed", error);
		cachedIsSupported = false;
	}
	return cachedIsSupported;
}

async function ensurePermission(): Promise<boolean> {
	if (!permissionPromise) {
		permissionPromise = (async () => {
			try {
				const already = await isPermissionGranted();
				appLog.debug("[notify] isPermissionGranted ->", already);
				if (already) return true;
				appLog.debug("[notify] requesting permission");
				const result = await requestPermission();
				appLog.debug("[notify] requestPermission ->", result);
				return result === "granted";
			} catch (error) {
				appLog.warn("[notify] permission check failed", error);
				return false;
			}
		})();
	}
	return permissionPromise;
}

/**
 * Trigger the OS permission prompt eagerly so the user sees it on app start
 * rather than waiting for the first incoming message. Safe to call repeatedly;
 * only prompts once per app session.
 */
export async function primeLocalNotifications(): Promise<boolean> {
	if (!detectLocalNotifySupported()) {
		appLog.debug("[notify] prime skipped (not supported)");
		return false;
	}
	appLog.debug("[notify] priming permission");
	return ensurePermission();
}

export interface LocalNotifyOptions {
	title: string;
	body: string;
	/** Conversation/thread grouping key (e.g. conversationId, or "taps"). */
	group?: string;
	/** When true, skip the notification (e.g. user is viewing the conversation). */
	suppress?: boolean;
	/** Who it is from, so iOS can show their photo on it. */
	sender?: NotificationSender;
}

export interface NotificationSender {
	id: string;
	name: string;
	photoHash?: string | null;
	/** What iOS groups this person's notifications under. */
	conversationId: string;
}

/**
 * The sender as the patched notification plugin reads it on iOS, in `extra`
 * (strings only): their photo goes on the notification, the way Messages
 * shows one. Nothing when there is no photo, or it is one the explicit
 * filter hides, which must not turn up on the lock screen either.
 */
function senderExtra(sender: NotificationSender | undefined): Record<string, string> | null {
	const hash = sender?.photoHash?.trim();
	if (!sender || !hash || !validateMediaHash(hash) || isExplicitProfilePhoto(hash)) return null;
	return {
		fgSenderId: sender.id,
		fgSenderName: sender.name,
		fgConversationId: sender.conversationId,
		fgAvatarUrl: getThumbImageUrl(hash),
	};
}

export async function notifyLocal(options: LocalNotifyOptions): Promise<void> {
	if (options.suppress) {
		traceNotification("suppressed");
		appLog.debug("[notify] suppressed", options.title);
		return;
	}

	// Check user preferences
	if (options.group === "taps") {
		if (!isTapNotificationsEnabled()) {
			traceNotification("tap notifications off");
			appLog.debug("[notify] suppressed: taps notifications disabled by user settings");
			return;
		}
	} else {
		if (!isChatNotificationsEnabled()) {
			traceNotification("chat notifications off");
			appLog.debug("[notify] suppressed: chats notifications disabled by user settings");
			return;
		}
	}

	if (!detectLocalNotifySupported()) {
		traceNotification("unsupported");
		return;
	}
	const granted = await ensurePermission();
	if (!granted) {
		traceNotification("no permission");
		appLog.debug("[notify] permission not granted, skipping");
		return;
	}
	try {
		appLog.debug("[notify] sending", options.title);
		const p = platform();
		const params: any = {
			title: options.title,
			body: options.body,
		};
		if (p === "linux") {
			params.icon = APP_ICON_NAME;
		}
		// On Windows the group is what a click reports back, and what a read
		// conversation's notifications are found by.
		if (p === "macos" || p === "ios" || p === "windows") {
			params.group = options.group;
		}
		if (p === "ios") {
			const extra = senderExtra(options.sender);
			if (extra) params.extra = extra;
		}
		const result = sendNotification(params) as any;
		traceNotification("sent");
		if (result && typeof result.catch === "function") {
			result.catch((error: any) => {
				traceNotification("rejected");
				appLog.warn("[notify] sendNotification promise rejected", error);
			});
		}
	} catch (error) {
		traceNotification("failed");
		appLog.warn("[notify] sendNotification failed", error);
	}
}

// Notifications can be found again and taken down on Windows only, where
// the Rust side keeps track of them. The phone builds are left as they were.
function canTakeDownNotifications(): boolean {
	if (!detectLocalNotifySupported()) return false;
	try {
		return platform() === "windows";
	} catch {
		return false;
	}
}

async function takeDownGroup(group: string): Promise<void> {
	if (!group || !canTakeDownNotifications()) return;
	try {
		const shown = await active();
		const ofGroup = shown.filter((notification) => notification.group === group);
		if (ofGroup.length === 0) return;
		await removeActive(ofGroup.map((notification) => ({ id: notification.id, tag: notification.tag })));
	} catch (error) {
		appLog.warn("[notify] taking notifications down failed", error);
	}
}

/**
 * Takes down the notifications a conversation has raised, once it has been
 * read, instead of leaving them in the notification centre for good.
 */
export async function clearChatNotifications(conversationId: string | null | undefined): Promise<void> {
	if (!conversationId) return;
	await takeDownGroup(conversationId);
}

/** Takes down the tap notifications, once the taps are on screen. */
export async function clearTapNotifications(): Promise<void> {
	await takeDownGroup(TAPS_NOTIFICATION_GROUP);
}
