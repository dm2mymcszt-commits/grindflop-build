import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "../src/utils/concurrency";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("mapWithConcurrency", () => {
	test("never runs more than the limit at once", async () => {
		let running = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
			running += 1;
			peak = Math.max(peak, running);
			await tick();
			running -= 1;
		});
		expect(peak).toBe(2);
	});

	test("a limit of one runs strictly in order", async () => {
		const order: number[] = [];
		await mapWithConcurrency([1, 2, 3], 1, async (item) => {
			order.push(item);
			await tick();
			order.push(-item);
		});
		expect(order).toEqual([1, -1, 2, -2, 3, -3]);
	});

	test("keeps results in the original order whatever finishes first", async () => {
		const results = await mapWithConcurrency([30, 10, 20], 3, async (delay) => {
			await new Promise((resolve) => setTimeout(resolve, delay));
			return delay;
		});
		expect(results).toEqual([30, 10, 20]);
	});

	test("an empty list resolves without running anything", async () => {
		let calls = 0;
		expect(await mapWithConcurrency([], 4, async () => (calls += 1))).toEqual([]);
		expect(calls).toBe(0);
	});
});
