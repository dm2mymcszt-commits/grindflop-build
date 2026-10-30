/**
 * Runs `task` over `items` with at most `limit` of them in flight at once, and
 * resolves with the results in the original order.
 *
 * Downloading an album or a chat's media used to start every file at once.
 * Each download sits in memory several times over while it is base64-encoded
 * and handed to the database, so a handful of videos arriving together was
 * enough to get the iOS web process killed.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await task(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
