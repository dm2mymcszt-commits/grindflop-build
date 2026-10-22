import { useCallback, useEffect, useState } from "react";

export type StatsResource<T> =
	| { status: "loading"; data: null; error: null; reload: () => void }
	| { status: "ready"; data: T; error: null; reload: () => void }
	| { status: "error"; data: null; error: unknown; reload: () => void };

/**
 * Runs a loader while the component using it is mounted, and whenever its
 * inputs change. Nothing is cached anywhere else: leaving the page drops the
 * result, which is the point — Stats does no work while it is closed.
 */
export function useStatsResource<T>(
	loader: (() => Promise<T>) | null,
	deps: readonly unknown[],
): StatsResource<T> {
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "ready"; data: T }
		| { status: "error"; error: unknown }
	>({ status: "loading" });
	const reload = useCallback(() => setAttempt((value) => value + 1), []);

	useEffect(() => {
		if (!loader) return;
		let cancelled = false;
		setState({ status: "loading" });
		loader().then(
			(data) => {
				if (!cancelled) setState({ status: "ready", data });
			},
			(error) => {
				if (!cancelled) setState({ status: "error", error });
			},
		);
		return () => {
			cancelled = true;
		};
		// The caller's deps decide when to reload; the loader itself is recreated every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, attempt, loader == null]);

	if (state.status === "ready")
		return { status: "ready", data: state.data, error: null, reload };
	if (state.status === "error")
		return { status: "error", data: null, error: state.error, reload };
	return { status: "loading", data: null, error: null, reload };
}
