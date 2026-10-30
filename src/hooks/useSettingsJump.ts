import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Lights a row for a moment; the length is in index.css, next to the class. */
const HIGHLIGHT_CLASS = "settings-jump-highlight";
const HIGHLIGHT_MS = 1600;

/**
 * A page that has just opened is sent back to its top, and measured again a
 * moment later. A jump made before that is undone, so it waits for it.
 */
const SETTLE_MS = 250;

/**
 * Takes the reader to the setting a search result pointed at. The result's
 * link ends in `#row` or `#row,fallback`: the first of those ids that is on
 * the page is scrolled into view and lit for a moment, and a folded section
 * is opened. A page only has to call this and give its rows their ids.
 */
export function useSettingsJump(): void {
	const { hash, key } = useLocation();

	useEffect(() => {
		const ids = hash.slice(1).split(",").filter(Boolean);
		if (ids.length === 0) {
			return;
		}

		let lit: HTMLElement | null = null;
		let frame: number | undefined;
		let fade: number | undefined;

		const settle = window.setTimeout(() => {
			const target = ids
				.map((id) => document.getElementById(id))
				.find((element): element is HTMLElement => element !== null);
			if (!target) {
				return;
			}

			target.querySelector<HTMLButtonElement>(":scope > button[aria-expanded='false']")?.click();

			lit = target;
			target.classList.add(HIGHLIGHT_CLASS);
			fade = window.setTimeout(() => target.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);

			// A frame later, so a section that was just opened has its full height.
			frame = window.requestAnimationFrame(() => {
				// Something taller than the screen is shown from its top; centred,
				// its heading would be out of sight.
				const fits = target.getBoundingClientRect().height < window.innerHeight * 0.7;
				target.scrollIntoView({ behavior: "smooth", block: fits ? "center" : "start" });
			});
		}, SETTLE_MS);

		return () => {
			window.clearTimeout(settle);
			if (frame !== undefined) {
				window.cancelAnimationFrame(frame);
			}
			if (fade !== undefined) {
				window.clearTimeout(fade);
			}
			lit?.classList.remove(HIGHLIGHT_CLASS);
		};
	}, [hash, key]);
}
