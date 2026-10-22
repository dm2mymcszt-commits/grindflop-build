import { ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, RotateCcw, ScanSearch, X, ZoomIn, ZoomOut } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { useDesktopBreakpoint } from "../hooks/useDesktopBreakpoint";
import { saveMediaToDevice } from "../services/saveMedia";
import { openExternal, resolveReverseSearchLinks, type ReverseSearchLinks } from "../services/reverseImageSearch";
import { getNativeKeyboardHeight, NATIVE_KEYBOARD_EVENT } from "../utils/nativeKeyboard";
import { appLog } from "../utils/logger";

export type PhotoViewerMedia = {
	url: string;
	type: "image" | "video";
	alt?: string;
};

export type PhotoViewerProps = {
	isOpen: boolean;
	onClose: () => void;
	photos: (string | PhotoViewerMedia)[];
	initialIndex?: number;
	onIndexChange?: (index: number) => void;
	renderExtraInfo?: (index: number) => React.ReactNode;
	/** Full-width bar anchored to the bottom (e.g. a reply/react bar); return null for media that has none. */
	renderFooter?: (index: number) => React.ReactNode;
	/** Chat conversation this media belongs to, if any — saved media is filed under a matching device subfolder instead of a flat Downloads folder. */
	conversationId?: string | null;
};

function getMediaInfo(photo?: string | PhotoViewerMedia | null) {
	if (!photo) return { url: "", type: "image" as const, alt: "" };
	if (typeof photo === "string") return { url: photo, type: "image" as const, alt: "" };
	return { url: photo.url || "", type: photo.type || "image", alt: photo.alt ?? "" };
}

type Zoom = { scale: number; x: number; y: number };
const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 280;
/** How far a finger may drift and still count as a tap. */
const TAP_SLOP = 10;
/** How far a photo must be dragged up or down to close the viewer. */
const DISMISS_DISTANCE = 110;
const ZOOM_TRANSITION = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
/** Black space between two photos while swiping from one to the next. */
const SLIDE_GAP = 24;

type Gesture = {
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	moved: boolean;
	/** undecided until the finger has moved: native swipe between photos, drag to close, pan a zoomed photo, pinch, or nothing. */
	mode: "undecided" | "swipe" | "dismiss" | "pan" | "pinch" | "ignore";
	pinchDistance: number;
};

const GLASS_BUTTON =
	"inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/30 text-white ring-1 ring-inset ring-white/15 backdrop-blur-xl transition hover:bg-black/45 active:scale-95 disabled:opacity-50";

function ViewerButton({
	label,
	onPress,
	disabled,
	className = "",
	children,
}: {
	label: string;
	onPress: () => void;
	disabled?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={(event) => {
				event.stopPropagation();
				onPress();
			}}
			className={`${GLASS_BUTTON} ${className}`}
		>
			{children}
		</button>
	);
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

/**
 * Full-screen photos and videos. Swiping between them is the browser's own
 * snap scrolling, so a swipe can never be left halfway the way a hand-driven
 * carousel can; pinch, double-tap, drag-to-close and taps are handled on top.
 */
export function PhotoViewer({
	isOpen,
	onClose,
	photos,
	initialIndex = 0,
	onIndexChange,
	renderExtraInfo,
	renderFooter,
	conversationId,
}: PhotoViewerProps) {
	const { t } = useTranslation();
	const isDesktop = useDesktopBreakpoint();
	const N = photos.length;

	const [index, setIndex] = useState(initialIndex);
	const [chromeHidden, setChromeHidden] = useState(false);
	const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
	const [zoomAnimated, setZoomAnimated] = useState(false);
	const [dismissY, setDismissY] = useState(0);
	const [isDismissDragging, setIsDismissDragging] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isSearching, setIsSearching] = useState(false);
	const [searchMenu, setSearchMenu] = useState<ReverseSearchLinks | null>(null);
	const [keyboardOpen, setKeyboardOpen] = useState(() => (getNativeKeyboardHeight() ?? 0) > 0);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const mediaRef = useRef<HTMLImageElement | null>(null);
	const indexRef = useRef(index);
	const widthRef = useRef(0);
	const zoomRef = useRef<Zoom>(NO_ZOOM);
	const gestureRef = useRef<Gesture | null>(null);
	const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
	const singleTapTimerRef = useRef<number | null>(null);
	const mouseDragRef = useRef<{ x: number; y: number } | null>(null);
	// Search links per image, so asking again does not upload again.
	const searchCacheRef = useRef(new Map<string, ReverseSearchLinks>());
	const onIndexChangeRef = useRef(onIndexChange);
	useEffect(() => {
		onIndexChangeRef.current = onIndexChange;
	}, [onIndexChange]);

	const updateZoom = useCallback((next: Zoom) => {
		zoomRef.current = next;
		setZoom(next);
	}, []);

	const current = getMediaInfo(photos[index]);

	// Opening: start on the requested photo, with everything reset.
	useLayoutEffect(() => {
		if (!isOpen) return;
		const start = clamp(initialIndex, 0, Math.max(0, N - 1));
		indexRef.current = start;
		setIndex(start);
		updateZoom(NO_ZOOM);
		setDismissY(0);
		setChromeHidden(false);
		setSearchMenu(null);
		const scroller = scrollerRef.current;
		if (scroller) {
			widthRef.current = scroller.clientWidth;
			scroller.scrollLeft = start * scroller.clientWidth;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen]);

	useEffect(() => {
		if (isOpen) onIndexChangeRef.current?.(index);
	}, [index, isOpen]);

	// A list that shrinks while open keeps a valid photo on screen.
	useEffect(() => {
		if (!isOpen || N === 0 || index < N) return;
		const last = N - 1;
		indexRef.current = last;
		setIndex(last);
		const scroller = scrollerRef.current;
		if (scroller) scroller.scrollLeft = last * scroller.clientWidth;
	}, [N, index, isOpen]);

	// Rotation or a resized window: stay on the same photo.
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!isOpen || !scroller) return;
		const observer = new ResizeObserver(() => {
			if (scroller.clientWidth === widthRef.current) return;
			widthRef.current = scroller.clientWidth;
			scroller.scrollLeft = indexRef.current * scroller.clientWidth;
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [isOpen]);

	useEffect(() => {
		const onKeyboard = (event: Event) => {
			const height = (event as CustomEvent<{ height?: number }>).detail?.height;
			setKeyboardOpen(typeof height === "number" && height > 0);
		};
		window.addEventListener(NATIVE_KEYBOARD_EVENT, onKeyboard);
		return () => window.removeEventListener(NATIVE_KEYBOARD_EVENT, onKeyboard);
	}, []);

	// Only the photo on screen plays.
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!isOpen || !scroller) return;
		scroller.querySelectorAll<HTMLVideoElement>("video[data-slide]").forEach((video) => {
			if (Number(video.dataset.slide) === index) {
				void video.play().catch(() => undefined);
			} else {
				video.pause();
			}
		});
	}, [index, isOpen]);

	useEffect(() => {
		setSearchMenu(null);
	}, [index]);

	useEffect(
		() => () => {
			if (singleTapTimerRef.current != null) window.clearTimeout(singleTapTimerRef.current);
		},
		[],
	);

	const handleScroll = useCallback(() => {
		const scroller = scrollerRef.current;
		// Mid-resize the width is stale; the resize handler puts things right.
		if (!scroller || scroller.clientWidth === 0 || scroller.clientWidth !== widthRef.current) return;
		const next = clamp(Math.round(scroller.scrollLeft / scroller.clientWidth), 0, Math.max(0, N - 1));
		if (next === indexRef.current) return;
		indexRef.current = next;
		setIndex(next);
		updateZoom(NO_ZOOM);
	}, [N, updateZoom]);

	const goTo = useCallback(
		(target: number) => {
			const scroller = scrollerRef.current;
			if (!scroller || N < 2) return;
			const next = clamp(target, 0, N - 1);
			if (next === indexRef.current) return;
			updateZoom(NO_ZOOM);
			scroller.scrollTo({ left: next * scroller.clientWidth, behavior: "smooth" });
		},
		[N, updateZoom],
	);

	const clampZoom = useCallback((next: Zoom): Zoom => {
		if (next.scale <= 1) return NO_ZOOM;
		const media = mediaRef.current;
		const root = rootRef.current;
		if (!media || !root) return next;
		// offsetWidth ignores the transform: the photo's size at 100%.
		const maxX = Math.max(0, (media.offsetWidth * next.scale - root.clientWidth) / 2);
		const maxY = Math.max(0, (media.offsetHeight * next.scale - root.clientHeight) / 2);
		return { scale: next.scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
	}, []);

	/** Zooms to `scale` keeping the point under (clientX, clientY) where it is. */
	const zoomAround = useCallback(
		(scale: number, clientX: number, clientY: number) => {
			const media = mediaRef.current;
			if (!media) return;
			const now = zoomRef.current;
			const nextScale = clamp(scale, 1, MAX_ZOOM);
			const rect = media.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			const pointX = (clientX - centerX) / now.scale;
			const pointY = (clientY - centerY) / now.scale;
			updateZoom(
				clampZoom({
					scale: nextScale,
					x: clientX - (centerX - now.x) - nextScale * pointX,
					y: clientY - (centerY - now.y) - nextScale * pointY,
				}),
			);
		},
		[clampZoom, updateZoom],
	);

	const toggleZoomAt = useCallback(
		(clientX: number, clientY: number) => {
			if (current.type !== "image") return;
			setZoomAnimated(true);
			if (zoomRef.current.scale > 1) updateZoom(NO_ZOOM);
			else zoomAround(DOUBLE_TAP_ZOOM, clientX, clientY);
		},
		[current.type, updateZoom, zoomAround],
	);

	const cancelSingleTap = () => {
		if (singleTapTimerRef.current != null) {
			window.clearTimeout(singleTapTimerRef.current);
			singleTapTimerRef.current = null;
		}
	};

	const handleSingleTap = useCallback(() => {
		if (searchMenu) {
			setSearchMenu(null);
			return;
		}
		// With the reply field open, a tap puts the keyboard away first.
		const active = document.activeElement;
		if (active instanceof HTMLElement && active.matches("input, textarea") && rootRef.current?.contains(active)) {
			active.blur();
			return;
		}
		setChromeHidden((hidden) => !hidden);
	}, [searchMenu]);

	const handleTouchStart = (event: React.TouchEvent) => {
		setZoomAnimated(false);
		if (event.touches.length === 2) {
			const [a, b] = [event.touches[0], event.touches[1]];
			const previous = gestureRef.current;
			gestureRef.current = {
				startX: previous?.startX ?? a.clientX,
				startY: previous?.startY ?? a.clientY,
				lastX: a.clientX,
				lastY: a.clientY,
				moved: true,
				mode: "pinch",
				pinchDistance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
			};
			setDismissY(0);
			cancelSingleTap();
			return;
		}
		if (event.touches.length !== 1) return;
		const touch = event.touches[0];
		gestureRef.current = {
			startX: touch.clientX,
			startY: touch.clientY,
			lastX: touch.clientX,
			lastY: touch.clientY,
			moved: false,
			mode: zoomRef.current.scale > 1 ? "pan" : "undecided",
			pinchDistance: 0,
		};
	};

	const handleTouchMove = (event: React.TouchEvent) => {
		const gesture = gestureRef.current;
		if (!gesture) return;

		if (event.touches.length === 2) {
			const [a, b] = [event.touches[0], event.touches[1]];
			const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
			if (gesture.mode !== "pinch") {
				gesture.mode = "pinch";
				gesture.moved = true;
				gesture.pinchDistance = distance;
				setDismissY(0);
				return;
			}
			if (current.type === "image" && gesture.pinchDistance > 0) {
				zoomAround(
					zoomRef.current.scale * (distance / gesture.pinchDistance),
					(a.clientX + b.clientX) / 2,
					(a.clientY + b.clientY) / 2,
				);
			}
			gesture.pinchDistance = distance;
			return;
		}
		if (event.touches.length !== 1) return;

		const touch = event.touches[0];
		const dx = touch.clientX - gesture.startX;
		const dy = touch.clientY - gesture.startY;
		if (!gesture.moved && Math.hypot(dx, dy) > TAP_SLOP) gesture.moved = true;

		if (gesture.mode === "pan") {
			const now = zoomRef.current;
			updateZoom(
				clampZoom({
					scale: now.scale,
					x: now.x + (touch.clientX - gesture.lastX),
					y: now.y + (touch.clientY - gesture.lastY),
				}),
			);
		} else if (gesture.mode === "undecided" && gesture.moved) {
			// Sideways is the browser's swipe; up or down drags the photo away.
			gesture.mode = Math.abs(dy) > Math.abs(dx) * 1.2 ? "dismiss" : "swipe";
			if (gesture.mode === "dismiss") setIsDismissDragging(true);
		}
		if (gesture.mode === "dismiss") setDismissY(dy);

		gesture.lastX = touch.clientX;
		gesture.lastY = touch.clientY;
	};

	const handleTouchEnd = (event: React.TouchEvent) => {
		const gesture = gestureRef.current;
		if (event.touches.length > 0) {
			// One finger of a pinch lifted: the other may pan a zoomed photo, nothing else.
			if (gesture) {
				const touch = event.touches[0];
				gesture.mode = zoomRef.current.scale > 1 ? "pan" : "ignore";
				gesture.lastX = touch.clientX;
				gesture.lastY = touch.clientY;
				gesture.moved = true;
			}
			return;
		}
		gestureRef.current = null;
		if (!gesture) return;

		if (gesture.mode === "dismiss") {
			setIsDismissDragging(false);
			const endY = event.changedTouches[0]?.clientY ?? gesture.lastY;
			if (Math.abs(endY - gesture.startY) > DISMISS_DISTANCE) onClose();
			else setDismissY(0);
			return;
		}
		if (zoomRef.current.scale > 1 && zoomRef.current.scale < 1.05) updateZoom(NO_ZOOM);
		if (gesture.moved) return;

		// A tap. Video controls take their own.
		if ((event.target as HTMLElement).closest("video")) return;
		event.preventDefault();
		const touch = event.changedTouches[0];
		if (!touch) return;
		const now = Date.now();
		const last = lastTapRef.current;
		if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) < 40) {
			lastTapRef.current = null;
			cancelSingleTap();
			toggleZoomAt(touch.clientX, touch.clientY);
			return;
		}
		lastTapRef.current = { time: now, x: touch.clientX, y: touch.clientY };
		cancelSingleTap();
		singleTapTimerRef.current = window.setTimeout(() => {
			singleTapTimerRef.current = null;
			handleSingleTap();
		}, DOUBLE_TAP_MS);
	};

	const handleTouchCancel = () => {
		gestureRef.current = null;
		setIsDismissDragging(false);
		setDismissY(0);
		if (zoomRef.current.scale < 1.05) updateZoom(NO_ZOOM);
	};

	const handleWheel = (event: React.WheelEvent) => {
		// Sideways trackpad swipes move between photos natively.
		if (current.type !== "image" || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
		setZoomAnimated(false);
		const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
		zoomAround(zoomRef.current.scale * factor, event.clientX, event.clientY);
	};

	const handlePointerDown = (event: React.PointerEvent) => {
		if (event.pointerType !== "mouse" || event.button !== 0 || zoomRef.current.scale <= 1) return;
		event.preventDefault();
		setZoomAnimated(false);
		mouseDragRef.current = { x: event.clientX, y: event.clientY };
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			// Capture is a nicety; dragging still works without it.
		}
	};

	const handlePointerMove = (event: React.PointerEvent) => {
		const drag = mouseDragRef.current;
		if (!drag) return;
		const now = zoomRef.current;
		updateZoom(clampZoom({ scale: now.scale, x: now.x + event.clientX - drag.x, y: now.y + event.clientY - drag.y }));
		mouseDragRef.current = { x: event.clientX, y: event.clientY };
	};

	const handlePointerUp = () => {
		mouseDragRef.current = null;
	};

	useEffect(() => {
		if (!isOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				if (searchMenu) setSearchMenu(null);
				else onClose();
				return;
			}
			const target = event.target as HTMLElement | null;
			if (target?.matches("input, textarea")) return;
			if (event.key === "ArrowLeft") goTo(indexRef.current - 1);
			if (event.key === "ArrowRight") goTo(indexRef.current + 1);
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [goTo, isOpen, onClose, searchMenu]);

	const handleSave = async () => {
		if (!current.url || isSaving) return;
		setIsSaving(true);
		try {
			const saved = await saveMediaToDevice(current.url, current.type, conversationId);
			if (saved) {
				toast.success(t("profile_details.save_to_gallery_success"));
			} else {
				toast.error(t("profile_details.save_to_gallery_unsupported"));
			}
		} catch (error) {
			appLog.error("Failed to save media to gallery", error);
			toast.error(t("profile_details.save_to_gallery_error"));
		} finally {
			setIsSaving(false);
		}
	};

	/** Prepares the search, then lets the user pick the engine: nothing opens by itself. */
	const handleReverseSearch = async () => {
		if (!current.url || isSearching) return;
		if (searchMenu) {
			setSearchMenu(null);
			return;
		}
		const cached = searchCacheRef.current.get(current.url);
		if (cached) {
			setSearchMenu(cached);
			return;
		}
		const searchedIndex = indexRef.current;
		setIsSearching(true);
		try {
			const links = await resolveReverseSearchLinks(current.url);
			searchCacheRef.current.set(current.url, links);
			if (indexRef.current === searchedIndex) setSearchMenu(links);
		} catch (error) {
			appLog.error("Reverse image search failed", error);
			toast.error(t("photo_viewer.reverse_search_failed", { defaultValue: "Couldn't start the image search." }));
		} finally {
			setIsSearching(false);
		}
	};

	if (!isOpen || N === 0) return null;

	const footer = renderFooter ? renderFooter(index) : null;
	const hasFooter = footer != null && footer !== false;
	const extraInfo = renderExtraInfo ? renderExtraInfo(index) : null;
	const isZoomed = zoom.scale > 1;
	const dismissProgress = Math.min(Math.abs(dismissY) / 400, 1);
	const chromeVisible = !chromeHidden && dismissY === 0;
	const chromeClass = chromeVisible ? "opacity-100" : "pointer-events-none opacity-0";
	// The shaded areas behind the controls let taps and clicks through to the photo.
	const chromeHitClass = chromeVisible ? "pointer-events-auto" : "";

	return createPortal(
		<div ref={rootRef} className="fixed inset-0 z-[80] select-none overflow-clip text-white" data-lenis-prevent>
			<div className="absolute inset-0 bg-black" style={{ opacity: 1 - dismissProgress * 0.75 }} />

			<div
				ref={scrollerRef}
				onScroll={handleScroll}
				onTouchStart={handleTouchStart}
				onTouchMove={handleTouchMove}
				onTouchEnd={handleTouchEnd}
				onTouchCancel={handleTouchCancel}
				onClick={(event) => {
					// A click on the black around a photo closes it on a computer.
					if (isDesktop && (event.target as HTMLElement).dataset.slide === "backdrop") onClose();
				}}
				className="absolute inset-y-0 z-[1] flex overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				style={{
					left: -SLIDE_GAP / 2,
					right: -SLIDE_GAP / 2,
					overflowX: isZoomed || N < 2 ? "hidden" : "auto",
					scrollSnapType: "x mandatory",
					overscrollBehavior: "contain",
					touchAction: isZoomed ? "none" : "pan-x",
					transform: dismissY !== 0 ? `translate3d(0, ${dismissY}px, 0) scale(${1 - dismissProgress * 0.12})` : undefined,
					transition: isDismissDragging ? "none" : "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)",
				}}
			>
				{photos.map((photo, slideIndex) => {
					const { url, type, alt } = getMediaInfo(photo);
					const isCurrent = slideIndex === index;
					// Only the photo on screen and its neighbours are loaded.
					const isNear = Math.abs(slideIndex - index) <= 1;
					const videoPadding =
						type === "video" && !isDesktop
							? {
									paddingTop: "calc(env(safe-area-inset-top, 0px) + 4rem)",
									paddingBottom: hasFooter
										? "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)"
										: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
								}
							: undefined;
					return (
						<div
							key={slideIndex}
							className="h-full w-full shrink-0"
							style={{ paddingInline: SLIDE_GAP / 2, scrollSnapAlign: "center", scrollSnapStop: "always" }}
						>
						<div
							data-slide="backdrop"
							className={`relative flex h-full w-full items-center justify-center overflow-hidden ${isDesktop ? "px-20 py-16" : ""}`}
							style={videoPadding}
						>
							{!isNear || !url ? null : type === "video" ? (
								<video
									data-slide={slideIndex}
									src={url}
									controls={isCurrent}
									playsInline
									preload="metadata"
									onLoadedMetadata={(event) => {
										// Shows the first frame instead of black until it plays.
										if (event.currentTarget.currentTime === 0) event.currentTarget.currentTime = 0.001;
									}}
									className={`max-h-full max-w-full object-contain ${isDesktop ? "rounded-2xl" : ""}`}
								/>
							) : (
								<img
									ref={isCurrent ? mediaRef : undefined}
									src={url}
									alt={alt}
									draggable={false}
									decoding="async"
									onDoubleClick={isCurrent ? (event) => toggleZoomAt(event.clientX, event.clientY) : undefined}
									onWheel={isCurrent ? handleWheel : undefined}
									onPointerDown={isCurrent ? handlePointerDown : undefined}
									onPointerMove={isCurrent ? handlePointerMove : undefined}
									onPointerUp={isCurrent ? handlePointerUp : undefined}
									onPointerCancel={isCurrent ? handlePointerUp : undefined}
									className={`max-h-full max-w-full object-contain ${isDesktop ? "rounded-2xl" : ""} ${
										isCurrent && isZoomed ? (isDesktop ? "cursor-grab active:cursor-grabbing" : "") : isDesktop ? "cursor-zoom-in" : ""
									}`}
									style={
										isCurrent
											? {
													transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
													transition: zoomAnimated ? ZOOM_TRANSITION : "none",
													willChange: isZoomed ? "transform" : undefined,
												}
											: undefined
									}
								/>
							)}
						</div>
						</div>
					);
				})}
			</div>

			{/* Top: close, what this is, and what can be done with it. */}
			<div
				className={`pointer-events-none absolute inset-x-0 top-0 z-[5] bg-gradient-to-b from-black/70 via-black/30 to-transparent pb-14 transition-opacity duration-200 ${chromeClass}`}
				style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)" }}
			>
				<div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 px-3 sm:px-5">
					<div className={`justify-self-start ${chromeHitClass}`}>
						<ViewerButton label={t("profile_details.close_photo_viewer")} onPress={onClose}>
							<X className="h-5 w-5" />
						</ViewerButton>
					</div>

					<div className="flex min-w-0 flex-col items-center gap-1.5 pt-1.5">
						{extraInfo}
						{N > 1 ? (
							<p className="rounded-full bg-black/30 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums tracking-wide text-white/90 ring-1 ring-inset ring-white/10 backdrop-blur-xl">
								{index + 1} / {N}
							</p>
						) : null}
					</div>

					<div className={`relative flex items-center gap-2 justify-self-end ${chromeHitClass}`}>
						{current.type === "image" ? (
							<ViewerButton
								label={t("photo_viewer.reverse_search", { defaultValue: "Search this image on Google Lens and Yandex" })}
								onPress={() => void handleReverseSearch()}
								disabled={isSearching}
								className={searchMenu ? "bg-white/25" : ""}
							>
								{isSearching ? <Loader2 className="h-5 w-5 animate-spin" /> : <ScanSearch className="h-5 w-5" />}
							</ViewerButton>
						) : null}
						<ViewerButton label={t("profile_details.save_to_gallery")} onPress={() => void handleSave()} disabled={isSaving}>
							{isSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
						</ViewerButton>

						{searchMenu ? (
							<div
								className="absolute right-0 top-full z-[6] mt-2 w-60 rounded-2xl bg-neutral-900/90 p-1.5 shadow-2xl ring-1 ring-inset ring-white/15 backdrop-blur-xl"
								onClick={(event) => event.stopPropagation()}
							>
								<p className="px-3 pb-1.5 pt-2 text-xs font-medium text-white/60">
									{t("photo_viewer.reverse_search_pick", { defaultValue: "Search this photo on" })}
								</p>
								{(
									[
										{ name: "Google Lens", url: searchMenu.googleLens, mark: "G", markClass: "bg-white text-[#4285F4]" },
										{ name: "Yandex", url: searchMenu.yandex, mark: "Я", markClass: "bg-[#FC3F1D] text-white" },
									] as const
								).map((engine) => (
									<button
										key={engine.name}
										type="button"
										onClick={() => void openExternal(engine.url)}
										className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition hover:bg-white/10 active:bg-white/15"
									>
										<span
											className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-black ${engine.markClass}`}
										>
											{engine.mark}
										</span>
										<span className="flex-1">{engine.name}</span>
										<ExternalLink className="h-4 w-4 text-white/50" />
									</button>
								))}
							</div>
						) : null}
					</div>
				</div>
			</div>

			{searchMenu ? (
				<button
					type="button"
					aria-label={t("common.close", { defaultValue: "Close" })}
					className="absolute inset-0 z-[4] cursor-default"
					onClick={() => setSearchMenu(null)}
				/>
			) : null}

			{isDesktop && N > 1 ? (
				<>
					{index > 0 ? (
						<ViewerButton
							label={t("profile_details.previous_photo")}
							onPress={() => goTo(index - 1)}
							className={`absolute left-4 top-1/2 z-[3] h-11 w-11 -translate-y-1/2 transition-opacity ${chromeClass}`}
						>
							<ChevronLeft className="h-5 w-5" />
						</ViewerButton>
					) : null}
					{index < N - 1 ? (
						<ViewerButton
							label={t("profile_details.next_photo")}
							onPress={() => goTo(index + 1)}
							className={`absolute right-4 top-1/2 z-[3] h-11 w-11 -translate-y-1/2 transition-opacity ${chromeClass}`}
						>
							<ChevronRight className="h-5 w-5" />
						</ViewerButton>
					) : null}
				</>
			) : null}

			{isDesktop && isZoomed ? (
				<div
					className={`absolute left-1/2 z-[3] flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/40 px-1.5 py-1 shadow-2xl ring-1 ring-inset ring-white/15 backdrop-blur-xl ${
						hasFooter ? "bottom-24" : "bottom-4"
					}`}
				>
					<button
						type="button"
						onClick={() => {
							setZoomAnimated(true);
							updateZoom(clampZoom({ ...zoomRef.current, scale: zoomRef.current.scale - 0.5 }));
						}}
						className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/20 active:scale-95"
						title={t("photo_viewer.zoom_out", { defaultValue: "Zoom out" })}
					>
						<ZoomOut className="h-4 w-4" />
					</button>
					<span className="min-w-[3.5rem] text-center text-xs font-semibold tabular-nums tracking-wider">
						{Math.round(zoom.scale * 100)}%
					</span>
					<button
						type="button"
						onClick={() => {
							setZoomAnimated(true);
							updateZoom(clampZoom({ ...zoomRef.current, scale: Math.min(MAX_ZOOM, zoomRef.current.scale + 0.5) }));
						}}
						className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/20 active:scale-95"
						title={t("photo_viewer.zoom_in", { defaultValue: "Zoom in" })}
					>
						<ZoomIn className="h-4 w-4" />
					</button>
					<button
						type="button"
						onClick={() => {
							setZoomAnimated(true);
							updateZoom(NO_ZOOM);
						}}
						className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/20 active:scale-95"
						title={t("photo_viewer.zoom_reset", { defaultValue: "Reset zoom" })}
					>
						<RotateCcw className="h-3.5 w-3.5" />
					</button>
				</div>
			) : null}

			{hasFooter ? (
				<div
					className={`pointer-events-none absolute inset-x-0 bottom-0 z-[3] bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pt-16 transition-opacity duration-200 ${chromeClass}`}
					style={{
						paddingBottom: keyboardOpen ? "0.75rem" : "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
					}}
				>
					<div className={`mx-auto w-full max-w-lg ${chromeHitClass}`}>{footer}</div>
				</div>
			) : null}
		</div>,
		document.getElementById("app") ?? document.body,
	);
}
