/**
 * useBanOnSelect — highlight text, get the Ban keyword dialog.
 *
 * Text selection is off app-wide (`body { user-select: none }` in layout.css)
 * so the app reads as an app rather than a web page. The "select text to ban
 * it" setting is the one exception: while it is on, the places worth banning
 * words from opt in with `banSelectableProps(kind)`, which both makes them
 * selectable and marks what a selection inside them means.
 *
 * Marking the elements rather than wiring a container listener is what keeps
 * a selection dragged across two message bubbles from turning into a keyword:
 * the lookup walks *up* from the selection's common ancestor, and a selection
 * spanning two bubbles has no marked ancestor, so it is ignored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BAN_ON_SELECT_UPDATED_EVENT, isBanOnSelectEnabled } from "../utils/autoblock";

/**
 * What a selection is, which decides where the keyword may go: a message may
 * be banned as a forbidden keyword or as an opening message, while a name, a
 * bio or a Right Now post only ever belongs in the keyword list.
 */
export type BanSelectionKind = "message" | "name" | "profile";

export type BanSelection = { text: string; kind: BanSelectionKind };

const BAN_SELECTABLE_ATTRIBUTE = "data-ban-selectable";

/**
 * Marks a piece of text a selection may be banned from. Spread onto the
 * element — alongside the `ban-selectable` class, which is what re-enables
 * selection — only while the feature is on: leaving selection on permanently
 * would change how the whole app feels to drag.
 */
export function banSelectableProps(kind: BanSelectionKind): Record<string, string> {
	return { [BAN_SELECTABLE_ATTRIBUTE]: kind };
}

/** The toggle's live value, for views that only need to know whether to opt in. */
export function useBanOnSelectEnabled(): boolean {
	const [enabled, setEnabled] = useState(isBanOnSelectEnabled);

	useEffect(() => {
		const sync = () => setEnabled(isBanOnSelectEnabled());
		window.addEventListener(BAN_ON_SELECT_UPDATED_EVENT, sync);
		// A second window of the app changing the setting arrives as `storage`.
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(BAN_ON_SELECT_UPDATED_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);

	return enabled;
}

function readMarkedSelection(): BanSelection | null {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

	const text = selection.toString().trim();
	if (!text) return null;

	const node = selection.getRangeAt(0).commonAncestorContainer;
	const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	const host = element?.closest(`[${BAN_SELECTABLE_ATTRIBUTE}]`);
	if (!host) return null;

	const marked = host.getAttribute(BAN_SELECTABLE_ATTRIBUTE);
	const kind: BanSelectionKind =
		marked === "profile" || marked === "name" ? marked : "message";
	return { text, kind };
}

/**
 * Watches for a finished selection inside marked text. Mount it wherever the
 * Ban keyword dialog lives; `clearSelection` is the dialog's onClose.
 *
 * `accept` is the kind, or kinds, this host owns. Two hosts are never on screen
 * together today (the chat thread and the profile are separate routes), but
 * naming the kinds means that if they ever are, a highlight opens one dialog
 * rather than both of them at once.
 */
export function useBanOnSelect(accept: BanSelectionKind | readonly BanSelectionKind[]): {
	enabled: boolean;
	selection: BanSelection | null;
	clearSelection: () => void;
} {
	const acceptKey = (Array.isArray(accept) ? accept : [accept]).join(",");
	const enabled = useBanOnSelectEnabled();
	const [selection, setSelection] = useState<BanSelection | null>(null);
	// Mirrors `selection` for the listeners: without it, every click inside the
	// open dialog would read the still-highlighted text and hand the dialog a
	// fresh object, throwing away whatever the user had trimmed it down to.
	const pendingRef = useRef<BanSelection | null>(null);

	const clearSelection = useCallback(() => {
		pendingRef.current = null;
		setSelection(null);
		// The highlight itself has to go too, or the next click anywhere reads
		// the same range and reopens the dialog on text already dealt with.
		try {
			window.getSelection()?.removeAllRanges();
		} catch {
			// Some engines throw when there is nothing to clear; nothing to do.
		}
	}, []);

	useEffect(() => {
		if (!enabled) {
			if (pendingRef.current) clearSelection();
			return;
		}

		const capture = () => {
			if (pendingRef.current) return;
			// Both pointer and keyboard selections are only final after the
			// event has been handled, so read on the next tick.
			window.setTimeout(() => {
				if (pendingRef.current) return;
				const found = readMarkedSelection();
				if (!found || !acceptKey.split(",").includes(found.kind)) return;
				pendingRef.current = found;
				setSelection(found);
			}, 0);
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			const isKeyboardSelection =
				event.key === "Shift"
				|| (event.shiftKey && event.key.startsWith("Arrow"))
				|| ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a");
			if (isKeyboardSelection) capture();
		};

		document.addEventListener("pointerup", capture);
		document.addEventListener("keyup", handleKeyUp);
		return () => {
			document.removeEventListener("pointerup", capture);
			document.removeEventListener("keyup", handleKeyUp);
		};
		// acceptKey rather than `accept` so a caller passing an inline array
		// does not re-subscribe on every render.
	}, [enabled, acceptKey, clearSelection]);

	return { enabled, selection, clearSelection };
}
