import React, { forwardRef, useCallback, useEffect, useRef } from "react";
import Lenis from "lenis";
import { cn } from "../../utils/cn";
import { FEED_HEADER_OFFSET, FEED_MASK_GRADIENT_STOP } from "../../config/design-config";
import { useDesktopBreakpoint } from "../../hooks/useDesktopBreakpoint";
import { SMOOTH_SCROLL_CONFIG } from "../../config/scroll-config";

interface FeedScrollContainerProps extends React.HTMLAttributes<HTMLDivElement> {
	children: React.ReactNode;
}

export const FeedScrollContainer = forwardRef<HTMLDivElement, FeedScrollContainerProps>(
	({ children, className, ...props }, ref) => {
		const isDesktop = useDesktopBreakpoint();
		const innerRef = useRef<HTMLDivElement | null>(null);

		// Kept the same from one render to the next. An inline ref callback is a
		// new function every render, and React answers that by calling the old
		// one with null and the new one with the node, on every single render.
		// Whatever reads the forwarded ref in between, such as the grid's
		// windowing looking for its scroll element, finds nothing there.
		const setRefs = useCallback(
			(node: HTMLDivElement | null) => {
				innerRef.current = node;
				if (typeof ref === "function") {
					ref(node);
				} else if (ref) {
					ref.current = node;
				}
			},
			[ref],
		);

		useEffect(() => {
			if (!isDesktop || !innerRef.current || !SMOOTH_SCROLL_CONFIG.enabled) {
				console.log("[FeedScroll] Skipping init:", { isDesktop, hasRef: !!innerRef.current, enabled: SMOOTH_SCROLL_CONFIG.enabled });
				return;
			}

			console.log("[FeedScroll] Initializing inner Lenis", {
				lerp: SMOOTH_SCROLL_CONFIG.lerp,
				multiplier: SMOOTH_SCROLL_CONFIG.wheelMultiplier
			});

			const lenis = new Lenis({
				wrapper: innerRef.current,
				content: innerRef.current.firstElementChild as HTMLElement,
				lerp: SMOOTH_SCROLL_CONFIG.lerp,
				duration: SMOOTH_SCROLL_CONFIG.duration,
				wheelMultiplier: SMOOTH_SCROLL_CONFIG.wheelMultiplier,
				touchMultiplier: SMOOTH_SCROLL_CONFIG.touchMultiplier,
				smoothWheel: true,
			});

			// Same fix as SmoothScroll: only pump frames while this feed is
			// actually moving. Left running, the loop keeps the compositor awake
			// on an idle screen — and the grid and interest feeds each own one.
			const wrapper = innerRef.current;
			let rafId: number | null = null;
			let idleFrames = 0;

			const pump = (time: number) => {
				lenis.raf(time);
				idleFrames = lenis.isScrolling ? 0 : idleFrames + 1;
				if (idleFrames > SMOOTH_SCROLL_CONFIG.idleFramesBeforeStop) {
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

			const localEvents = ["wheel", "pointerdown", "touchstart"] as const;
			for (const type of localEvents) {
				wrapper.addEventListener(type, wake, { passive: true });
			}
			window.addEventListener("keydown", wake);
			window.addEventListener("resize", wake);
			lenis.on("scroll", wake);
			wake();

			return () => {
				for (const type of localEvents) {
					wrapper.removeEventListener(type, wake);
				}
				window.removeEventListener("keydown", wake);
				window.removeEventListener("resize", wake);
				lenis.off("scroll", wake);
				if (rafId !== null) {
					cancelAnimationFrame(rafId);
				}
				lenis.destroy();
			};
		}, [isDesktop]);

		return (
			<div
				className="relative flex-1 min-h-0"
				style={{ marginTop: `-${FEED_HEADER_OFFSET}` }}
			>
				<div
					ref={setRefs}
					data-lenis-prevent
					className={cn("h-full overflow-y-auto", className)}
					style={{
						paddingTop: FEED_HEADER_OFFSET,
						maskImage: `linear-gradient(to bottom, transparent, black ${FEED_MASK_GRADIENT_STOP})`,
						WebkitMaskImage: `linear-gradient(to bottom, transparent, black ${FEED_MASK_GRADIENT_STOP})`,
					}}
					{...props}
				>
					<div>
						{children}
					</div>
				</div>
			</div>
		);
	}
);

FeedScrollContainer.displayName = "FeedScrollContainer";
