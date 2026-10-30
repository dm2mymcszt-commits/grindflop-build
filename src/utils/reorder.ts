/**
 * A list with one of its items moved to where another one is. Returns null
 * when there is nothing to move: either item is unknown, or they are the same.
 * The list handed in is left as it is.
 */
export function moveItemTo<T>(items: readonly T[], moved: T, target: T): T[] | null {
	const from = items.indexOf(moved);
	const to = items.indexOf(target);
	if (from === -1 || to === -1 || from === to) {
		return null;
	}
	const next = items.slice();
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}
