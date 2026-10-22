import { useEffect, useState } from "react";
import { getActiveChatDbUser, getAllPastContacts } from "./chatDb";
import { appLog } from "../utils/logger";
import type { PastContact } from "../utils/pastContactRules";

/**
 * The active account's per-person history from an earlier account, held in
 * memory so a chat, inbox row or profile can look someone up without a
 * query. About eleven thousand small rows for this user, read once per
 * account and again after Drive sync or a move changes them.
 */

type Loaded = { account: number | null; byProfile: Map<string, PastContact> };

let loaded: Loaded | null = null;
let pending: { account: number | null; promise: Promise<Map<string, PastContact>> } | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

function loadPastContacts(): Promise<Map<string, PastContact>> {
	const account = getActiveChatDbUser();
	if (loaded && loaded.account === account) return Promise.resolve(loaded.byProfile);
	if (pending && pending.account === account) return pending.promise;

	const startedAt = generation;
	const promise = getAllPastContacts()
		.then((contacts) => {
			const byProfile = new Map(contacts.map((contact) => [contact.profileId, contact]));
			// A reload asked for while this read ran would otherwise be undone.
			if (startedAt === generation && getActiveChatDbUser() === account) {
				loaded = { account, byProfile };
			}
			return byProfile;
		})
		.catch((error) => {
			appLog.warn("[past-contacts] load failed", error);
			return new Map<string, PastContact>();
		})
		.finally(() => {
			if (pending?.promise === promise) pending = null;
		});
	pending = { account, promise };
	return promise;
}

/** Drops what is held and tells every open screen to look again. */
export async function reloadPastContacts(): Promise<void> {
	generation += 1;
	loaded = null;
	pending = null;
	await loadPastContacts();
	notify();
}

/**
 * The earlier account's history with this person, or null when there is
 * none. `ready` should be the auth context's settingsReady, so nothing is
 * read while the database still points at the previous account.
 */
export function usePastContact(
	profileId: string | number | null | undefined,
	ready: boolean,
): PastContact | null {
	const key = profileId == null ? null : String(profileId);
	const [contact, setContact] = useState<PastContact | null>(null);
	const [version, setVersion] = useState(0);

	useEffect(() => {
		const listener = () => setVersion((value) => value + 1);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	useEffect(() => {
		if (!ready || key == null) {
			setContact(null);
			return;
		}
		let cancelled = false;
		void loadPastContacts().then((byProfile) => {
			if (!cancelled) setContact(byProfile.get(key) ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [key, ready, version]);

	return contact;
}
