import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The way back for anything the explicit-photo filter is holding back.
 * Takes two taps, a few seconds apart at most, so a stray one never shows
 * what was hidden.
 */
export function ShowAnywayButton({ onShow, className }: { onShow: () => void; className?: string }) {
	const { t } = useTranslation();
	const [armed, setArmed] = useState(false);

	useEffect(() => {
		if (!armed) return;
		const timer = setTimeout(() => setArmed(false), 4000);
		return () => clearTimeout(timer);
	}, [armed]);

	return (
		<button
			type="button"
			onClick={(event) => {
				event.stopPropagation();
				if (!armed) {
					setArmed(true);
					return;
				}
				setArmed(false);
				onShow();
			}}
			className={`shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text)] transition hover:border-[var(--accent)] ${className ?? ""}`}
		>
			{armed
				? t("explicit_filter.tap_again", { defaultValue: "Tap again to show" })
				: t("explicit_filter.show_anyway", { defaultValue: "Show anyway" })}
		</button>
	);
}
