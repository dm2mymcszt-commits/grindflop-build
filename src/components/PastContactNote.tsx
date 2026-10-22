import { useState } from "react";
import { ChevronDown, History } from "lucide-react";
import { useAuth } from "../contexts/useAuth";
import { usePastContact } from "../services/pastContacts";
import { describePastContact, type PastContact } from "../utils/pastContactRules";
import { cn } from "../utils/cn";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";

function formatPastTime(timestamp: number): string {
	return `${formatPastDate(timestamp)} ${new Date(timestamp).toLocaleTimeString(i18n.language, {
		hour: "2-digit",
		minute: "2-digit",
	})}`;
}

function formatPastDate(timestamp: number): string {
	const date = new Date(timestamp);
	const sameYear = date.getFullYear() === new Date().getFullYear();
	return (
		date
			// In the app's language, not the system's: the date goes into a sentence.
			.toLocaleDateString(i18n.language, {
				day: "numeric",
				month: "short",
				...(sameYear ? {} : { year: "numeric" }),
			})
			// Some languages abbreviate with a full stop ("20 sept."), and the
			// sentences these dates go into end with their own.
			.replace(/\.$/, "")
	);
}

type Tone = "blocked" | "unanswered" | "talked";

function toneOf(contact: PastContact): Tone {
	if (contact.blockedByMeAt != null || contact.blockedMeAt != null) return "blocked";
	return contact.myMessages > 0 ? "talked" : "unanswered";
}

const TONE_TEXT: Record<Tone, string> = {
	blocked: "text-red-400",
	unanswered: "text-amber-400",
	talked: "text-emerald-400",
};

/**
 * What an earlier account on this device knew about this person: whether
 * they wrote, whether they got an answer, who blocked whom.
 *
 * - `banner`: one tappable line that opens the details, for the chat and
 *   the profile.
 * - `icon`: a small coloured clock beside a name, for inbox rows.
 */
export function PastContactNote({
	profileId,
	variant,
	className,
}: {
	profileId: string | number | null | undefined;
	variant: "banner" | "icon";
	className?: string;
}) {
	const { t } = useTranslation();
	const { settingsReady } = useAuth();
	const contact = usePastContact(profileId, settingsReady);
	const [isOpen, setIsOpen] = useState(false);
	const [showMessages, setShowMessages] = useState(false);

	if (!contact) return null;
	const summary = describePastContact(contact, formatPastDate);
	const tone = toneOf(contact);

	if (variant === "icon") {
		return (
			<span title={summary.badge} aria-label={summary.badge}>
				<History className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT[tone], className)} />
			</span>
		);
	}

	return (
		<div className={cn("rounded-xl bg-[var(--surface-2)] text-xs", className)}>
			<button
				type="button"
				onClick={() => setIsOpen((open) => !open)}
				aria-expanded={isOpen}
				className="flex w-full items-center gap-2 px-3 py-2 text-left"
			>
				<History className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT[tone])} />
				<span className="min-w-0 flex-1 truncate font-semibold text-[var(--text)]">{summary.badge}</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform",
						isOpen && "rotate-180",
					)}
				/>
			</button>
			{isOpen ? (
				<div className="px-3 pb-2.5 pl-[2.1rem]">
					<ul className="space-y-1 leading-snug text-[var(--text-muted)]">
						{summary.lines.map((line) => (
							<li key={line} className="break-words">
								{line}
							</li>
						))}
					</ul>
					{contact.messages.length > 0 ? (
						<>
							<button
								type="button"
								onClick={() => setShowMessages((shown) => !shown)}
								className="mt-2 font-semibold text-[var(--accent)]"
							>
								{showMessages
									? t("past_contact.hide_messages")
									: t("past_contact.show_messages", { count: contact.messages.length })}
							</button>
							{showMessages ? (
								// Read-only: this conversation belonged to the old account,
								// so nothing here can be answered.
								<div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-1" data-lenis-prevent>
									{contact.messages.map((message, index) => (
										<div
											key={`${message.at}-${index}`}
											className={cn("flex flex-col", message.mine ? "items-end" : "items-start")}
										>
											<span
												className={cn(
													"max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[var(--text)]",
													message.mine ? "bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]" : "bg-[var(--surface)]",
												)}
											>
												{message.text}
											</span>
											<span className="mt-0.5 text-[10px] text-[var(--text-muted)]">
												{formatPastTime(message.at)}
											</span>
										</div>
									))}
								</div>
							) : null}
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}
