import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GripVertical, MessageSquareQuote, Trash2 } from "lucide-react";
import {
	DndContext,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
	type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { moveItemTo } from "../utils/reorder";

/** A row only ever moves up and down its list. */
const keepOnVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

type SortablePhraseListProps = {
	/** The phrases, in order. Each one is its own key, so they must be distinct. */
	phrases: string[];
	/** Called with the whole list in its new order once a phrase has been moved. */
	onReorder: (phrases: string[]) => void;
	onDelete: (index: number) => void;
	/** What a row shows for its phrase. Plain text when left out. */
	renderPhrase?: (phrase: string) => ReactNode;
	/**
	 * With a mouse a row is moved by its grip, so that its text can still be
	 * clicked and selected. With a finger there is no room for a grip: the row
	 * itself is held for a moment, then dragged.
	 */
	isDesktop: boolean;
};

function PhraseRow({
	phrase,
	onDelete,
	renderPhrase,
	isDesktop,
}: {
	phrase: string;
	onDelete: () => void;
	renderPhrase?: (phrase: string) => ReactNode;
	isDesktop: boolean;
}) {
	const { t } = useTranslation();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: phrase,
	});

	const style: CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			{...(isDesktop ? {} : { ...attributes, ...listeners })}
			className={`flex items-start gap-3 px-4 py-3 ${isDesktop ? "" : "touch-pan-y no-touch-callout"} ${
				isDragging ? "relative z-10 bg-[var(--surface)] opacity-70 shadow-lg" : ""
			}`}
		>
			{isDesktop && (
				<button
					type="button"
					{...attributes}
					{...listeners}
					className="mt-0.5 flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:text-[var(--text)] active:cursor-grabbing"
					aria-label={t("settings_saved_phrases.reorder", { defaultValue: "Move phrase" })}
				>
					<GripVertical className="h-4 w-4" />
				</button>
			)}
			<div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--accent)]">
				<MessageSquareQuote className="h-3.5 w-3.5" />
			</div>
			{renderPhrase ? (
				renderPhrase(phrase)
			) : (
				<p className="min-w-0 flex-1 break-words text-sm leading-relaxed">{phrase}</p>
			)}
			<button
				type="button"
				onClick={onDelete}
				className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-400"
				aria-label={t("settings_saved_phrases.delete", { defaultValue: "Delete phrase" })}
			>
				<Trash2 className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

/**
 * The saved phrases as a list that can be put in order by dragging. Used by
 * the settings page and by the sheet in a chat, which differ only in what a
 * row does with its phrase.
 */
export function SortablePhraseList({
	phrases,
	onReorder,
	onDelete,
	renderPhrase,
	isDesktop,
}: SortablePhraseListProps) {
	// A drag starts after a little movement with a mouse, and after a short
	// hold with a finger, so that a click, a tap and a scroll stay what they are.
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
	);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over) {
			return;
		}
		const next = moveItemTo(phrases, String(active.id), String(over.id));
		if (next) {
			onReorder(next);
		}
	};

	return (
		<DndContext sensors={sensors} modifiers={[keepOnVerticalAxis]} autoScroll={false} onDragEnd={handleDragEnd}>
			<SortableContext items={phrases} strategy={verticalListSortingStrategy}>
				<div className="divide-y divide-[var(--border)]">
					{phrases.map((phrase, index) => (
						<PhraseRow
							key={phrase}
							phrase={phrase}
							onDelete={() => onDelete(index)}
							renderPhrase={renderPhrase}
							isDesktop={isDesktop}
						/>
					))}
				</div>
			</SortableContext>
		</DndContext>
	);
}
