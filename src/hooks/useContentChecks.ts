import { useEffect, useState } from "react";
import {
	EXPLICIT_FILTER_UPDATED_EVENT,
	isExplicitFilterEnabled,
	subscribeToContentChecks,
} from "../services/contentCheck";

/**
 * Re-renders the calling component whenever a photo check lands or the
 * explicit-photo filter is switched, so a cover comes off (or goes on)
 * without the list having to await anything. Returns whether the filter is on.
 */
export function useContentChecks(): boolean {
	const [, setTick] = useState(0);
	useEffect(() => {
		const bump = () => setTick((tick) => tick + 1);
		const unsubscribe = subscribeToContentChecks(bump);
		window.addEventListener(EXPLICIT_FILTER_UPDATED_EVENT, bump);
		return () => {
			unsubscribe();
			window.removeEventListener(EXPLICIT_FILTER_UPDATED_EVENT, bump);
		};
	}, []);
	return isExplicitFilterEnabled();
}
