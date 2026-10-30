import { useEffect, useState } from "react";
import { Calculator, CloudSun, Ghost, StickyNote, VenetianMask, type LucideIcon } from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { Chip } from "../ui/chip";
import {
	type AppDisguiseId,
	type AppDisguiseState,
	mayHaveAppDisguise,
	onAppDisguiseState,
	requestAppDisguiseState,
	setAppDisguise,
} from "../../utils/appDisguise";

const OPTIONS: { id: AppDisguiseId; icon: LucideIcon; labelKey: string }[] = [
	{ id: "default", icon: Ghost, labelKey: "privacy.app_disguise_off" },
	{ id: "calculator", icon: Calculator, labelKey: "privacy.app_disguise_calculator" },
	{ id: "notes", icon: StickyNote, labelKey: "privacy.app_disguise_notes" },
	{ id: "weather", icon: CloudSun, labelKey: "privacy.app_disguise_weather" },
];

/**
 * Lets the home screen icon be swapped for a decoy. Draws nothing until the
 * native side has said this device can do it, so it only ever shows on an
 * iPhone running a build that carries the icons.
 */
export function AppDisguiseCard({ id }: { id?: string }) {
	const { t } = useTranslation();
	const [state, setState] = useState<AppDisguiseState | null>(null);
	// The choice just tapped, shown at once while iOS makes the change.
	const [pending, setPending] = useState<AppDisguiseId | null>(null);

	useEffect(() => {
		if (!mayHaveAppDisguise()) {
			return;
		}
		const stop = onAppDisguiseState((next) => {
			setState(next);
			setPending(null);
			if (next.failed) {
				toast.error(t("privacy.app_disguise_failed"));
			}
		});
		requestAppDisguiseState();
		return stop;
	}, [t]);

	// Should iOS never say what came of a change, the choices are not left
	// greyed out for good: ask again what is on.
	useEffect(() => {
		if (pending == null) {
			return;
		}
		const giveUp = window.setTimeout(() => {
			setPending(null);
			requestAppDisguiseState();
		}, 8_000);
		return () => window.clearTimeout(giveUp);
	}, [pending]);

	if (!state?.supported) {
		return null;
	}

	const shown = pending ?? state.current;

	return (
		<div>
			<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
				{t("privacy.app_disguise")}
			</p>
			<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
				<div id={id} className="flex items-start gap-3 px-4 py-3.5">
					<div className="shrink-0 rounded-2xl bg-slate-500/15 p-2.5 text-slate-400">
						<VenetianMask className="h-5 w-5" />
					</div>
					<div className="min-w-0 flex-1">
						<p className="text-sm font-semibold leading-snug">{t("privacy.app_disguise")}</p>
						<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
							{t("privacy.app_disguise_desc")}
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{OPTIONS.map(({ id: option, icon: Icon, labelKey }) => (
								<Chip
									key={option}
									selected={shown === option}
									aria-pressed={shown === option}
									disabled={pending != null}
									onClick={() => {
										if (option === shown) {
											return;
										}
										setPending(option);
										setAppDisguise(option);
									}}
									className="inline-flex items-center gap-1.5"
								>
									<Icon className="h-4 w-4" />
									{t(labelKey)}
								</Chip>
							))}
						</div>
					</div>
				</div>
				<div className="px-4 py-3">
					<p className="text-xs leading-relaxed text-[var(--text-muted)]">{t("privacy.app_disguise_note")}</p>
				</div>
			</div>
		</div>
	);
}
