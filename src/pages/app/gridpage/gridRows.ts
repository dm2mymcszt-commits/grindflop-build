/**
 * The arithmetic of a grid drawn row by row. Kept apart from the component so
 * it can be tested without a browser, and apart from the other grid helpers
 * because those reach the locale loader, which exists only under Vite.
 */

/** Splits a flat list into rows of `columnCount`; the last row may be short. */
export function chunkIntoRows<T>(items: readonly T[], columnCount: number): T[][] {
	// Anything that is not a usable count (zero, a fraction below one, NaN) means one per row.
	const size = Number.isFinite(columnCount) && columnCount >= 1 ? Math.floor(columnCount) : 1;
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		rows.push(items.slice(i, i + size));
	}
	return rows;
}

/**
 * The top of the row that a line crosses, all in the scroll content's own
 * coordinates: `listTop` is where the first row starts, `rowSizePx` the
 * distance from one row's top to the next.
 *
 * Used to line a row up under the page header after the scroll position was
 * restored. Returns null when the line is above the grid, or the row size is
 * not usable, so the caller leaves the position alone.
 */
export function rowTopAtOrAbove(line: number, listTop: number, rowSizePx: number): number | null {
	if (!(rowSizePx > 0)) {
		return null;
	}
	const intoList = line - listTop;
	if (!(intoList > 0)) {
		return null;
	}
	return listTop + Math.floor(intoList / rowSizePx) * rowSizePx;
}
