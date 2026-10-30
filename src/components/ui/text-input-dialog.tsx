import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type TextInputDialogProps = {
	isOpen: boolean;
	title: string;
	message?: string;
	initialValue: string;
	placeholder?: string;
	confirmLabel: string;
	cancelLabel: string;
	/** Receives the text as typed; trimming and validation are the caller's. */
	onConfirm: (value: string) => void | Promise<void>;
	onCancel: () => void;
	isProcessing?: boolean;
};

/**
 * The in-app replacement for `window.prompt`, which the iOS app never shows:
 * WKWebView has no native JS dialogs there, so the call returns at once as
 * if cancelled.
 */
export function TextInputDialog({
	isOpen,
	title,
	message,
	initialValue,
	placeholder,
	confirmLabel,
	cancelLabel,
	onConfirm,
	onCancel,
	isProcessing = false,
}: TextInputDialogProps) {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [value, setValue] = useState(initialValue);

	useEffect(() => {
		if (isOpen) setValue(initialValue);
	}, [isOpen, initialValue]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (isOpen) {
			if (!dialog.open) {
				try {
					dialog.showModal();
				} catch {
					dialog.show();
				}
			}
			setTimeout(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			}, 50);
		} else if (dialog.open) {
			dialog.close();
		}
	}, [isOpen]);

	useEffect(() => {
		const dialog = dialogRef.current;
		return () => {
			if (dialog?.open) dialog.close();
		};
	}, []);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const handleCancel = (event: Event) => {
			event.preventDefault();
			if (!isProcessing) onCancel();
		};
		dialog.addEventListener("cancel", handleCancel);
		return () => dialog.removeEventListener("cancel", handleCancel);
	}, [isProcessing, onCancel]);

	return (
		<dialog
			ref={dialogRef}
			className="fixed inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_92%,black_8%)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/45"
			onClick={(event) => {
				if (event.target === dialogRef.current && !isProcessing) onCancel();
			}}
		>
			<form
				className="p-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!isProcessing) void onConfirm(value);
				}}
			>
				<p className="text-sm font-semibold text-[var(--text)]">{title}</p>
				{message ? (
					<p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{message}</p>
				) : null}
				<input
					ref={inputRef}
					type="text"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					placeholder={placeholder}
					disabled={isProcessing}
					className="mt-4 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
				/>
				<div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<button
						type="button"
						onClick={onCancel}
						disabled={isProcessing}
						className="inline-flex h-11 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-60"
					>
						{cancelLabel}
					</button>
					<button
						type="submit"
						disabled={isProcessing}
						className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] transition hover:brightness-110 disabled:opacity-60"
					>
						{isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
						<span>{confirmLabel}</span>
					</button>
				</div>
			</form>
		</dialog>
	);
}
