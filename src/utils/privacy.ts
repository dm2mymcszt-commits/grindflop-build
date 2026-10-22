import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { translate } from "./translate";
import { getSetting, setSetting, getMessages } from "../services/chatDb";

// --- PER-CHAT READ RECEIPTS LOGIC ---
// Backed by the active profile's db, kept in an in-memory cache so the
// synchronous getters below (called from hot paths like chatService.ts and
// ChatRealtimeBridge.tsx) don't need to await a db round-trip — mirrors the
// pattern in utils/autoblock.ts.

interface PrivacySettings {
    hideReadReceiptsGlobal: boolean;
    showReadReceiptToggle: boolean;
    recordProfileViews: boolean;
    readReceiptsExceptions: Record<string, boolean>;
    incognitoMode: boolean;
}

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
    hideReadReceiptsGlobal: false,
    showReadReceiptToggle: true,
    recordProfileViews: true,
    readReceiptsExceptions: {},
    incognitoMode: false,
};

const PRIVACY_SETTINGS_KEY = "privacy";

let privacyCache: PrivacySettings = DEFAULT_PRIVACY_SETTINGS;

export async function loadPrivacyCache(): Promise<void> {
    try {
        const stored = await getSetting<Partial<PrivacySettings>>(PRIVACY_SETTINGS_KEY);
        privacyCache = { ...DEFAULT_PRIVACY_SETTINGS, ...stored };
    } catch {
        privacyCache = DEFAULT_PRIVACY_SETTINGS;
    }
}

// localStorage writes don't trigger re-renders in other components, so anything
// that displays read-receipts state (e.g. the chat list) needs to be told to
// recompute when a toggle happens elsewhere (e.g. the chat thread header).
const READ_RECEIPTS_CHANGED_EVENT = "fg-read-receipts-changed";

function notifyReadReceiptsChanged() {
    window.dispatchEvent(new Event(READ_RECEIPTS_CHANGED_EVENT));
}

// Forces the calling component to re-render whenever read-receipts state
// changes anywhere in the app, so cache-derived values stay in sync.
export function useReadReceiptsChanged(): void {
    const [, setVersion] = useState(0);

    useEffect(() => {
        const handler = () => setVersion((v) => v + 1);
        window.addEventListener(READ_RECEIPTS_CHANGED_EVENT, handler);
        return () => window.removeEventListener(READ_RECEIPTS_CHANGED_EVENT, handler);
    }, []);
}

export function isReadReceiptsHidden(conversationId: string): boolean {
    const exception = privacyCache.readReceiptsExceptions[conversationId];
    if (typeof exception === "boolean") {
        return exception;
    }
    return privacyCache.hideReadReceiptsGlobal;
}

/** Optimistic: updates the cache and returns the new state synchronously, persists in the background. */
export function toggleReadReceiptsHidden(conversationId: string): boolean {
    const nextState = !isReadReceiptsHidden(conversationId);
    privacyCache = {
        ...privacyCache,
        readReceiptsExceptions: { ...privacyCache.readReceiptsExceptions, [conversationId]: nextState },
    };
    void setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
    notifyReadReceiptsChanged();
    return nextState;
}

export function getShowReadReceiptToggle(): boolean {
    return privacyCache.showReadReceiptToggle;
}

export function getHideReadReceiptsGlobal(): boolean {
    return privacyCache.hideReadReceiptsGlobal;
}

export async function setHideReadReceiptsGlobal(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, hideReadReceiptsGlobal: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
    notifyReadReceiptsChanged();
}

export async function setShowReadReceiptToggle(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, showReadReceiptToggle: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
}

// --- RECORD PROFILE VIEWS SETTING ---

export function isRecordProfileViewsEnabled(): boolean {
    return privacyCache.recordProfileViews;
}

export async function setRecordProfileViewsEnabled(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, recordProfileViews: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
}

// --- INCOGNITO MODE ---
// While it is on the Grid never asks Grindr for nearby profiles, in front or
// through the background refresh, no read receipt is sent and no profile view
// is reported. The Grid reads it afresh each time it loads, and the switch
// sits on another page, so nothing has to be told when it changes.

export function getIncognitoMode(): boolean {
    return privacyCache.incognitoMode === true;
}

export async function setIncognitoMode(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, incognitoMode: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
}

// --- AUTO-BLOCK WHITELIST LOGIC ---
export function getAutoBlockWhitelist(): { profileId: string; displayName: string; primaryMediaHash?: string | null }[] {
    try {
        const json = window.localStorage.getItem("fg-auto-block-whitelist") || "[]";
        return JSON.parse(json) as { profileId: string; displayName: string; primaryMediaHash?: string | null }[];
    } catch {
        return [];
    }
}

export const AUTO_BLOCK_WHITELIST_UPDATED_EVENT = "fg-auto-block-whitelist-updated";

export function getSentMessagesThreshold(): number {
    if (typeof window === "undefined") return 3;
    const val = parseInt(window.localStorage.getItem("fg-autoblock-skip-after-count") || "3", 10);
    return isNaN(val) || val < 1 ? 3 : val;
}

export function addToAutoBlockWhitelist(profileId: string, displayName: string, primaryMediaHash?: string | null) {
    const list = getAutoBlockWhitelist();
    if (!list.some(x => String(x.profileId) === String(profileId))) {
        list.push({ profileId: String(profileId), displayName, primaryMediaHash });
        window.localStorage.setItem("fg-auto-block-whitelist", JSON.stringify(list));
        if (typeof window !== "undefined") {
            window.dispatchEvent(new Event(AUTO_BLOCK_WHITELIST_UPDATED_EVENT));
        }
    }
}

export function removeFromAutoBlockWhitelist(profileId: string) {
    const list = getAutoBlockWhitelist();
    const filtered = list.filter(x => String(x.profileId) !== String(profileId));
    window.localStorage.setItem("fg-auto-block-whitelist", JSON.stringify(filtered));
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTO_BLOCK_WHITELIST_UPDATED_EVENT));
    }
}

export function isProfileAutoblockWhitelisted(profileId: string): boolean {
    const list = getAutoBlockWhitelist();
    return list.some(x => String(x.profileId) === String(profileId));
}

export async function checkAndAutoWhitelistActiveChat(
    profileId: string,
    conversationId: string,
    displayName?: string,
    primaryMediaHash?: string | null,
    userId?: number | null,
): Promise<boolean> {
    if (!profileId || profileId === "0" || typeof window === "undefined") return false;

    const skipActiveChatsEnabled = window.localStorage.getItem("fg-autoblock-skip-after-two") === "true";
    if (!skipActiveChatsEnabled) return false;

    if (isProfileAutoblockWhitelisted(profileId)) {
        return true;
    }

    const threshold = getSentMessagesThreshold();
    let outgoingCount = 0;

    try {
        const localMsgs = await getMessages(conversationId).catch(() => []);
        if (localMsgs && localMsgs.length > 0) {
            for (const m of localMsgs) {
                if (userId != null && Number(m.senderId) === Number(userId)) {
                    outgoingCount++;
                }
            }
        }
    } catch {}

    if (outgoingCount >= threshold) {
        const name = displayName || `Profile ${profileId}`;
        addToAutoBlockWhitelist(profileId, name, primaryMediaHash);

        toast.success(
            translate("privacy.auto_whitelisted", {
                defaultValue: "Auto-block disabled for {{name}} ({{count}} sent messages - added to whitelist)!",
                name,
                count: outgoingCount,
            }),
            { id: `autowhitelist-${profileId}` },
        );
        return true;
    }

    return false;
}

// --- PER-CHAT GHOST MODE LOGIC ---
export function isChatGhosted(conversationId: string): boolean {
    const globalGhost = window.localStorage.getItem("fg-ghost-mode") === "true";
    const exceptionsStr = window.localStorage.getItem("fg-ghost-exceptions") || "{}";
    
    try {
        const exceptions = JSON.parse(exceptionsStr) as Record<string, boolean>;
        if (typeof exceptions[conversationId] === "boolean") {
            return exceptions[conversationId];
        }
    } catch {}
    
    return globalGhost;
}

export function toggleChatGhost(conversationId: string): boolean {
    const currentState = isChatGhosted(conversationId);
    const exceptionsStr = window.localStorage.getItem("fg-ghost-exceptions") || "{}";
    
    try {
        const exceptions = JSON.parse(exceptionsStr) as Record<string, boolean>;
        exceptions[conversationId] = !currentState;
        window.localStorage.setItem("fg-ghost-exceptions", JSON.stringify(exceptions));
    } catch {
        window.localStorage.setItem("fg-ghost-exceptions", JSON.stringify({ [conversationId]: !currentState }));
    }
    return !currentState;
}
