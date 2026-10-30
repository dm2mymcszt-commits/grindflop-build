export function SegmentedChoice<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	disabled,
	fullWidth,
}: {
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
	ariaLabel: string;
	disabled?: boolean;
	/** Stretch across the container, letting long labels wrap instead of overflowing. */
	fullWidth?: boolean;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			className={`rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-0.5 ${
				fullWidth ? "grid w-full" : "inline-flex max-w-full"
			}`}
			style={fullWidth ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
		>
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={selected}
						disabled={disabled}
						onClick={() => onChange(option.value)}
						className={`min-w-0 rounded-[10px] px-3 py-1.5 text-xs font-semibold leading-tight transition disabled:opacity-60 ${
							fullWidth ? "text-center" : "truncate"
						} ${
							selected
								? "bg-[var(--accent)] text-[var(--accent-contrast)] shadow-sm"
								: "text-[var(--text-muted)] hover:text-[var(--text)]"
						}`}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
