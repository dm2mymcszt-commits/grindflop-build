/**
 * A setTimeout that keeps its pace while the window is hidden.
 *
 * A hidden page's timer chains are held back by the webview to about one
 * wake-up a minute: on the PC, with the window minimised, the 30-second views
 * sweep was measured running every 61 seconds. A dedicated worker's timers are
 * not held back that way, so the wait runs there and only the callback comes
 * back to the page. Where no worker can be made, this is a plain setTimeout.
 */

export type UnthrottledTimeout = { cancel: () => void };

const WORKER_SOURCE = `
const timers = new Map();
onmessage = (event) => {
	const { id, delay, cancel } = event.data;
	clearTimeout(timers.get(id));
	timers.delete(id);
	if (cancel) return;
	timers.set(id, setTimeout(() => {
		timers.delete(id);
		postMessage(id);
	}, delay));
};
`;

let worker: Worker | null | undefined;
let nextId = 1;
const callbacks = new Map<number, () => void>();

function timerWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
		worker = new Worker(url);
		worker.onmessage = (event: MessageEvent<number>) => {
			const callback = callbacks.get(event.data);
			callbacks.delete(event.data);
			callback?.();
		};
	} catch {
		worker = null;
	}
	return worker;
}

export function setUnthrottledTimeout(callback: () => void, delayMs: number): UnthrottledTimeout {
	const host = typeof Worker === "undefined" ? null : timerWorker();
	if (!host) {
		const timer = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timer) };
	}
	const id = nextId++;
	callbacks.set(id, callback);
	host.postMessage({ id, delay: delayMs });
	return {
		cancel: () => {
			if (callbacks.delete(id)) host.postMessage({ id, cancel: true });
		},
	};
}
