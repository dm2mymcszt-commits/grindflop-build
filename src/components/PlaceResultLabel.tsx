import { useTranslation } from "react-i18next";
import type { PlaceResult } from "../services/placeSearch";

/** The two lines of a place suggestion: its name, then what it is and where. */
export function PlaceResultLabel({ place }: { place: PlaceResult }) {
	const { t } = useTranslation();
	return (
		<span className="min-w-0 flex-1">
			<span className="block truncate text-sm font-semibold text-[var(--text)]">{place.title}</span>
			<span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
				{[t(`browse_location.place_kind.${place.kind}`), place.context].filter(Boolean).join(" · ")}
			</span>
		</span>
	);
}
