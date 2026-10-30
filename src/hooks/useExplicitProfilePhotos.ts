import { useEffect, useState } from "react";
import { EXPLICIT_FILTER_UPDATED_EVENT } from "../services/contentCheck";
import {
	backfillExplicitProfilePhotos,
	subscribeToExplicitProfilePhotos,
} from "../services/explicitProfilePhotos";

/**
 * Re-renders the calling component when a profile photo is found explicit,
 * is shown anyway, or the filter is switched, so a screen that draws profile
 * photos itself can swap the explicit ones for the hidden tile. Also makes
 * sure the ones on record from earlier sessions are loaded.
 */
export function useExplicitProfilePhotos(): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		backfillExplicitProfilePhotos();
		const bump = () => setTick((tick) => tick + 1);
		const unsubscribe = subscribeToExplicitProfilePhotos(bump);
		window.addEventListener(EXPLICIT_FILTER_UPDATED_EVENT, bump);
		return () => {
			unsubscribe();
			window.removeEventListener(EXPLICIT_FILTER_UPDATED_EVENT, bump);
		};
	}, []);
}
