import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AccountStatusGate } from "../components/AccountStatusPrompt";
import { TitleBar } from "../components/ui/title-bar";

export function RootLayout() {
	const location = useLocation();
	const navigate = useNavigate();
	const isRightNow = location.pathname === "/right-now";

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (e.defaultPrevented) return;

				// Don't navigate back if the user is typing in an input
				const isInput =
					e.target instanceof HTMLInputElement ||
					e.target instanceof HTMLTextAreaElement ||
					(e.target as HTMLElement)?.isContentEditable;

				if (isInput) return;

				// Navigate back
				navigate(-1);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [navigate]);

	return (
		<div
			className="app-shell"
			style={{ "--app-accent-gradient": isRightNow ? "var(--right-now)" : "var(--accent)" } as React.CSSProperties}
		>
			<TitleBar />
			{/* Two full-window layers used to sit here: a 100px backdrop blur and a
			    1%-opacity noise texture in mix-blend-overlay. Neither showed over the
			    app's opaque background, but both made the compositor redraw the
			    whole window whenever anything on screen moved, keeping the GPU busy
			    on an idle screen. */}
			{/* The smooth-scroll driver measures this element to know how far the
			    page can scroll, so it has to be one stable node that lives for the
			    whole session rather than whatever route happens to be mounted. */}
			<div id="app-scroll-content">
				<Outlet />
			</div>
			{/* Inside the shell on purpose: the title bar above stays on top of
			    it, so the window can still be moved and closed while it is up. */}
			<AccountStatusGate />
		</div>
	);
}
