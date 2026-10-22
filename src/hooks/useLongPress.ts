import { useCallback, useEffect, useRef } from "react";

/** How long selection stays held off after the finger lifts, while iOS finishes the gesture. */
const SELECTION_RELEASE_DELAY_MS = 300;

/**
 * iOS turns a finger held on or near text into a text selection with its
 * Copy / Look Up / Translate menu, and text in the app is selectable, so a
 * long press on a button could select a word somewhere else on the screen.
 * While a press is held, selection is switched off for the whole page.
 * Returns the function that switches it back on.
 */
function holdOffTextSelection(): () => void {
    if (typeof document === "undefined") return () => undefined;
    const style = document.documentElement.style as CSSStyleDeclaration & {
        webkitUserSelect?: string;
    };
    const previous = { userSelect: style.userSelect, webkitUserSelect: style.webkitUserSelect ?? "" };
    style.userSelect = "none";
    style.webkitUserSelect = "none";
    const preventSelection = (event: Event) => event.preventDefault();
    document.addEventListener("selectstart", preventSelection);
    return () => {
        document.removeEventListener("selectstart", preventSelection);
        style.userSelect = previous.userSelect;
        style.webkitUserSelect = previous.webkitUserSelect;
    };
}

export function useLongPress(onLongPress: () => void, delay = 500) {
    const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef<{ x: number; y: number } | null>(null);
    const restoreSelection = useRef<(() => void) | null>(null);
    const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const releaseSelection = useCallback((immediately: boolean) => {
        if (restoreTimer.current) {
            clearTimeout(restoreTimer.current);
            restoreTimer.current = null;
        }
        const restore = restoreSelection.current;
        if (!restore) return;
        const run = () => {
            restoreTimer.current = null;
            restoreSelection.current = null;
            restore();
        };
        if (immediately) {
            run();
        } else {
            restoreTimer.current = setTimeout(run, SELECTION_RELEASE_DELAY_MS);
        }
    }, []);

    useEffect(() => () => releaseSelection(true), [releaseSelection]);

    const start = useCallback((e: React.TouchEvent | React.MouseEvent) => {
        if ('touches' in e) {
            startPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            if (restoreTimer.current) {
                clearTimeout(restoreTimer.current);
                restoreTimer.current = null;
            }
            restoreSelection.current ??= holdOffTextSelection();
        } else {
            startPos.current = { x: e.clientX, y: e.clientY };
        }

        timeout.current = setTimeout(() => {
            onLongPress();
            timeout.current = null;
        }, delay);
    }, [onLongPress, delay]);

    const clear = useCallback(() => {
        if (timeout.current) {
            clearTimeout(timeout.current);
            timeout.current = null;
        }
        releaseSelection(false);
    }, [releaseSelection]);

    const move = useCallback((e: React.TouchEvent | React.MouseEvent) => {
        if (!timeout.current || !startPos.current) return;

        const currentX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const currentY = 'touches' in e ? e.touches[0].clientY : e.clientY;

        const dx = Math.abs(currentX - startPos.current.x);
        const dy = Math.abs(currentY - startPos.current.y);

        // If finger/mouse moves more than 10px, it's a scroll. Cancel the long press!
        if (dx > 10 || dy > 10) {
            clear();
        }
    }, [clear]);

    return {
        onMouseDown: start,
        onTouchStart: start,
        onMouseMove: move,
        onTouchMove: move,
        onMouseUp: clear,
        onMouseLeave: clear,
        onTouchEnd: clear,
        onTouchCancel: clear,
    };
}
