import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
} from "react";
import { AlertTriangle, Check, Download, Lightbulb, Plus, Search, Trash2, Upload, X } from "lucide-react";
import toast from "react-hot-toast";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ConfirmDialog } from "./confirm-dialog";
import { SegmentedChoice } from "./segmented-choice";
import {
	addKeywords,
	canMatchAnywhere,
	findKeyword,
	keywordIdentity,
	keywordsFromInput,
	keywordsFromPastedList,
	readKeywordFile,
	serializeKeywordList,
	type KeywordEntry,
	type KeywordMatchMode,
} from "../../utils/keywordList";
import { quickKeywordAdvice, type KeywordAdvice } from "../../utils/keywordAdvice";

export function matchModeLabel(t: TFunction, mode: KeywordMatchMode): string {
	return mode === "whole" ? t("keyword_editor.mode_whole") : t("keyword_editor.mode_anywhere");
}

export function matchModeOptions(t: TFunction): readonly { value: KeywordMatchMode; label: string }[] {
	return [
		{ value: "whole", label: matchModeLabel(t, "whole") },
		{ value: "anywhere", label: matchModeLabel(t, "anywhere") },
	];
}

/** A phrase is usually meant as a whole message, a single word as a word anywhere. */
export function suggestedMatchMode(text: string): KeywordMatchMode {
	return text.trim().includes(" ") ? "whole" : "anywhere";
}

type Filter = "all" | "whole" | "anywhere" | "review" | "advice";

/** A message or a name quoted in a piece of advice, kept to one short line. */
function adviceExample(text: string | null): string {
	const line = (text ?? "").replace(/\s+/g, " ").trim();
	return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

/** The sentence for one piece of advice. */
export function keywordAdviceText(t: TFunction, advice: KeywordAdvice): string {
	const example = adviceExample(advice.example);
	if (advice.kind === "everyday_word") {
		return advice.people > 0 && example
			? t("keyword_editor.advice.everyday_seen", { count: advice.people, example })
			: t("keyword_editor.advice.everyday");
	}
	if (advice.kind === "matches_many") {
		return t("keyword_editor.advice.many", {
			count: advice.people,
			total: advice.total,
			percent: Math.round((advice.people / Math.max(1, advice.total)) * 100),
		});
	}
	return t("keyword_editor.advice.catch_more", { count: advice.people, example });
}

/** How many keywords the list shows before asking. Keeps a long list from burying the page. */
const COLLAPSED_TAG_LIMIT = 60;

const SMALL_BUTTON =
	"inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-semibold transition hover:border-[var(--text-muted)] disabled:opacity-50";

type KeywordEditorProps = {
	entries: readonly KeywordEntry[];
	onChange: (entries: KeywordEntry[]) => void;
	/** What the two modes mean in this list, shown beside the choice. */
	modeHints?: Record<KeywordMatchMode, string>;
	/** Identities of phrases waiting for review. */
	toReview?: readonly string[];
	onMarkReviewed?: (identities: string[]) => void;
	onFlagForReview?: (identities: string[]) => void;
	/** Advice on entries of this list, by keyword identity. */
	advice?: ReadonlyMap<string, KeywordAdvice>;
	/** The user answered "it's intended": that advice is not to come back. */
	onDismissAdvice?: (entry: KeywordEntry, advice: KeywordAdvice) => void;
	placeholder?: string;
	emptyLabel?: string;
	exportFileName: string;
};

export function KeywordEditor({
	entries,
	onChange,
	modeHints,
	toReview,
	onMarkReviewed,
	onFlagForReview,
	advice,
	onDismissAdvice,
	placeholder,
	emptyLabel,
	exportFileName,
}: KeywordEditorProps) {
	const { t } = useTranslation();
	const [input, setInput] = useState("");
	const [chosenMode, setChosenMode] = useState<KeywordMatchMode | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [search, setSearch] = useState("");
	const [highlight, setHighlight] = useState<{ identity: string; nonce: number } | null>(null);
	const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const listRef = useRef<HTMLDivElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// Tag buttons and the undo toast act after later edits may have landed, so
	// they read the latest list rather than the one they were rendered with.
	const latest = useRef({ entries, onChange, onMarkReviewed });
	useEffect(() => {
		latest.current = { entries, onChange, onMarkReviewed };
	});

	const mode: KeywordMatchMode = chosenMode ?? suggestedMatchMode(input);
	const modeOptions = useMemo(() => matchModeOptions(t), [t]);
	const hints: Record<KeywordMatchMode, string> = modeHints ?? {
		whole: t("keyword_editor.hint_whole"),
		anywhere: t("keyword_editor.hint_anywhere"),
	};
	const reviewSet = useMemo(() => new Set(toReview ?? []), [toReview]);
	const pending = useMemo(() => keywordsFromInput(input, mode), [input, mode]);
	const alreadyThere = useMemo(
		() =>
			pending
				.map((entry) => findKeyword(entries, entry.text))
				.filter((entry): entry is KeywordEntry => entry !== null),
		[pending, entries],
	);

	const counts = useMemo(() => {
		let whole = 0;
		let review = 0;
		for (const entry of entries) {
			if (entry.mode !== "whole") continue;
			whole++;
			if (reviewSet.has(keywordIdentity(entry.text))) review++;
		}
		return { all: entries.length, whole, anywhere: entries.length - whole, review };
	}, [entries, reviewSet]);
	const adviceCount = useMemo(
		() => (advice ? entries.filter((entry) => advice.has(keywordIdentity(entry.text))).length : 0),
		[entries, advice],
	);
	// What can be said about the keyword being typed, from the word alone.
	const typingAdvice = pending.length === 1 ? quickKeywordAdvice(pending[0].text, mode) : null;

	const activeFilter: Filter =
		(filter === "review" && counts.review === 0) || (filter === "advice" && adviceCount === 0) ? "all" : filter;

	const visible = useMemo(() => {
		const query = search.trim().toLowerCase();
		return entries.filter((entry) => {
			if (activeFilter === "whole" && entry.mode !== "whole") return false;
			if (activeFilter === "anywhere" && entry.mode !== "anywhere") return false;
			if (
				activeFilter === "review" &&
				!(entry.mode === "whole" && reviewSet.has(keywordIdentity(entry.text)))
			) {
				return false;
			}
			if (activeFilter === "advice" && !advice?.has(keywordIdentity(entry.text))) return false;
			return !query || entry.text.toLowerCase().includes(query);
		});
	}, [entries, activeFilter, search, reviewSet, advice]);

	const isNarrowed = search.trim() !== "" || activeFilter !== "all";
	// A search or filter is already a short list; only the unfiltered one is capped.
	const shown = showAll || isNarrowed ? visible : visible.slice(0, COLLAPSED_TAG_LIMIT);
	const hiddenCount = visible.length - shown.length;

	useEffect(() => {
		if (!highlight) return;
		const target = listRef.current?.querySelector<HTMLElement>(
			`[data-keyword="${CSS.escape(highlight.identity)}"]`,
		);
		if (target) {
			// The desktop app scrolls through Lenis, which tracks its own position.
			// A native scrollIntoView moved the document underneath it and left the
			// whole layout shifted, nav bar included, until the app restarted.
			const lenis = (window as unknown as {
				lenis?: { scrollTo: (target: HTMLElement, options?: { offset?: number }) => void };
			}).lenis;
			if (lenis) {
				lenis.scrollTo(target, { offset: -160 });
			} else {
				target.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
		}
		const timer = window.setTimeout(() => setHighlight(null), 1800);
		return () => window.clearTimeout(timer);
	}, [highlight]);

	const reveal = useCallback((entry: KeywordEntry) => {
		setSearch("");
		setFilter("all");
		setShowAll(true);
		setHighlight({ identity: keywordIdentity(entry.text), nonce: Date.now() });
	}, []);

	const add = (additions: readonly KeywordEntry[]) => {
		const result = addKeywords(entries, additions);
		if (result.added.length > 0) {
			onChange(result.entries);
		}
		if (result.duplicates.length > 0) {
			const [first] = result.duplicates;
			reveal(first);
			toast.error(
				result.duplicates.length === 1
					? t("keyword_editor.already_single", { text: first.text, mode: matchModeLabel(t, first.mode) })
					: t("keyword_editor.already_several", { count: result.duplicates.length }),
				{ id: "keyword-duplicate" },
			);
		}
		return result;
	};

	const submitInput = () => {
		if (pending.length === 0) return;
		if (add(pending).added.length > 0) {
			setInput("");
			setChosenMode(null);
		}
	};

	const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
		const text = event.clipboardData.getData("text");
		// A single line pastes into the field as usual, so "salut, ça va" can
		// still be added as one message. Lines or quoted entries are a list.
		if (!text.includes("\n") && !/(^|,)\s*"/.test(text)) return;
		event.preventDefault();
		const additions = keywordsFromPastedList(text, "anywhere").map((entry) =>
			entry.mode === "whole" ? entry : { ...entry, mode: chosenMode ?? suggestedMatchMode(entry.text) },
		);
		const result = add(additions);
		if (result.added.length > 0) {
			toast.success(t("keyword_editor.added", { count: result.added.length }), {
				id: "keyword-added",
			});
		}
	};

	const toggleMode = useCallback((entry: KeywordEntry) => {
		const nextMode: KeywordMatchMode = entry.mode === "whole" ? "anywhere" : "whole";
		if (nextMode === "anywhere" && !canMatchAnywhere(entry.text)) {
			toast.error(t("keyword_editor.comma_whole_only"), { id: "keyword-mode" });
			return;
		}
		const identity = keywordIdentity(entry.text);
		const { entries: current, onChange: change } = latest.current;
		change(
			current.map((candidate) =>
				keywordIdentity(candidate.text) === identity ? { ...candidate, mode: nextMode } : candidate,
			),
		);
	}, [t]);

	const remove = useCallback((entry: KeywordEntry) => {
		const identity = keywordIdentity(entry.text);
		const { entries: current, onChange: change } = latest.current;
		const index = current.findIndex((candidate) => keywordIdentity(candidate.text) === identity);
		if (index === -1) return;
		change(current.filter((_, position) => position !== index));
		toast(
			(toastState) => (
				<span className="flex min-w-0 items-center gap-3 text-sm">
					<span className="min-w-0 truncate">{t("keyword_editor.removed", { text: entry.text })}</span>
					<button
						type="button"
						className="shrink-0 font-semibold text-[var(--accent)]"
						onClick={() => {
							toast.dismiss(toastState.id);
							const { entries: now, onChange: restore } = latest.current;
							if (findKeyword(now, entry.text)) return;
							const next = [...now];
							next.splice(Math.min(index, next.length), 0, entry);
							restore(next);
						}}
					>
						{t("keyword_editor.undo")}
					</button>
				</span>
			),
			{ id: "keyword-removed", duration: 5000 },
		);
	}, [t]);

	const showAdvice = useCallback(() => setFilter("advice"), []);

	const markReviewed = useCallback((identity: string) => {
		latest.current.onMarkReviewed?.([identity]);
	}, []);

	const handleExport = () => {
		const content = serializeKeywordList(entries);
		const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = exportFileName;
		link.click();
		URL.revokeObjectURL(url);
		toast.success(t("keyword_editor.exported"), { id: "keyword-export" });
	};

	const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		const imported = readKeywordFile(await file.text());
		const result = addKeywords(entries, imported.entries);
		if (result.added.length > 0) {
			onChange(result.entries);
			if (imported.switchedToWhole.length > 0) {
				const addedIdentities = new Set(result.added.map((entry) => keywordIdentity(entry.text)));
				const flagged = imported.switchedToWhole.filter((identity) => addedIdentities.has(identity));
				if (flagged.length > 0) onFlagForReview?.(flagged);
			}
		}
		toast.success(
			result.duplicates.length > 0
				? t("keyword_editor.imported_with_duplicates", {
						added: result.added.length,
						duplicates: result.duplicates.length,
					})
				: t("keyword_editor.imported", { added: result.added.length }),
			{ id: "keyword-import" },
		);
	};

	const duplicateHint =
		alreadyThere.length === 0
			? null
			: alreadyThere.length === 1
				? // Case and the punctuation around a keyword are ignored, so the entry
					// found can be spelled differently from what was typed: name it.
					t("keyword_editor.hint_already_single", {
						text: alreadyThere[0].text,
						mode: matchModeLabel(t, alreadyThere[0].mode),
					})
				: t("keyword_editor.hint_already_several", { count: alreadyThere.length });

	const filters: { value: Filter; label: string; count: number }[] = [
		{ value: "all", label: t("keyword_editor.filter_all"), count: counts.all },
		// Right after "All": on a phone the end of this row is off screen.
		...(adviceCount > 0
			? [{ value: "advice" as const, label: t("keyword_editor.advice.chip"), count: adviceCount }]
			: []),
		{ value: "whole", label: matchModeLabel(t, "whole"), count: counts.whole },
		{ value: "anywhere", label: matchModeLabel(t, "anywhere"), count: counts.anywhere },
		...(counts.review > 0
			? [{ value: "review" as const, label: t("keyword_editor.to_review"), count: counts.review }]
			: []),
	];

	return (
		<div className="grid gap-3">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submitInput();
				}}
				className="grid gap-2"
			>
				<div className="flex gap-2">
					<input
						type="text"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onPaste={handlePaste}
						placeholder={placeholder}
						aria-label={t("keyword_editor.new_keyword")}
						enterKeyHint="done"
						autoCapitalize="none"
						autoCorrect="off"
						className="input-field min-w-0 flex-1"
					/>
					<button
						type="submit"
						disabled={pending.length === 0}
						className="btn-accent inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 px-3.5 text-sm font-semibold disabled:opacity-50"
					>
						<Plus className="h-4 w-4" /> {t("keyword_editor.add")}
					</button>
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
					<SegmentedChoice
						value={mode}
						options={modeOptions}
						onChange={setChosenMode}
						ariaLabel={t("keyword_editor.mode_aria")}
					/>
					<span className="text-[11px] leading-snug text-[var(--text-muted)]">{hints[mode]}</span>
				</div>
				{duplicateHint ? (
					<p role="status" className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-amber-400">
						<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
						<span>{duplicateHint}</span>
						<button
							type="button"
							onClick={() => reveal(alreadyThere[0])}
							className="font-semibold underline underline-offset-2"
						>
							{t("keyword_editor.show")}
						</button>
					</p>
				) : null}
				{typingAdvice ? (
					<p role="status" className="flex items-start gap-1.5 text-xs font-medium text-amber-400">
						<Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span>
							{t("keyword_editor.advice.typing_everyday", { text: pending[0].text })}{" "}
							<button
								type="button"
								onClick={() => setChosenMode("whole")}
								className="font-semibold underline underline-offset-2"
							>
								{t("keyword_editor.advice.use_whole")}
							</button>
						</span>
					</p>
				) : null}
			</form>

			{entries.length > 0 ? (
				<div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
					{filters.map((option) => {
						const selected = activeFilter === option.value;
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => setFilter(option.value)}
								aria-pressed={selected}
								className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
									selected
										? "border-transparent bg-[var(--accent)] text-[var(--accent-contrast)]"
										: "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
								}`}
							>
								{option.value === "review" ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> : null}
								{option.value === "advice" ? <Lightbulb className="h-3 w-3" /> : null}
								{option.label}
								<span className="opacity-70">{option.count}</span>
							</button>
						);
					})}
				</div>
			) : null}

			{entries.length > 12 ? (
				<label className="relative block">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
					<input
						type="search"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t("keyword_editor.search")}
						aria-label={t("keyword_editor.search")}
						className="input-field text-sm"
						style={{ paddingLeft: "2.25rem" }}
					/>
				</label>
			) : null}

			{activeFilter === "review" ? (
				<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-[var(--text-muted)]">
					<p>
						<Trans
							i18nKey="keyword_editor.review_notice"
							components={{
								b: <strong className="text-[var(--text)]" />,
								w: <strong className="text-sky-400" />,
							}}
						/>
					</p>
					<button
						type="button"
						onClick={() => onMarkReviewed?.([...reviewSet])}
						className="mt-2 inline-flex items-center gap-1.5 font-semibold text-amber-400"
					>
						<Check className="h-3.5 w-3.5" /> {t("keyword_editor.mark_all_reviewed")}
					</button>
				</div>
			) : null}

			<div
				ref={listRef}
				className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-2"
			>
				{visible.length === 0 ? (
					<p className="px-1 py-3 text-center text-xs text-[var(--text-muted)]">
						{entries.length === 0 ? (emptyLabel ?? t("keyword_editor.empty")) : t("keyword_editor.nothing_matches")}
					</p>
				) : activeFilter === "advice" && advice ? (
					<ul className="grid gap-2">
						{shown.map((entry) => {
							const identity = keywordIdentity(entry.text);
							const item = advice.get(identity);
							if (!item) return null;
							return (
								<li
									key={identity}
									className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs"
								>
									<p className="flex min-w-0 items-center gap-2">
										<span className="min-w-0 truncate font-semibold text-[var(--text)]">{entry.text}</span>
										<span className="shrink-0 text-[10px] font-semibold text-[var(--text-muted)]">
											{matchModeLabel(t, entry.mode)}
										</span>
									</p>
									<p className="mt-1 leading-relaxed text-[var(--text-muted)]">{keywordAdviceText(t, item)}</p>
									<p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
										<button
											type="button"
											onClick={() => toggleMode(entry)}
											className="font-semibold text-[var(--accent)]"
										>
											{item.suggest === "whole"
												? t("keyword_editor.advice.switch_whole")
												: t("keyword_editor.advice.switch_anywhere")}
										</button>
										<button
											type="button"
											onClick={() => onDismissAdvice?.(entry, item)}
											className="font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
										>
											{t("keyword_editor.advice.dismiss")}
										</button>
									</p>
								</li>
							);
						})}
					</ul>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{shown.map((entry) => {
							const identity = keywordIdentity(entry.text);
							return (
								<KeywordTag
									key={identity}
									entry={entry}
									identity={identity}
									inReview={entry.mode === "whole" && reviewSet.has(identity)}
									highlighted={highlight?.identity === identity}
									hasAdvice={advice?.has(identity) ?? false}
									onShowAdvice={showAdvice}
									onToggleMode={toggleMode}
									onRemove={remove}
									onReviewed={markReviewed}
								/>
							);
						})}
					</div>
				)}
				{hiddenCount > 0 ? (
					<button
						type="button"
						onClick={() => setShowAll(true)}
						className="mt-2 w-full rounded-lg px-2 py-1.5 text-xs font-semibold text-[var(--accent)] transition hover:bg-[var(--surface-2)]"
					>
						{t("keyword_editor.show_more", { count: hiddenCount })}
					</button>
				) : null}
				{showAll && !isNarrowed && visible.length > COLLAPSED_TAG_LIMIT ? (
					<button
						type="button"
						onClick={() => setShowAll(false)}
						className="mt-2 w-full rounded-lg px-2 py-1.5 text-xs font-semibold text-[var(--text-muted)] transition hover:bg-[var(--surface-2)]"
					>
						{t("keyword_editor.show_fewer")}
					</button>
				) : null}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<span className="mr-auto text-[11px] text-[var(--text-muted)]">
					{t("keyword_editor.total", { count: counts.all })}
				</span>
				<button type="button" onClick={handleExport} disabled={entries.length === 0} className={SMALL_BUTTON}>
					<Download className="h-3.5 w-3.5" /> {t("keyword_editor.export")}
				</button>
				<button type="button" onClick={() => fileInputRef.current?.click()} className={SMALL_BUTTON}>
					<Upload className="h-3.5 w-3.5" /> {t("keyword_editor.import")}
				</button>
				<input
					ref={fileInputRef}
					type="file"
					accept=".txt,text/plain"
					onChange={(event) => void handleImport(event)}
					className="hidden"
				/>
				<button
					type="button"
					onClick={() => setIsClearConfirmOpen(true)}
					disabled={entries.length === 0}
					className={`${SMALL_BUTTON} text-red-400 hover:border-red-400`}
				>
					<Trash2 className="h-3.5 w-3.5" /> {t("keyword_editor.clear")}
				</button>
			</div>

			<ConfirmDialog
				isOpen={isClearConfirmOpen}
				title={t("keyword_editor.clear_title")}
				message={t("keyword_editor.clear_message", { count: entries.length })}
				confirmLabel={t("keyword_editor.delete_all")}
				cancelLabel={t("common.cancel")}
				onConfirm={() => {
					setIsClearConfirmOpen(false);
					onChange([]);
				}}
				onCancel={() => setIsClearConfirmOpen(false)}
				confirmTone="danger"
			/>
		</div>
	);
}

const KeywordTag = memo(function KeywordTag({
	entry,
	identity,
	inReview,
	highlighted,
	hasAdvice,
	onShowAdvice,
	onToggleMode,
	onRemove,
	onReviewed,
}: {
	entry: KeywordEntry;
	identity: string;
	inReview: boolean;
	highlighted: boolean;
	hasAdvice: boolean;
	onShowAdvice: () => void;
	onToggleMode: (entry: KeywordEntry) => void;
	onRemove: (entry: KeywordEntry) => void;
	onReviewed: (identity: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<span
			data-keyword={identity}
			className={`inline-flex max-w-full items-center gap-1 rounded-full border bg-[var(--surface-2)] py-0.5 pl-2.5 pr-0.5 text-xs transition-shadow ${
				highlighted
					? "border-[var(--accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_35%,transparent)]"
					: "border-[var(--border)]"
			}`}
		>
			{inReview ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title={t("keyword_editor.to_review")} /> : null}
			{hasAdvice ? (
				<button
					type="button"
					onClick={onShowAdvice}
					title={t("keyword_editor.advice.tag_title")}
					aria-label={t("keyword_editor.advice.tag_title")}
					className="-ml-1 shrink-0 rounded-full p-0.5 text-amber-400 transition hover:bg-amber-500/15"
				>
					<Lightbulb className="h-3 w-3" />
				</button>
			) : null}
			<span className="min-w-0 truncate font-medium text-[var(--text)]" title={entry.text}>
				{entry.text}
			</span>
			<button
				type="button"
				onClick={() => onToggleMode(entry)}
				title={t("keyword_editor.tap_to_switch", { mode: matchModeLabel(t, entry.mode) })}
				className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition ${
					entry.mode === "whole"
						? "bg-sky-500/15 text-sky-400 hover:bg-sky-500/25"
						: "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25"
				}`}
			>
				{entry.mode === "whole" ? t("keyword_editor.tag_whole") : t("keyword_editor.mode_anywhere")}
			</button>
			{inReview ? (
				<button
					type="button"
					onClick={() => onReviewed(identity)}
					title={t("keyword_editor.keep_whole")}
					aria-label={t("keyword_editor.keep_whole_aria", { text: entry.text })}
					className="shrink-0 rounded-full p-1 text-amber-400 transition hover:bg-amber-500/15"
				>
					<Check className="h-3 w-3" />
				</button>
			) : null}
			<button
				type="button"
				onClick={() => onRemove(entry)}
				aria-label={t("keyword_editor.remove_aria", { text: entry.text })}
				className="shrink-0 rounded-full p-1.5 text-[var(--text-muted)] transition hover:bg-red-500/15 hover:text-red-400"
			>
				<X className="h-3 w-3" />
			</button>
		</span>
	);
});
