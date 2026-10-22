import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../contexts/useAuth";
import { getKeywordAdviceTexts } from "../services/chatDb";
import { exportInterestViewRows } from "../services/interestViewsStore";
import {
	adviseKeyword,
	keywordAdviceId,
	prepareKeywordAdviceCorpus,
	type KeywordAdvice,
	type KeywordAdviceCorpus,
	type KeywordListKind,
} from "../utils/keywordAdvice";
import { keywordIdentity, type KeywordEntry } from "../utils/keywordList";
import { appLog } from "../utils/logger";

/** Keywords looked at per turn, so a long list never holds the screen up. */
const CHUNK = 20;

/**
 * What people wrote to this account and the names of those who wrote or
 * looked at the profile, read once per visit. Most keyword blocks are made on
 * a viewer's name, so the saved viewers are the larger half of this. Null
 * until it is read; advice that needs no history works without it.
 */
export function useKeywordAdviceCorpus(): KeywordAdviceCorpus | null {
	const { userId, settingsReady } = useAuth();
	const [corpus, setCorpus] = useState<KeywordAdviceCorpus | null>(null);

	useEffect(() => {
		setCorpus(null);
		if (!settingsReady) return;
		let cancelled = false;
		void Promise.all([
			getKeywordAdviceTexts(userId != null ? Number(userId) : null),
			exportInterestViewRows().catch(() => null),
		])
			.then(([texts, viewers]) => {
				if (cancelled) return;
				// By profile id: someone who looked at both accounts counts once.
				const viewerNames = new Map(Object.entries(texts.viewerNames));
				for (const viewer of viewers ?? []) {
					const name = viewer.displayName?.trim();
					if (name) viewerNames.set(viewer.profileId, name);
				}
				setCorpus(
					prepareKeywordAdviceCorpus({
						people: texts.people,
						names: [...texts.names, ...viewerNames.values()],
					}),
				);
			})
			.catch((error) => {
				appLog.warn("[keyword-advice] could not read the message history", error);
			});
		return () => {
			cancelled = true;
		};
	}, [settingsReady, userId]);

	return corpus;
}

/**
 * Advice for the entries of one list, by keyword identity, leaving out what
 * the user answered "it's intended" to. Worked out a few keywords at a time
 * and remembered, so an edit only looks at what changed.
 */
export function useKeywordAdvice(
	entries: readonly KeywordEntry[],
	list: KeywordListKind,
	corpus: KeywordAdviceCorpus | null,
	dismissed: readonly string[],
): ReadonlyMap<string, KeywordAdvice> {
	const cache = useRef<{ corpus: KeywordAdviceCorpus | null; byKey: Map<string, KeywordAdvice | null> }>({
		corpus: null,
		byKey: new Map(),
	});
	const [version, setVersion] = useState(0);

	useEffect(() => {
		if (cache.current.corpus !== corpus) {
			cache.current = { corpus, byKey: new Map() };
		}
		const byKey = cache.current.byKey;
		const pending = entries.filter((entry) => !byKey.has(`${entry.mode}:${entry.text}`));
		if (pending.length === 0) {
			setVersion((current) => current + 1);
			return;
		}
		let cancelled = false;
		let index = 0;
		let timer = 0;
		const work = () => {
			if (cancelled) return;
			for (const entry of pending.slice(index, index + CHUNK)) {
				byKey.set(`${entry.mode}:${entry.text}`, adviseKeyword(entry, list, corpus));
			}
			index += CHUNK;
			if (index < pending.length) {
				timer = window.setTimeout(work, 0);
			} else {
				setVersion((current) => current + 1);
			}
		};
		timer = window.setTimeout(work, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [entries, list, corpus]);

	return useMemo(() => {
		const hidden = new Set(dismissed);
		const result = new Map<string, KeywordAdvice>();
		for (const entry of entries) {
			const advice = cache.current.byKey.get(`${entry.mode}:${entry.text}`);
			if (advice && !hidden.has(keywordAdviceId(list, entry, advice))) {
				result.set(keywordIdentity(entry.text), advice);
			}
		}
		return result;
		// `version` says the cache moved on; the cache itself is a ref.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entries, list, dismissed, version]);
}
