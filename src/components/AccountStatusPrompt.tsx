import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Ban, Clock, Copy, KeyRound, ShieldAlert, WifiOff } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "../contexts/useAuth";
import type { AccountNotice } from "../contexts/auth-context";
import { formatFullDateTime } from "../pages/app/chat/chatUtils";
import { expiryToMillis, humanizeCode } from "../utils/accountStatus";
import { Button } from "./ui/button";

type Detail = { label: string; value: string };

type Content = {
	icon: ReactNode;
	title: string;
	description: string;
	details: Detail[];
	/** Signing out and in again is what may help, so that button comes first. */
	signOutFirst: boolean;
};

const ICON_CLASS = "h-9 w-9 text-[var(--accent)]";

function regionLabel(region: string, t: TFunction): string | null {
	switch (region) {
		case "uk":
			return t("account_status.regions.uk", { defaultValue: "United Kingdom" });
		case "br":
			return t("account_status.regions.br", { defaultValue: "Brazil" });
		case "au":
			return t("account_status.regions.au", { defaultValue: "Australia" });
		case "us":
			return t("account_status.regions.us", { defaultValue: "United States" });
		default:
			return null;
	}
}

/** The rows a ban and a timed ban share: why, in more detail, and whether a machine decided. */
function reasonRows(
	reason: string | null | undefined,
	subReason: string | null | undefined,
	automated: boolean | null | undefined,
	t: TFunction,
): Detail[] {
	const rows: Detail[] = [];
	if (reason) {
		rows.push({
			label: t("account_status.details.reason", { defaultValue: "Reason" }),
			value: humanizeCode(reason),
		});
	}
	if (subReason) {
		rows.push({
			label: t("account_status.details.sub_reason", { defaultValue: "Sub-reason" }),
			value: humanizeCode(subReason),
		});
	}
	if (automated != null) {
		rows.push({
			label: t("account_status.details.automated", { defaultValue: "Automated" }),
			value: automated
				? t("account_status.details.yes", { defaultValue: "Yes" })
				: t("account_status.details.no", { defaultValue: "No" }),
		});
	}
	return rows;
}

function contentFor(notice: AccountNotice, t: TFunction): Content {
	const { status } = notice;

	if (status.kind === "sessionExpired") {
		return {
			icon: <KeyRound className={ICON_CLASS} />,
			title: t("account_status.session_expired.title", { defaultValue: "Sign in again" }),
			description: t("account_status.session_expired.description", {
				defaultValue:
					"This account was signed in with a token, and the token has run out. Grindr gave the app no way to renew it, so nothing will load until you sign in again.",
			}),
			details: [],
			signOutFirst: true,
		};
	}

	if (status.kind === "banned") {
		const { info } = status;
		const details: Detail[] = [
			{
				label: t("account_status.details.answer", { defaultValue: "Grindr's answer" }),
				value: info.message ? `${info.message} (${info.code})` : String(info.code),
			},
			...reasonRows(info.reason, info.subReason, info.automated, t),
		];

		// Code 28 reads ACCOUNT_BANNED and is often nothing of the kind: Grindr
		// answers with it when it does not trust the request itself. Calling
		// it a ban would frighten someone whose account is fine.
		if (info.kind === "device") {
			return {
				icon: <ShieldAlert className={ICON_CLASS} />,
				title: t("account_status.device.title", { defaultValue: "Grindr refused the request" }),
				description:
					notice.about === "signIn"
						? t("account_status.device.description_sign_in", {
								defaultValue:
									"Grindr answered this sign-in with ACCOUNT_BANNED (code 28). That is often not a ban at all: it is also how Grindr turns down a request it does not trust, and an unofficial app is the usual reason. Every attempt here goes out as a new device, so trying again sometimes works. If the account still opens in the official Grindr app, it is not banned.",
							})
						: t("account_status.device.description_session", {
								defaultValue:
									"Grindr answered with ACCOUNT_BANNED (code 28) when the app renewed your session. That is often not a ban at all: it is also how Grindr turns down a request it does not trust, and an unofficial app is the usual reason. Signing out and in again goes out as a new device, which sometimes works. If the account still opens in the official Grindr app, it is not banned.",
							}),
				details,
				signOutFirst: true,
			};
		}

		if (info.kind === "network") {
			return {
				icon: <WifiOff className={ICON_CLASS} />,
				title: t("account_status.network.title", { defaultValue: "Grindr refused this network" }),
				description: t("account_status.network.description", {
					defaultValue:
						"Grindr will not accept a sign-in from the connection you are on. A VPN, a proxy or a shared network is the usual cause. Try again on another connection.",
				}),
				details,
				signOutFirst: false,
			};
		}

		if (info.kind === "underage") {
			return {
				icon: <Ban className={ICON_CLASS} />,
				title: t("account_status.underage.title", { defaultValue: "Account banned" }),
				description: t("account_status.underage.description", {
					defaultValue:
						"Grindr has banned this account because it holds that its owner is under 18. Only Grindr can review that.",
				}),
				details,
				signOutFirst: false,
			};
		}

		return {
			icon: <Ban className={ICON_CLASS} />,
			title: t("account_status.banned.title", { defaultValue: "Account banned" }),
			description: t("account_status.banned.description", {
				defaultValue:
					"Grindr has banned this account. It cannot be used until Grindr lifts the ban, and only Grindr can do that.",
			}),
			details,
			signOutFirst: false,
		};
	}

	const { restriction } = status;

	if (restriction.kind === "ageVerification") {
		const details: Detail[] = [];
		const region = restriction.region ? regionLabel(restriction.region, t) : null;
		if (region) {
			details.push({
				label: t("account_status.details.region", { defaultValue: "Region" }),
				value: region,
			});
		} else if (restriction.reason) {
			// Not one of the regional checks, so Grindr's own reason is all there is.
			details.push({
				label: t("account_status.details.reason", { defaultValue: "Reason" }),
				value: humanizeCode(restriction.reason),
			});
		}
		return {
			icon: <ShieldAlert className={ICON_CLASS} />,
			title: t("account_status.age_verification.title", {
				defaultValue: "Age verification required",
			}),
			description: t("account_status.age_verification.description", {
				defaultValue:
					"Grindr wants this account to prove its age before it can be used. That is done in the official Grindr app. This app does not get around age verification.",
			}),
			details,
			signOutFirst: false,
		};
	}

	if (restriction.kind === "timedBan") {
		const details = reasonRows(restriction.reason, restriction.subReason, restriction.automated, t);
		const endsAt = expiryToMillis(restriction.expiresAt);
		if (endsAt !== null) {
			details.push({
				label: t("account_status.details.banned_until", { defaultValue: "Banned until" }),
				value: formatFullDateTime(endsAt),
			});
		}
		return {
			icon: <Clock className={ICON_CLASS} />,
			title: t("account_status.timed_ban.title", { defaultValue: "Temporarily banned" }),
			description: t("account_status.timed_ban.description", {
				defaultValue:
					"Grindr has banned this account for a limited time. It works again once the ban has run out.",
			}),
			details,
			signOutFirst: false,
		};
	}

	// A vendor's rejection, whose reason is a sentence of its own, and anything
	// Grindr adds later: shown under the name it came with.
	const details: Detail[] = [];
	if (restriction.kind === "other" && restriction.code) {
		details.push({
			label: t("account_status.details.restriction", { defaultValue: "Restriction" }),
			value: humanizeCode(restriction.code),
		});
	}
	if (restriction.reason) {
		details.push({
			label: t("account_status.details.reason", { defaultValue: "Reason" }),
			value: humanizeCode(restriction.reason),
		});
	}
	return {
		icon: <ShieldAlert className={ICON_CLASS} />,
		title: t("account_status.restricted.title", { defaultValue: "Account restricted" }),
		description: t("account_status.restricted.description", {
			defaultValue:
				"Grindr has put a restriction on this account, and most of the app will not work while it lasts. The official Grindr app says what it wants from you.",
		}),
		details,
		signOutFirst: false,
	};
}

export function AccountStatusPrompt({
	notice,
	onDismiss,
	onSignOut,
}: {
	notice: AccountNotice;
	onDismiss: () => void;
	onSignOut: () => Promise<void>;
}) {
	const { t } = useTranslation();
	const titleId = useId();
	const descriptionId = useId();
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const textAreaRef = useRef<HTMLDivElement | null>(null);
	const firstActionRef = useRef<HTMLButtonElement | null>(null);
	const [isSigningOut, setIsSigningOut] = useState(false);

	const content = contentFor(notice, t);
	const aboutSession = notice.about === "session";

	// The notice takes the keyboard while it is up and hands it back after.
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		firstActionRef.current?.focus({ preventScroll: true });
		return () => {
			if (previous?.isConnected) {
				previous.focus({ preventScroll: true });
			}
		};
	}, []);

	// The page underneath stays where it is while the notice covers it. A wheel
	// turn or a drag that the notice's own text has no use for would otherwise
	// be handed on to the page.
	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) {
			return;
		}

		const keepPageStill = (event: Event) => {
			const textArea = textAreaRef.current;
			const scrollsTheText =
				textArea !== null &&
				event.target instanceof Node &&
				textArea.contains(event.target) &&
				textArea.scrollHeight > textArea.clientHeight;
			if (!scrollsTheText) {
				event.preventDefault();
			}
		};

		// Not passive, or the browser scrolls before it asks.
		overlay.addEventListener("wheel", keepPageStill, { passive: false });
		overlay.addEventListener("touchmove", keepPageStill, { passive: false });
		return () => {
			overlay.removeEventListener("wheel", keepPageStill);
			overlay.removeEventListener("touchmove", keepPageStill);
		};
	}, []);

	// Escape puts the notice away, as its button does, Tab stays inside it,
	// and the keys that scroll move its own text. Taken before the page sees
	// the key and marked as handled: the page underneath goes back a screen
	// on Escape and would scroll on the others.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				if (!isSigningOut) {
					onDismiss();
				}
				return;
			}

			const textArea = textAreaRef.current;
			const scrollStep: Record<string, number> = {
				ArrowDown: 48,
				ArrowUp: -48,
				PageDown: (textArea?.clientHeight ?? 0) * 0.9,
				PageUp: (textArea?.clientHeight ?? 0) * -0.9,
				End: textArea?.scrollHeight ?? 0,
				Home: -(textArea?.scrollHeight ?? 0),
			};
			if (event.key in scrollStep) {
				event.preventDefault();
				event.stopPropagation();
				textArea?.scrollBy({ top: scrollStep[event.key] });
				return;
			}

			if (event.key !== "Tab") {
				return;
			}

			const card = cardRef.current;
			const buttons = Array.from(
				card?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
			);
			if (buttons.length === 0) {
				return;
			}
			const first = buttons[0];
			const last = buttons[buttons.length - 1];
			const active = document.activeElement;
			if (!card?.contains(active)) {
				event.preventDefault();
				first.focus();
			} else if (event.shiftKey && active === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		};

		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onDismiss, isSigningOut]);

	const copyDetails = async () => {
		try {
			await navigator.clipboard.writeText(JSON.stringify(notice.status, null, 2));
			toast.success(t("account_status.actions.copied", { defaultValue: "Details copied" }));
		} catch {
			toast.error(
				t("account_status.actions.copy_failed", { defaultValue: "Could not copy the details" }),
			);
		}
	};

	const signOut = async () => {
		setIsSigningOut(true);
		try {
			await onSignOut();
		} catch {
			// The sign-out itself reports what went wrong; the notice stays up.
		} finally {
			setIsSigningOut(false);
		}
	};

	const signOutButton = (first: boolean) => (
		<Button
			ref={first ? firstActionRef : undefined}
			type="button"
			variant={first ? "primary" : "secondary"}
			size="lg"
			className="w-full"
			loading={isSigningOut}
			onClick={() => void signOut()}
		>
			{t("account_status.actions.sign_out", { defaultValue: "Sign out" })}
		</Button>
	);

	const dismissButton = (first: boolean) => (
		<Button
			ref={first ? firstActionRef : undefined}
			type="button"
			variant={first ? "primary" : "secondary"}
			size="lg"
			className="w-full"
			disabled={isSigningOut}
			onClick={onDismiss}
		>
			{aboutSession
				? t("account_status.actions.continue", { defaultValue: "Continue to the app" })
				: t("account_status.actions.back_to_sign_in", { defaultValue: "Back to sign-in" })}
		</Button>
	);

	return (
		<div
			ref={overlayRef}
			className="fixed inset-0 z-[200] flex flex-col bg-[var(--bg)] sm:items-center sm:justify-center sm:bg-black/55 sm:p-4"
			data-lenis-prevent
		>
			<div
				ref={cardRef}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				className="flex min-h-0 flex-1 flex-col sm:max-h-[min(90vh,46rem)] sm:w-full sm:max-w-[30rem] sm:flex-none sm:overflow-hidden sm:rounded-3xl sm:border sm:border-[var(--border)] sm:bg-[var(--surface)] sm:shadow-2xl"
			>
				<div
					ref={textAreaRef}
					className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-7 sm:px-9"
					style={{ paddingTop: "max(56px, calc(env(safe-area-inset-top) + 24px))" }}
				>
					{/* Centred while there is room, and scrolled from the top when there is not. */}
					<div className="my-auto flex flex-col items-center pb-5 text-center">
						<div className="mb-5 flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
							{content.icon}
						</div>
						<h1 id={titleId} className="text-2xl font-bold text-[var(--text)]">
							{content.title}
						</h1>
						<p
							id={descriptionId}
							className="mt-2 max-w-sm text-sm leading-relaxed text-[var(--text-muted)]"
						>
							{content.description}
						</p>
						{content.details.length > 0 && (
							<>
								<dl className="mt-5 w-full max-w-sm divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-left text-sm">
									{content.details.map((detail) => (
										<div
											key={detail.label}
											className="flex items-baseline justify-between gap-4 px-4 py-2.5"
										>
											<dt className="shrink-0 text-[var(--text-muted)]">{detail.label}</dt>
											<dd className="min-w-0 break-words text-right font-medium text-[var(--text)]">
												{detail.value}
											</dd>
										</div>
									))}
								</dl>
								<button
									type="button"
									onClick={() => void copyDetails()}
									className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-[var(--text-muted)] transition hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
								>
									<Copy className="h-3.5 w-3.5" />
									{t("account_status.actions.copy_details", { defaultValue: "Copy details" })}
								</button>
							</>
						)}
					</div>
				</div>

				<div
					className="flex shrink-0 flex-col gap-2 px-6 pt-2"
					style={{ paddingBottom: "max(24px, calc(env(safe-area-inset-bottom) + 12px))" }}
				>
					{!aboutSession ? (
						dismissButton(true)
					) : content.signOutFirst ? (
						<>
							{signOutButton(true)}
							{dismissButton(false)}
						</>
					) : (
						<>
							{dismissButton(true)}
							{signOutButton(false)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Puts what Grindr said about an account over whatever page is open: a ban, a
 * restriction, a token sign-in that has run out.
 *
 * It lies on top of the app instead of standing in for it, and always offers
 * a way past. The answer can be wrong, as the "ban" Grindr gives a request it
 * distrusts often is, and an account that really is banned still has its
 * chats saved on this device. A screen with no way out would shut the user
 * out of both.
 */
export function AccountStatusGate() {
	const { accountNotice, dismissAccountNotice, logout } = useAuth();

	if (!accountNotice) {
		return null;
	}

	return (
		<AccountStatusPrompt
			notice={accountNotice}
			onDismiss={dismissAccountNotice}
			onSignOut={logout}
		/>
	);
}
