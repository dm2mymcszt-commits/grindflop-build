/**
 * How the Stats page names people and opens their profiles. A chat deleted
 * from this device keeps no name, so a row without one asks Grindr — once per
 * visit — while it is on screen. Opening someone always lands on their profile
 * page, which says so itself when Grindr no longer shows the profile.
 */

import { createContext, useContext, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { KnownProfile } from "../../../utils/unavailableProfile";
import type { PersonLookup, PersonState } from "./statsGrindr";

export type StatsPeople = {
	lookUp: (profileId: string) => Promise<PersonLookup>;
	known: (profileId: string) => PersonLookup | null;
	/** The name the user gave them, if any: shown in place of their own. */
	nickname?: (profileId: string) => string | null;
	/** Opens their profile page, handing on what the row already shows. */
	open: (profileId: string, known?: KnownProfile) => Promise<PersonLookup>;
};

export const StatsPeopleContext = createContext<StatsPeople | null>(null);

export type PersonHandle = {
	lookup: PersonLookup | null;
	nickname: string | null;
	/** Waiting for Grindr to name someone this device has no name for. */
	naming: boolean;
	opening: boolean;
	/** Missing when there is nobody to open. */
	open: (() => void) | undefined;
};

/**
 * One person on the page. Grindr is asked straight away only when this device
 * has no name for them; otherwise only when they are opened.
 */
export function usePerson(
	profileId: string | null,
	localName: string | null | undefined,
	localImageHash?: string | null,
): PersonHandle {
	const people = useContext(StatsPeopleContext);
	const needsName = !localName?.trim();
	const [lookup, setLookup] = useState<PersonLookup | null>(() =>
		profileId && people ? people.known(profileId) : null,
	);
	const [opening, setOpening] = useState(false);

	useEffect(() => {
		if (!needsName || !profileId || !people) return;
		let cancelled = false;
		void people.lookUp(profileId).then((result) => {
			if (!cancelled) setLookup(result);
		});
		return () => {
			cancelled = true;
		};
	}, [needsName, people, profileId]);

	return {
		lookup,
		nickname: (profileId && people?.nickname?.(profileId)) || null,
		naming: needsName && profileId != null && people != null && !lookup,
		opening,
		open:
			profileId && people
				? () => {
						if (opening) return;
						setOpening(true);
						void people
							.open(profileId, { name: localName, imageHash: localImageHash })
							.then((result) => {
								setLookup(result);
								setOpening(false);
							});
					}
				: undefined,
	};
}

export function personDisplayName(
	t: TFunction,
	localName: string | null | undefined,
	person: PersonHandle,
): string {
	return (
		person.nickname ||
		localName?.trim() ||
		person.lookup?.name ||
		(person.naming ? "…" : t("stats.person.unknown", { defaultValue: "Unknown" }))
	);
}

/** Why their profile cannot be opened, or that you blocked them. */
export function personStateLabel(
	t: TFunction,
	state: PersonState | undefined,
): string | null {
	if (state === "deleted")
		return t("stats.person.deleted", { defaultValue: "profile deleted" });
	if (state === "blocked_you")
		return t("stats.person.blocked_you", { defaultValue: "blocked you" });
	if (state === "you_blocked")
		return t("stats.person.you_blocked", { defaultValue: "you blocked them" });
	return null;
}

/** A person's name inside a line of text, opening their profile when tapped. */
export function PersonLink({
	profileId,
	name,
	suffix,
}: {
	profileId: string | null;
	name: string | null | undefined;
	suffix?: string;
}) {
	const { t } = useTranslation();
	const person = usePerson(profileId, name);
	const text = [
		personDisplayName(t, name, person),
		personStateLabel(t, person.lookup?.state),
		suffix,
	]
		.filter(Boolean)
		.join(" · ");
	if (!person.open) return <>{text}</>;
	return (
		<button
			type="button"
			onClick={person.open}
			disabled={person.opening}
			className="max-w-full truncate align-bottom hover:text-[var(--accent)] disabled:opacity-60"
		>
			{text}
		</button>
	);
}
