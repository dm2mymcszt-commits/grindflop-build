import { Outlet, useLocation } from "react-router-dom";
import { NavBar } from "../components/NavBar";
import { BackgroundViewScanner } from "../components/BackgroundViewScanner";
import { BackgroundInboxScanner } from "../components/BackgroundInboxScanner";
import { BlockListImportRunner } from "../components/BlockListImportRunner";
import { useDesktopBreakpoint } from "../hooks/useDesktopBreakpoint";

export function ProtectedLayout() {
    const location = useLocation();
    const isDesktop = useDesktopBreakpoint();

    const isChatConversationRoute =
        (/^\/chat\/[^/]+$/.test(location.pathname) && location.pathname !== "/chat/albums") ||
        (location.pathname === "/chat" && new URLSearchParams(location.search).has("targetProfileId"));
	const isProfileRoute = /^\/profile\/[^/]+$/.test(location.pathname);

    // Hide navbar on mobile/tablet for full-screen chat or profile pages.
    const shouldHideNavbar = (isChatConversationRoute || isProfileRoute) && !isDesktop;

    return (
        <div className="relative">
            {/* Silently caches incoming views every 60s to bypass paywalls later */}
            <BackgroundViewScanner />
            
            {/* Scans incoming unread chats to automatically apply block rules */}
            <BackgroundInboxScanner />

            {/* Keeps a block list import going, a few blocks a minute, on every page */}
            <BlockListImportRunner />
			
            <div className="app-page-container">
                <Outlet />
            </div>
            {!shouldHideNavbar ? <NavBar /> : null}
        </div>
    );
}
