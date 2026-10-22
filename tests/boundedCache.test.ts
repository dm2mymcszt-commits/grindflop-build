import { describe, expect, test } from "bun:test";
import { BoundedStringCache, getCacheStats } from "../src/utils/boundedCache";

describe("BoundedStringCache", () => {
	test("evicts the least recently used entries once over budget", () => {
		const cache = new BoundedStringCache<string>("test-evict", 10);
		cache.set("a", "aaaa");
		cache.set("b", "bbbb");
		cache.set("c", "cccc"); // 12 chars: "a" has to go
		expect(cache.has("a")).toBe(false);
		expect(cache.get("b")).toBe("bbbb");
		expect(cache.get("c")).toBe("cccc");
		expect(cache.stats().chars).toBe(8);
	});

	test("reading an entry keeps it from being the next one evicted", () => {
		const cache = new BoundedStringCache<string>("test-recency", 10);
		cache.set("a", "aaaa");
		cache.set("b", "bbbb");
		cache.get("a");
		cache.set("c", "cccc");
		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
	});

	test("an entry larger than the whole budget stays until the next write", () => {
		const cache = new BoundedStringCache<string>("test-oversized", 4);
		cache.set("small", "ab");
		cache.set("huge", "0123456789");
		expect(cache.has("small")).toBe(false);
		expect(cache.get("huge")).toBe("0123456789");
		cache.set("next", "xy");
		expect(cache.has("huge")).toBe(false);
	});

	test("overwriting a key counts only its new length", () => {
		const cache = new BoundedStringCache<number>("test-overwrite", 100);
		cache.set(1, "aaaa");
		cache.set(1, "bb");
		expect(cache.stats()).toMatchObject({ entries: 1, chars: 2 });
		cache.delete(1);
		expect(cache.stats()).toMatchObject({ entries: 0, chars: 0 });
	});

	test("every cache reports itself for diagnostics", () => {
		new BoundedStringCache<string>("test-registry", 1);
		expect(getCacheStats().some((stats) => stats.name === "test-registry")).toBe(true);
	});
});
