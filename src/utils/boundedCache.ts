/**
 * Caches of data: URIs capped by their total length, evicting whatever was used
 * least recently.
 *
 * Saved media is shown from base64 data: URIs, and those used to live in plain
 * maps that only ever grew: every photo, video, avatar and album thumbnail the
 * app touched stayed in memory as a string for the rest of the session —
 * including media captured from chats the auto-blocker archived and nobody ever
 * opened. On iOS that runs the web content process out of memory, which the
 * system answers by killing it and reloading the page.
 *
 * Evicting an entry loses nothing: it is still in chatDb, and the readers load
 * it from there again when it is needed.
 */

const MB = 1024 * 1024;

/** Phones get a much smaller budget: their web content process is killed far sooner. */
export function isConstrainedDevice(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function cacheBudget(phoneMb: number, desktopMb: number): number {
	return (isConstrainedDevice() ? phoneMb : desktopMb) * MB;
}

export type CacheStats = {
	name: string;
	entries: number;
	chars: number;
	maxChars: number;
};

const registry = new Set<{ stats(): CacheStats }>();

export function getCacheStats(): CacheStats[] {
	return [...registry].map((cache) => cache.stats());
}

export class BoundedStringCache<K> {
	private readonly entries = new Map<K, string>();
	private totalChars = 0;
	private readonly name: string;
	private readonly maxChars: number;

	constructor(name: string, maxChars: number) {
		this.name = name;
		this.maxChars = maxChars;
		registry.add(this);
	}

	get(key: K): string | undefined {
		const value = this.entries.get(key);
		if (value === undefined) {
			return undefined;
		}
		// A Map iterates in insertion order, so re-inserting is what marks an
		// entry as the most recently used.
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	set(key: K, value: string): void {
		const previous = this.entries.get(key);
		if (previous !== undefined) {
			this.totalChars -= previous.length;
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.totalChars += value.length;
		this.evict();
	}

	delete(key: K): boolean {
		const previous = this.entries.get(key);
		if (previous === undefined) {
			return false;
		}
		this.totalChars -= previous.length;
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
		this.totalChars = 0;
	}

	stats(): CacheStats {
		return {
			name: this.name,
			entries: this.entries.size,
			chars: this.totalChars,
			maxChars: this.maxChars,
		};
	}

	private evict(): void {
		// The entry just written is the newest, so it is never the one removed —
		// even a single item larger than the whole budget stays until the next.
		while (this.totalChars > this.maxChars && this.entries.size > 1) {
			const oldest = this.entries.keys().next().value as K;
			const value = this.entries.get(oldest) ?? "";
			this.entries.delete(oldest);
			this.totalChars -= value.length;
		}
	}
}
