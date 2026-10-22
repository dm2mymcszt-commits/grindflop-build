import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/ibm-plex-sans/index.css";
import App from "./App";
import ManagerApp from "./ManagerApp";
import "./i18n";
import { initChatContactIndex } from "./services/chatContactIndex";
import { initChatDb } from "./services/chatDb";
import { isTauri } from "@tauri-apps/api/core";
import { appLog } from "./utils/logger";
import { DEFAULT_GC_TIME_MS } from "./config/ui-constants";
import { CrashBoundary } from "./components/CrashBoundary";
import { AppToaster } from "./components/AppToaster";
import { installGlobalCrashHandlers } from "./utils/crashOverlay";
import { installNativeKeyboardFocusReveal } from "./utils/nativeKeyboard";
import { installEmojiStyle } from "./utils/emojiStyle";
import { installFileDropGuard } from "./utils/fileDropGuard";
import { ScreenshotBadge } from "./components/ScreenshotBadge";
import { getRuntimeContext } from "./services/runtimeContext";
import "./index.css";

installGlobalCrashHandlers();
installNativeKeyboardFocusReveal();
installEmojiStyle();
installFileDropGuard();

// The iOS restart diagnostics are gone; drop the logs they kept, which ran to
// hundreds of kilobytes of the storage every page load reads.
for (const key of ["fg-diag-state", "fg-diag-restarts", "fg-diag-blocks", "fg-diag-hud", "fg-diag-safe-mode-until"]) {
	try {
		window.localStorage.removeItem(key);
	} catch {
		// Nothing to drop.
	}
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 0, // Data is immediately considered stale (refetch on mount)
			gcTime: DEFAULT_GC_TIME_MS,
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
});

void (async () => {
	const runtimeContext = await getRuntimeContext();
	const renderManager =
		runtimeContext.mode === "manager" || runtimeContext.instanceLabel === "manager";

	if (!renderManager) {
		if (isTauri()) {
			void initChatContactIndex().catch((err) => {
				appLog.warn("[chat-index] failed to initialize:", err);
			});
			void initChatDb().catch((err) => {
				appLog.warn("[chat-db] failed to initialize:", err);
			});
		}
	}

	ReactDOM.createRoot(document.getElementById("app")!).render(
		<React.StrictMode>
			<CrashBoundary>
				<QueryClientProvider client={queryClient}>
					<BrowserRouter>
						{renderManager ? (
							<ManagerApp currentLabel={runtimeContext.instanceLabel} />
						) : (
							<App />
						)}
						<AppToaster />
						<ScreenshotBadge />
					</BrowserRouter>
				</QueryClientProvider>
			</CrashBoundary>
		</React.StrictMode>,
	);
})();