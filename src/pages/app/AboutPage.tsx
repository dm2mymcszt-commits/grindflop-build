import {
	LockKeyhole,
	Rocket,
	Shield,
	Users,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { Card } from "../../components/ui/card";
import { Badge } from "../../components/ui/chip";
import { BackToSettings } from "../../components/BackToSettings";
import { usePreferences } from "../../contexts/PreferencesContext";

const DEV_TAP_TARGET = 7;

export function AboutPage() {
	const { t } = useTranslation();
	const { developerMode, setPreferences } = usePreferences();
	const appVersion = import.meta.env.VITE_APP_VERSION;
	const [devTapCount, setDevTapCount] = useState(0);
	const [lastDevTapAt, setLastDevTapAt] = useState(0);

	const handleVersionTap = () => {
		const now = Date.now();
		const withinWindow = now - lastDevTapAt < 3000;
		const nextCount = withinWindow ? devTapCount + 1 : 1;
		setDevTapCount(nextCount);
		setLastDevTapAt(now);

		const remaining = DEV_TAP_TARGET - nextCount;
		if (remaining <= 0) {
			const nextMode = !developerMode;
			void setPreferences({ developerMode: nextMode });
			toast.success(
				nextMode ? t("about_page.dev_mode_enabled") : t("about_page.dev_mode_disabled"),
			);
			setDevTapCount(0);
			setLastDevTapAt(0);
			return;
		}

		if (remaining <= 3) {
			toast(
				developerMode
					? t("about_page.dev_taps_disable", { count: remaining })
					: t("about_page.dev_taps_enable", { count: remaining }),
			);
		}
	};

	return (
		<section className="app-screen">
			<div className="mx-auto grid w-full max-w-6xl gap-6">
				<header className="grid gap-4">
					<BackToSettings />

					<Card className="overflow-hidden p-0">
						<div className="grid gap-0 lg:grid-cols-[1.25fr_0.75fr]">
							<div className="grid gap-5 p-6 sm:p-8">
								<div className="flex flex-wrap items-center gap-2">
									<Badge>{t("about_page.badge")}</Badge>
									<button
										type="button"
										onClick={handleVersionTap}
										className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-xs font-semibold text-[var(--text-muted)] transition hover:text-[var(--text)]"
									>
										v{appVersion}
									</button>
								</div>

								<div className="grid gap-3">
									<h1 className="app-title max-w-[14ch]">
										{t("about_page.title")}
									</h1>
									<p className="max-w-[68ch] text-sm leading-6 text-[var(--text-muted)] sm:text-base">
										{t("about_page.description")}
									</p>
								</div>

								<div className="grid gap-3 sm:grid-cols-2">
									<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
										<p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
											{t("about_page.platform")}
										</p>
										<p className="mt-1 text-base font-semibold">Tauri + React</p>
									</div>
									<div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
										<p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
											{t("about_page.licence")}
										</p>
										<p className="mt-1 text-base font-semibold">
											{t("about_page.licence_value")}
										</p>
									</div>
								</div>
							</div>

							<div className="grid gap-4 border-t border-[var(--border)] bg-[var(--surface-2)] p-6 sm:p-8 lg:border-l lg:border-t-0">
								<div className="rounded-2xl bg-[var(--surface)] p-4">
									<p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
										{t("about_page.maintainer")}
									</p>
									<p className="mt-2 text-lg font-semibold leading-snug">
										GrindFlop
									</p>
									<p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
										{t("about_page.maintainer_credit")}
									</p>
								</div>

								<div className="rounded-2xl bg-[var(--surface)] p-4">
									<div className="flex items-start gap-3">
										<div className="rounded-xl bg-[var(--surface-2)] p-2.5 text-[var(--text)]">
											<Shield className="h-5 w-5" />
										</div>
										<p className="text-sm leading-6 text-[var(--text-muted)]">
											{t("about_page.commercial_note")}
										</p>
									</div>
								</div>
							</div>
						</div>
					</Card>
				</header>

				<Card className="p-5 sm:p-6">
					<h2 className="text-lg font-semibold">
						{t("about_page.principles_title")}
					</h2>
					<div className="mt-4 grid gap-3">
						<div className="rounded-2xl bg-[var(--surface-2)] p-4">
							<div className="flex items-start gap-3">
								<LockKeyhole className="mt-0.5 h-4.5 w-4.5 text-[var(--text)]" />
								<div className="grid gap-1">
									<p className="text-sm font-semibold">
										{t("about_page.principles.privacy_title")}
									</p>
									<p className="text-sm leading-6 text-[var(--text-muted)]">
										{t("about_page.principles.privacy_desc")}
									</p>
								</div>
							</div>
						</div>
						<div className="rounded-2xl bg-[var(--surface-2)] p-4">
							<div className="flex items-start gap-3">
								<Users className="mt-0.5 h-4.5 w-4.5 text-[var(--text)]" />
								<div className="grid gap-1">
									<p className="text-sm font-semibold">
										{t("about_page.principles.community_title")}
									</p>
									<p className="text-sm leading-6 text-[var(--text-muted)]">
										{t("about_page.principles.community_desc")}
									</p>
								</div>
							</div>
						</div>
						<div className="rounded-2xl bg-[var(--surface-2)] p-4">
							<div className="flex items-start gap-3">
								<Rocket className="mt-0.5 h-4.5 w-4.5 text-[var(--text)]" />
								<div className="grid gap-1">
									<p className="text-sm font-semibold">
										{t("about_page.principles.roadmap_title")}
									</p>
									<p className="text-sm leading-6 text-[var(--text-muted)]">
										{t("about_page.principles.roadmap_desc")}
									</p>
								</div>
							</div>
						</div>
					</div>
				</Card>
			</div>
		</section>
	);
}
