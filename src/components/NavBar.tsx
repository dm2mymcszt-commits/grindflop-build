import { ChartColumn, Grid as GridIcon, Droplet, Flame, MessageCircle, MapPin, Settings } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useState, useEffect, useRef } from "react";
import { cn } from "../utils/cn";
import { useApiFunctions } from "../hooks/useApiFunctions";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/useAuth";
import { useLongPress } from "../hooks/useLongPress";
import {
    getInterestLastSeen,
    INTEREST_SEEN_EVENT,
    markInterestSeen,
    getInboxLastSeen,
    INBOX_SEEN_EVENT,
    markInboxSeen,
} from "../services/seenStore";
import { CHAT_REALTIME_EVENT } from "./ChatRealtimeBridge";
import { messageSchema, type Message } from "../types/messages";
import type { RealtimeEnvelope } from "../types/chat-realtime";
import { useInterestData } from "../hooks/queries/useInterestQueries";
import {
    GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT,
    type GoogleDriveSyncDataAppliedDetail,
} from "../services/googleDriveSyncRuntime";
import { isStatsEnabled, STATS_SETTINGS_UPDATED_EVENT } from "../services/statsLog";

/**
 * Extracts and validates chat messages from a variety of possible realtime envelope formats.
 * WebSocket events from the API can wrap messages in several ways (e.g., direct payload,
 * nested in a 'message' field, or as an array of 'messages').
 */
function extractMessages(envelope: RealtimeEnvelope): Message[] {
    const candidates: Message[] = [];

    // 1. Try to parse the payload directly as a single message
    const direct = messageSchema.safeParse(envelope.payload);
    if (direct.success) candidates.push(direct.data);

    // 2. Deep-probe common nesting patterns in the envelope structure
    for (const payload of [envelope.payload, envelope.data, envelope]) {
        if (!payload || typeof payload !== "object") continue;
        const record = payload as Record<string, unknown>;

        // Check for single nested message: { message: { ... } }
        if (record.message) {
            const parsed = messageSchema.safeParse(record.message);
            if (parsed.success) candidates.push(parsed.data);
        }

        // Check for multiple messages: { messages: [ { ... }, { ... } ] }
        if (Array.isArray(record.messages)) {
            for (const candidate of record.messages) {
                const parsed = messageSchema.safeParse(candidate);
                if (parsed.success) candidates.push(parsed.data);
            }
        }
    }

    // 3. Deduplicate messages by their unique ID to avoid double-processing
    const seen = new Set<string>();
    return candidates.filter((m) => {
        if (seen.has(m.messageId)) return false;
        seen.add(m.messageId);
        return true;
    });
}

export function NavBar() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const apiFunctions = useApiFunctions();
    const { userId, settingsReady } = useAuth();
    const { data: interestData } = useInterestData();

    const pathRef = useRef(location.pathname);
    // Which conversations are muted, so the realtime handler below can ignore
    // their messages without waiting for the next inbox poll.
    const mutedConversationIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        pathRef.current = location.pathname;
    }, [location.pathname]);

    const [activeTab, setActiveTab] = useState("browse");
    const [interestUnseen, setInterestUnseen] = useState(false);
    const [inboxUnseen, setInboxUnseen] = useState(false);

    // Long-press Popover State
    const [showBrowseMenu, setShowBrowseMenu] = useState(false);
    const isLongPressingRef = useRef(false);

    const browseLongPress = useLongPress(() => {
        isLongPressingRef.current = true;
        if (navigator.vibrate) navigator.vibrate(50);
        setShowBrowseMenu(true);
    }, 400);

    // Read preferences directly from localStorage (defaulting to true if not set)
    const [showRightNow] = useState(() => window.localStorage.getItem("fg-show-right-now") !== "false");
    const [showInterest] = useState(() => window.localStorage.getItem("fg-show-interest") !== "false");
    // Per account and synced, so it can change while the bar is on screen.
    const [showStats, setShowStats] = useState(isStatsEnabled);
    useEffect(() => {
        const sync = () => setShowStats(isStatsEnabled());
        window.addEventListener(STATS_SETTINGS_UPDATED_EVENT, sync);
        return () => window.removeEventListener(STATS_SETTINGS_UPDATED_EVENT, sync);
    }, []);

    const navItems = [
        {
            value: "browse",
            label: t("nav.browse"),
            icon: GridIcon,
            path: "/",
            visible: true, // Mandatory
        },
        {
            value: "right-now",
            label: t("nav.right_now"),
            icon: Droplet,
            path: "/right-now",
            visible: showRightNow, // Toggleable
        },
        {
            value: "interest",
            label: t("nav.interest"),
            icon: Flame,
            path: "/interest",
            visible: showInterest, // Toggleable
        },
        {
            value: "inbox",
            label: t("nav.inbox"),
            icon: MessageCircle,
            path: "/chat",
            visible: true, // Mandatory
        },
    ].filter(item => item.visible);

    // Update active tab based on current path
    useEffect(() => {
        const currentItem = navItems.find(
            (item) =>
                (item.path === "/" &&
                    (location.pathname === "/" ||
                        location.pathname.startsWith("/browse/"))) ||
                location.pathname === item.path ||
                (item.path !== "/" && location.pathname.startsWith(`${item.path}/`)),
        );
        if (currentItem) {
            setActiveTab(currentItem.value);
        }
    }, [location.pathname, navItems]);

    useEffect(() => {
        let cancelled = false;

        const refreshInboxState = async () => {
            if (document.hidden) return;
            const isAtInbox = pathRef.current.startsWith("/chat") || pathRef.current === "/settings/shared-albums";
            try {
                // Fetch the latest inbox summary to sync unread counts and global "seen" state
                const response = await apiFunctions.listConversations({
                    page: 1,
                });

                if (cancelled) return;

                mutedConversationIdsRef.current = new Set(
                    response.entries
                        .filter((entry) => entry.data.muted)
                        .map((entry) => entry.data.conversationId),
                );

                const lastSeen = getInboxLastSeen();
                const newest = response.entries.reduce(
                    (max, entry) => Math.max(max, entry.data.lastActivityTimestamp ?? 0),
                    0,
                );



                if (lastSeen === 0 && newest > 0) {
                    // Initialize "last seen" on first run to avoid showing stale dots
                    window.localStorage.setItem("fg-inbox-last-seen", String(newest));
                }

                // Keeps the "last seen" bookmark current while the user is looking
                // at the inbox, so the dot doesn't reappear immediately when they
                // switch away — unrelated to whether anything is actually unread.
                if (isAtInbox && newest > lastSeen) {
                    markInboxSeen(newest);
                }

                // A conversation only lights up the dot if it's both genuinely
                // unread (server-reported unreadCount, the same signal the inbox
                // rows themselves trust — not just "some activity happened") *and*
                // that activity is newer than the last time the inbox list was
                // actually viewed.
                // A muted conversation never counts, however unread it is.
                const hasUnseenUnread = response.entries.some(
                    (entry) =>
                        !entry.data.muted &&
                        (entry.data.unreadCount ?? 0) > 0 &&
                        (entry.data.lastActivityTimestamp ?? 0) > lastSeen,
                );
                setInboxUnseen(!isAtInbox && hasUnseenUnread);
            } catch {
                if (!cancelled) {

                    setInboxUnseen(false);
                }
            }
        };

        void refreshInboxState();
        // Background safety poll to catch updates from other devices/stale socket
        const intervalId = window.setInterval(refreshInboxState, 60_000);

        const handleRealtime = (event: Event) => {
            const isAtInbox = pathRef.current.startsWith("/chat") || pathRef.current === "/settings/shared-albums";
            // If we are already looking at the inbox, suppress the dot immediately
            if (isAtInbox) {
                setInboxUnseen(false);
                return;
            }

            // Extract messages directly from the realtime event to avoid an expensive API reload.
            // This ensures the notification dot appears instantly with the incoming message.
            const envelope = (event as CustomEvent<RealtimeEnvelope>).detail;
            const messages = extractMessages(envelope);
            if (messages.length > 0) {
                const lastSeen = getInboxLastSeen();
                // Check for messages from other users
                const fromOthers = messages.filter(
                    (m) =>
                        userId != null &&
                        Number(m.senderId) !== Number(userId) &&
                        !mutedConversationIdsRef.current.has(m.conversationId)
                );

                if (fromOthers.length > 0) {
                    const newest = Math.max(...fromOthers.map((m) => m.timestamp));
                    // Show dot if the message is actually newer than our last visit
                    if (newest > lastSeen) {
                        setInboxUnseen(true);

                    }
                }
            }
        };
        const onSeen = () => {
            setInboxUnseen(false);

        };

        const onVisibilityChange = () => {
            if (!document.hidden) {
                void refreshInboxState();
            }
        };
        const onCloudDataApplied = (event: Event) => {
            const detail = (event as CustomEvent<GoogleDriveSyncDataAppliedDetail>).detail;
            if (!settingsReady || userId == null || detail?.profileId !== userId) return;
            void refreshInboxState();
        };

        window.addEventListener(CHAT_REALTIME_EVENT, handleRealtime);
        window.addEventListener(INBOX_SEEN_EVENT, onSeen as EventListener);
        window.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener(GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT, onCloudDataApplied);

        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
            window.removeEventListener(CHAT_REALTIME_EVENT, handleRealtime as EventListener);
            window.removeEventListener(INBOX_SEEN_EVENT, onSeen as EventListener);
            window.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener(GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT, onCloudDataApplied);
        };
    }, [apiFunctions, settingsReady, userId]);

    // Clear the inbox dot immediately when navigating to the chat section or shared albums
    useEffect(() => {
        if (location.pathname.startsWith("/chat") || location.pathname === "/settings/shared-albums") {
            setInboxUnseen(false);
        }
    }, [location.pathname]);

    // Track whether the Interest tab has anything new since the user last
    // looked. Listens for live update events via the useInterestData hook.
    useEffect(() => {
        const refreshInterestUnseen = () => {
            if (!interestData) return;
            const isAtInterest = pathRef.current === "/interest";
            const lastSeen = getInterestLastSeen();

            const newest = Math.max(
                ...(interestData.taps.map(t => t.timestamp || 0)),
                ...(interestData.views.map(v => v.timestamp || 0)),
                0
            );

            // On first run (no stored seen timestamp), treat current state as
            // already seen so we don't show a stale dot.
            if (lastSeen === 0) {
                if (newest > 0) {
                    markInterestSeen(newest);
                }
                setInterestUnseen(false);
                return;
            }

            // If we are currently on the interest page, ensure our "last seen"
            // timestamp is at least as high as the newest item.
            if (isAtInterest && newest > lastSeen) {
                markInterestSeen(newest);
            }

            setInterestUnseen(!isAtInterest && newest > lastSeen);
        };

        refreshInterestUnseen();

        const onSeen = () => setInterestUnseen(false);
        const onCloudDataApplied = (event: Event) => {
            const detail = (event as CustomEvent<GoogleDriveSyncDataAppliedDetail>).detail;
            if (!settingsReady || userId == null || detail?.profileId !== userId) return;
            refreshInterestUnseen();
        };
        window.addEventListener(INTEREST_SEEN_EVENT, onSeen as EventListener);
        window.addEventListener(GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT, onCloudDataApplied);

        return () => {
            window.removeEventListener(INTEREST_SEEN_EVENT, onSeen as EventListener);
            window.removeEventListener(GOOGLE_DRIVE_SYNC_DATA_APPLIED_EVENT, onCloudDataApplied);
        };
    }, [interestData, settingsReady, userId]);

    // Clear the interest dot immediately when navigating to the interest section
    useEffect(() => {
        if (location.pathname === "/interest") {
            setInterestUnseen(false);
        }
    }, [location.pathname]);

    const handleTabChange = (value: string) => {
        if (isLongPressingRef.current) {
            isLongPressingRef.current = false;
            return;
        }
        setActiveTab(value);
        const item = navItems.find((i) => i.value === value);
        if (item) {
            if (value === "browse") {
                // Do not navigate immediately on tab change; let onClick handle it on release (short click)
            } else {
                navigate(item.path);
            }
        }
    };

    // Determine the grid column class safely based on exactly how many tabs remain
    const gridColsClass = 
        navItems.length === 2 ? "grid-cols-2" : 
        navItems.length === 3 ? "grid-cols-3" : 
        "grid-cols-4";

    return (
        <>
            <style>
                {`
                    @keyframes nav-bounce {
                        0% { transform: scale(1); }
                        30% { transform: scale(1.35) translateY(-3px); }
                        50% { transform: scale(0.92); }
                        75% { transform: scale(1.1) translateY(-1px); }
                        100% { transform: scale(1) translateY(0); }
                    }
                    .animate-nav-bounce {
                        animation: nav-bounce 0.45s cubic-bezier(0.25, 1, 0.5, 1) forwards;
                    }
                    .browse-menu-popover {
                        left: 12px;
                        transform: translateY(1rem) scale(0.5);
                    }
                    .browse-menu-popover.show {
                        transform: translateY(0) scale(1);
                    }
                    @media (min-width: 768px) {
                        .browse-menu-popover {
                            left: ${50 / navItems.length}%;
                            transform: translateX(-50%) translateY(1rem) scale(0.5);
                        }
                        .browse-menu-popover.show {
                            transform: translateX(-50%) translateY(0) scale(1);
                        }
                    }
                `}
            </style>

            <nav className="no-touch-callout fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] md:px-4 md:pb-[calc(env(safe-area-inset-bottom,0px)+14px)]">
                
                {/* Structural Fix: A pure relative wrapper. Both Liquid Glass elements are now siblings so their blurs don't break each other. */}
                <div className="relative mx-auto w-full max-w-4xl">
                    
                    {/* Backdrop to close picker on tap outside */}
                    {showBrowseMenu && (
                        <div
                            className="fixed inset-0 z-[55] bg-transparent"
                            onPointerDown={(e) => {
                                e.stopPropagation();
                                setShowBrowseMenu(false);
                            }}
                        />
                    )}

                    {/* 1. Liquid Glass Browse Options Popover (Sibling) */}
                    <div
                        className={cn(
                            "select-none touch-none absolute bottom-[calc(100%+0.8rem)] z-[60] flex items-center gap-2 rounded-full border border-white/10 dark:border-white/5 p-1.5 backdrop-blur-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_inset_0_-1px_0_rgba(0,0,0,0.2),_0_12px_40px_rgba(0,0,0,0.45)] transition-all duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] browse-menu-popover",
                            showBrowseMenu ? "show opacity-100 pointer-events-auto" : "pointer-events-none opacity-0"
                        )}
                        style={{
                            backgroundColor: "rgba(15, 17, 21, 0.45)", // Stronger tint to pop over scrolling feed content
                            background: "color-mix(in srgb, var(--surface) 45%, transparent)"
                        }}
                    >
                        <div
                            className="flex h-[3.2rem] w-[5rem] cursor-pointer items-center justify-center rounded-full text-[var(--text-muted)] transition-all duration-300 hover:scale-105 hover:bg-[var(--accent)] hover:text-white hover:shadow-[0_0_15px_var(--accent)] active:scale-95 md:h-[3.8rem] md:w-[6rem]"
                            title={t("nav.browse_location", "Browse Location")}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowBrowseMenu(false);
                                if (activeTab === "browse") {
                                    window.dispatchEvent(new CustomEvent("open-location"));
                                } else {
                                    navigate('/', { state: { openLocation: true } });
                                }
                            }}
                        >
                            <MapPin className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.8} />
                        </div>

                        {showStats && (
                            <div
                                className="flex h-[3.2rem] w-[5rem] cursor-pointer items-center justify-center rounded-full text-[var(--text-muted)] transition-all duration-300 hover:scale-105 hover:bg-[var(--accent)] hover:text-white hover:shadow-[0_0_15px_var(--accent)] active:scale-95 md:h-[3.8rem] md:w-[6rem]"
                                title={t("nav.stats", "Stats")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowBrowseMenu(false);
                                    navigate('/stats');
                                }}
                            >
                                <ChartColumn className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.8} />
                            </div>
                        )}

                        <div
                            className="flex h-[3.2rem] w-[5rem] cursor-pointer items-center justify-center rounded-full text-[var(--text-muted)] transition-all duration-300 hover:scale-105 hover:bg-[var(--accent)] hover:text-white hover:shadow-[0_0_15px_var(--accent)] active:scale-95 md:h-[3.8rem] md:w-[6rem]"
                            title={t("nav.settings", "Settings")}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowBrowseMenu(false);
                                navigate('/settings');
                            }}
                        >
                            <Settings className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.8} />
                        </div>
                    </div>

                    {/* 2. Main Liquid Glass Navbar Container (Sibling) */}
                    <div
                        className="w-full rounded-full border border-white/10 dark:border-white/5 p-1.5 backdrop-blur-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.15),_inset_0_-1px_0_rgba(0,0,0,0.2),_0_12px_40px_rgba(0,0,0,0.45)] select-none"
                        style={{
                            backgroundColor: "rgba(15, 17, 21, 0.25)",
                            background: "color-mix(in srgb, var(--surface) 25%, transparent)",
                        }}
                    >
                        <Tabs value={activeTab} onValueChange={handleTabChange}>
                            <TabsList className={`grid h-16 w-full ${gridColsClass} bg-transparent p-0 md:h-[4.1rem]`}>
                                {navItems.map((item) => {
                                    const Icon = item.icon;
                                    const isCurrent = activeTab === item.value;
                                    return (
                                        <TabsTrigger
                                            key={item.value}
                                            value={item.value}
                                            {...(item.value === "browse" ? browseLongPress : {})}
                                            onClick={(e) => {
                                                if (item.value === "browse") {
                                                    // If we were long-pressing, cancel the navigation click
                                                    if (isLongPressingRef.current) {
                                                        isLongPressingRef.current = false;
                                                        e.preventDefault();
                                                        // Restore the tab visual selection back to the actual route we are on
                                                        const currentItem = navItems.find(
                                                            (nav) =>
                                                                (nav.path === "/" &&
                                                                    (location.pathname === "/" ||
                                                                        location.pathname.startsWith("/browse/"))) ||
                                                                location.pathname === nav.path ||
                                                                (nav.path !== "/" && location.pathname.startsWith(`${nav.path}/`)),
                                                        );
                                                        if (currentItem) {
                                                            setActiveTab(currentItem.value);
                                                        }
                                                        return;
                                                    }
                                                    // Otherwise, execute normal navigation routing or scroll to top
                                                    const isCurrentlyBrowse = location.pathname === "/" || location.pathname.startsWith("/browse/");
                                                    if (isCurrentlyBrowse) {
                                                        window.scrollTo({ top: 0, behavior: "smooth" });
                                                        window.dispatchEvent(new CustomEvent("browse-scroll-top"));
                                                    } else {
                                                        setActiveTab("browse");
                                                        navigate(item.path);
                                                    }
                                                }
                                            }}
                                            className={cn(
                                                "flex h-full flex-col items-center justify-center gap-1 rounded-full text-[var(--text-muted)] transition-all duration-300 ease-out active:scale-95 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] md:gap-1.5 select-none",
                                                item.value === "right-now"
                                                    ? "focus-visible:ring-[var(--right-now)] data-[state=active]:bg-[var(--right-now)] data-[state=active]:text-white"
                                                    : "focus-visible:ring-[var(--accent)] data-[state=active]:bg-[var(--accent)] data-[state=active]:text-[var(--accent-contrast)]"
                                            )}
                                        >
                                            <div className="relative">
                                                {/* Bouncing Icon Animation */}
                                                <Icon className={cn(
                                                    "h-5 w-5 md:h-[1.2rem] md:w-[1.2rem] transition-all duration-300",
                                                    isCurrent ? "animate-nav-bounce" : ""
                                                )} />
                                                
                                                {(item.value === "inbox" && inboxUnseen) ||
                                                (item.value === "interest" && interestUnseen) ? (
                                                    <span className="absolute -right-1 -top-1 flex h-2 w-2">
                                                        <span
                                                            className={cn(
                                                                "relative inline-block h-2 w-2 rounded-full ring-1 ring-[var(--surface)]",
                                                                activeTab === "right-now"
                                                                    ? "bg-[var(--right-now)]"
                                                                    : "bg-[var(--accent)]",
                                                            )}
                                                        ></span>
                                                    </span>
                                                ) : null}
                                            </div>
                                            <span className="text-xs md:text-[0.8rem]">
                                                {item.label}
                                            </span>
                                        </TabsTrigger>
                                    );
                                })}
                            </TabsList>
                        </Tabs>
                    </div>
                </div>
            </nav>
        </>
    );
}
