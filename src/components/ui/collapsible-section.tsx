import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

function readStoredOpen(storageKey: string, fallback: boolean): boolean {
	try {
		const stored = window.localStorage.getItem(storageKey);
		return stored === null ? fallback : stored === "true";
	} catch {
		return fallback;
	}
}

/**
 * A settings card that folds away, remembering on this device whether it was
 * left open. Its `id` is also its id on the page, which is how a settings
 * search result finds it.
 */
export function CollapsibleSection({
	id,
	title,
	summary,
	icon,
	iconClass,
	defaultOpen = false,
	children,
}: {
	id: string;
	title: string;
	summary?: string;
	icon?: ReactNode;
	iconClass?: string;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const storageKey = `fg-section-open-${id}`;
	const [open, setOpen] = useState(() => readStoredOpen(storageKey, defaultOpen));

	const toggle = () => {
		const next = !open;
		setOpen(next);
		try {
			window.localStorage.setItem(storageKey, String(next));
		} catch {
			// Remembering the fold is a convenience; the page works without it.
		}
	};

	return (
		<div id={id} className="surface-card overflow-hidden">
			<button
				type="button"
				onClick={toggle}
				aria-expanded={open}
				className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)]"
			>
				{icon ? <div className={`shrink-0 rounded-2xl p-2.5 ${iconClass ?? ""}`}>{icon}</div> : null}
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-semibold leading-snug text-[var(--text)]">{title}</span>
					{summary ? (
						<span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{summary}</span>
					) : null}
				</span>
				<ChevronDown
					className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open ? <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">{children}</div> : null}
		</div>
	);
}
