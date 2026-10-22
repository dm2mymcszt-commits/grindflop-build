import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "@tauri-apps/plugin-os";
import { isTauriRuntime } from "../services/tauriWebSocket";
import { getNativeBridge } from "../utils/nativeBridge";
import logo from "../images/freegrind-logo.webp";

function isIos(): boolean {
	if (!isTauriRuntime()) return false;
	try {
		return platform() === "ios";
	} catch {
		return false;
	}
}

/** The accent as RGB channels, whatever notation the theme wrote it in. */
function readAccent(): [number, number, number] | null {
	const probe = document.createElement("span");
	probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;color:var(--accent)";
	document.body.appendChild(probe);
	const color = window.getComputedStyle(probe).color;
	probe.remove();
	const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
	return channels && channels.length === 3 && channels.every(Number.isFinite)
		? (channels as [number, number, number])
		: null;
}

/**
 * A small GrindFlop pill drawn where the notch or Dynamic Island sits. On the
 * phone the hardware covers it, so it is invisible in use, but screenshots
 * capture those pixels and show it — the same trick Swiftgram uses.
 *
 * Builds with the native half (ScreenshotBadge.swift) draw it natively: Liquid
 * Glass tinted with the accent, and hidden the moment the app resigns, which
 * the page itself cannot manage before the app switcher takes its picture.
 * This component then only tells the native side the accent. Builds without
 * it fall back to a pill drawn by the page.
 */
export function ScreenshotBadge() {
	const [enabled] = useState(isIos);
	const [nativeBridge, setNativeBridge] = useState(() => (enabled ? getNativeBridge() : null));
	const [active, setActive] = useState(() => document.visibilityState === "visible");

	// On a cold start the native side can register its handler a moment after
	// the page has mounted.
	useEffect(() => {
		if (!enabled || nativeBridge) return;
		const timers = [300, 1000, 3000].map((delay) =>
			window.setTimeout(() => {
				const bridge = getNativeBridge();
				if (bridge) setNativeBridge(bridge);
			}, delay),
		);
		return () => timers.forEach((timer) => window.clearTimeout(timer));
	}, [enabled, nativeBridge]);

	useEffect(() => {
		if (!nativeBridge) return;
		let lastAccent: string | null = null;
		const post = (visible: boolean) => {
			try {
				nativeBridge.postMessage({ type: "badge", visible, accent: readAccent() });
			} catch {
				// Nothing to draw it with.
			}
		};
		const postIfAccentChanged = () => {
			const accent = window.getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
			if (accent === lastAccent) return;
			lastAccent = accent;
			post(true);
		};
		postIfAccentChanged();
		// The accent is a custom property on <html>; a theme change rewrites it.
		const observer = new MutationObserver(postIfAccentChanged);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
		return () => {
			observer.disconnect();
			post(false);
		};
	}, [nativeBridge]);

	useEffect(() => {
		if (!enabled || nativeBridge) return;
		const show = () => setActive(document.visibilityState === "visible");
		const hide = () => setActive(false);
		const onVisibility = () => (document.visibilityState === "visible" ? show() : hide());
		window.addEventListener("focus", show);
		window.addEventListener("blur", hide);
		window.addEventListener("pagehide", hide);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", show);
			window.removeEventListener("blur", hide);
			window.removeEventListener("pagehide", hide);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [enabled, nativeBridge]);

	if (!enabled || nativeBridge || !active) return null;

	return createPortal(
		<div
			aria-hidden="true"
			style={{
				position: "fixed",
				// Inside the notch (safe area 44–47) or the Dynamic Island (59).
				top: "max(calc(env(safe-area-inset-top, 0px) - 43px), 2px)",
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 2147483645,
				pointerEvents: "none",
				background:
					"linear-gradient(to bottom, rgb(255 255 255 / 0.38), rgb(255 255 255 / 0) 70%), color-mix(in srgb, var(--accent) 42%, transparent)",
				backdropFilter: "blur(12px) saturate(180%)",
				WebkitBackdropFilter: "blur(12px) saturate(180%)",
				boxShadow: "inset 0 0 0 0.5px rgb(255 255 255 / 0.35), 0 2px 8px rgb(0 0 0 / 0.25)",
			}}
			className="flex h-[24px] items-center gap-1 rounded-full px-2.5 text-[10px] font-black uppercase tracking-wide text-white"
		>
			<img src={logo} alt="" className="h-3.5 w-3.5 rounded-full" />
			GrindFlop
		</div>,
		document.body,
	);
}
