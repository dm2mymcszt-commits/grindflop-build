import { useEffect, useRef, ReactNode } from "react";
import Lenis from "lenis";
import { useLocation } from "react-router-dom";
import { SMOOTH_SCROLL_CONFIG } from "../config/scroll-config";

type SmoothScrollProps = {
	children: ReactNode;
	enabled?: boolean;
	smoothTouch?: boolean;
	duration?: number;
	wheelMultiplier?: number;
	touchMultiplier?: number;
	lerp?: number;
	disableOnTouch?: boolean;
	idleFramesBeforeStop?: number;
};

/**
 * Touch-first devices already scroll well natively, and Lenis has no wheel
 * input to smooth on them while `smoothTouch` is off.
 */
function prefersNativeScroll() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

function dropLenisClasses() {
	document.documentElement.classList.remove("lenis", "lenis-smooth", "lenis-scrolling");
}

/**
 * SmoothScroll component using Lenis.
 */
export function SmoothScroll({
	children,
	enabled = SMOOTH_SCROLL_CONFIG.enabled,
	smoothTouch = SMOOTH_SCROLL_CONFIG.smoothTouch,
	duration = SMOOTH_SCROLL_CONFIG.duration,
	wheelMultiplier = SMOOTH_SCROLL_CONFIG.wheelMultiplier,
	touchMultiplier = SMOOTH_SCROLL_CONFIG.touchMultiplier,
	lerp = SMOOTH_SCROLL_CONFIG.lerp,
	disableOnTouch = SMOOTH_SCROLL_CONFIG.disableOnTouch,
	idleFramesBeforeStop = SMOOTH_SCROLL_CONFIG.idleFramesBeforeStop,
}: SmoothScrollProps) {
	const lenisRef = useRef<Lenis | null>(null);
	const wakeRef = useRef<(() => void) | null>(null);
	const location = useLocation();

	const active = enabled && !(disableOnTouch && prefersNativeScroll());

	useEffect(() => {
		if (!active) {
			if (lenisRef.current) {
				lenisRef.current.destroy();
				lenisRef.current = null;
				dropLenisClasses();
			}
			return;
		}

		// Find the scrollable container. On PC with has-titlebar, it's .app-shell.
		// Otherwise, we let it default to window.
		const wrapper = document.documentElement.classList.contains("has-titlebar")
			? (document.querySelector(".app-shell") as HTMLElement | null)
			: window;

		// Resolved once, so it must not be whichever element happened to be the
		// last child at startup (a login or loading screen): that node is
		// replaced later and its height stops tracking the real page.
		const content = document.documentElement.classList.contains("has-titlebar")
			? ((document.getElementById("app-scroll-content")
					?? document.querySelector(".app-shell > div:last-child")) as HTMLElement | null)
			: document.documentElement;

		// Initialize Lenis
		const lenis = new Lenis({
			wrapper: wrapper || window,
			content: content || document.documentElement,
			duration: duration,
			lerp: lerp,
			easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
			orientation: "vertical",
			gestureOrientation: "vertical",
			smoothWheel: true,
			wheelMultiplier: wheelMultiplier,
			touchMultiplier: touchMultiplier,
			smoothTouch: smoothTouch,
			autoResize: true,
		} as any);

		lenisRef.current = lenis;
		(window as any).lenis = lenis;

		// Add Lenis classes to HTML element
		document.documentElement.classList.add("lenis");
		document.documentElement.classList.add("lenis-smooth");

		// Lenis only has work to do while a scroll is in flight. Running the loop
		// unconditionally wakes the compositor 60 times a second on a screen
		// nobody is touching, so park it once the scroll settles and let input
		// start it again.
		let rafId: number | null = null;
		let idleFrames = 0;

		const pump = (time: number) => {
			lenis.raf(time);
			idleFrames = lenis.isScrolling ? 0 : idleFrames + 1;
			if (idleFrames > idleFramesBeforeStop) {
				rafId = null;
				return;
			}
			rafId = requestAnimationFrame(pump);
		};

		const wake = () => {
			idleFrames = 0;
			if (rafId === null) {
				rafId = requestAnimationFrame(pump);
			}
		};

		wakeRef.current = wake;

		const wakeEvents = ["wheel", "touchstart", "pointerdown", "keydown", "resize"] as const;
		for (const type of wakeEvents) {
			window.addEventListener(type, wake, { passive: true });
		}
		lenis.on("scroll", wake);

		wake();

		// Lenis caches how tall the content is. Anything that grows the page
		// without a resize or a route change — expanding a settings section, a
		// list that just loaded — leaves that cache short, and the page then
		// refuses to scroll past the old height.
		const contentObserver =
			content instanceof HTMLElement && typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => {
						lenis.resize();
						wake();
					})
				: null;
		if (content instanceof HTMLElement) {
			contentObserver?.observe(content);
		}

		// Ensure initial size is correct
		const sizeTimer = setTimeout(() => {
			lenis.resize();
			wake();
		}, 100);

		return () => {
			clearTimeout(sizeTimer);
			contentObserver?.disconnect();
			for (const type of wakeEvents) {
				window.removeEventListener(type, wake);
			}
			lenis.off("scroll", wake);
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			wakeRef.current = null;
			lenis.destroy();
			lenisRef.current = null;
			delete (window as any).lenis;
			dropLenisClasses();
		};
	}, [
		active,
		smoothTouch,
		duration,
		wheelMultiplier,
		touchMultiplier,
		lerp,
		idleFramesBeforeStop,
	]);

	// Global scroll-to-top on route change
	useEffect(() => {
		if (lenisRef.current && active) {
			const pagesWithoutTopReset = ["/", "/chat"];
			if (!pagesWithoutTopReset.includes(location.pathname)) {
				lenisRef.current.scrollTo(0, { immediate: true });
				wakeRef.current?.();
			}

			// Small delay to ensure DOM is rendered before resizing
			const timer = setTimeout(() => {
				lenisRef.current?.resize();
				wakeRef.current?.();
			}, 150);
			return () => clearTimeout(timer);
		}
	}, [location.pathname, active]);

	return (
		<>
			{active && (
				<style dangerouslySetInnerHTML={{ __html: `
					html.lenis, html.lenis body {
						height: auto;
					}
					.lenis.lenis-smooth {
						scroll-behavior: auto !important;
					}
					.lenis.lenis-smooth [data-lenis-prevent] {
						overscroll-behavior: contain;
					}
					.lenis.lenis-stopped {
						overflow: hidden;
					}
					.lenis.lenis-scrolling iframe {
						pointer-events: none;
					}
				`}} />
			)}
			{children}
		</>
	);
}
