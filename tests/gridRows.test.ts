import { describe, expect, test } from "bun:test";
import { chunkIntoRows, rowTopAtOrAbove } from "../src/pages/app/gridpage/gridRows";

describe("chunkIntoRows", () => {
	test("fills rows in order and leaves the last one short", () => {
		expect(chunkIntoRows([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
	});

	test("an exact multiple leaves no empty row at the end", () => {
		expect(chunkIntoRows([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
	});

	test("an empty list has no rows", () => {
		expect(chunkIntoRows([], 3)).toEqual([]);
	});

	// A column count is read back from the browser, and before it has answered,
	// or while the grid is hidden, it can be nothing sensible.
	test("a column count below one still yields rows, one tile each", () => {
		expect(chunkIntoRows([1, 2], 0)).toEqual([[1], [2]]);
		expect(chunkIntoRows([1, 2], Number.NaN)).toEqual([[1], [2]]);
	});

	test("a fractional column count is rounded down", () => {
		expect(chunkIntoRows([1, 2, 3, 4, 5], 2.9)).toEqual([[1, 2], [3, 4], [5]]);
	});
});

describe("rowTopAtOrAbove", () => {
	// The grid starts 112px into the scroll content (the padding that lets it
	// slide under the page header), and rows are 131px apart.
	const listTop = 112;
	const rowSize = 131;

	test("a line inside a row gives that row's top", () => {
		expect(rowTopAtOrAbove(112 + 131 * 4 + 60, listTop, rowSize)).toBe(112 + 131 * 4);
	});

	test("a line exactly on a row's top gives that same top", () => {
		expect(rowTopAtOrAbove(112 + 131 * 2, listTop, rowSize)).toBe(112 + 131 * 2);
	});

	test("a line at or above the start of the grid is left alone", () => {
		expect(rowTopAtOrAbove(112, listTop, rowSize)).toBeNull();
		expect(rowTopAtOrAbove(40, listTop, rowSize)).toBeNull();
	});

	test("a row size that is not usable is left alone", () => {
		expect(rowTopAtOrAbove(500, listTop, 0)).toBeNull();
		expect(rowTopAtOrAbove(500, listTop, Number.NaN)).toBeNull();
	});

	test("fractional row sizes, as a phone gives them, are handled", () => {
		const top = rowTopAtOrAbove(112 + 131.333 * 3 + 5, listTop, 131.333);
		expect(top).toBeCloseTo(112 + 131.333 * 3, 6);
	});
});
