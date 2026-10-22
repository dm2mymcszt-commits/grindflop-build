import { useState } from "react";
import { User } from "lucide-react";
import { cn } from "../../utils/cn";

interface ProfileImageProps {
	src?: string | null;
	alt?: string;
	className?: string;
	iconClassName?: string;
	/**
	 * Deferred by default: the browse grid mounts hundreds of these at once and
	 * most are far off-screen. Pass "eager" for an image that is the point of
	 * the view it sits in.
	 */
	loading?: "lazy" | "eager";
}

export function ProfileImage({
	src,
	alt,
	className,
	iconClassName,
	loading = "lazy",
}: ProfileImageProps) {
	// A deleted or banned profile's picture no longer loads; remembering the
	// address that failed shows the placeholder instead of a broken image,
	// and a later, different picture still gets its chance.
	const [failedSrc, setFailedSrc] = useState<string | null>(null);

	if (src && src !== failedSrc) {
		return (
			<img
				src={src}
				alt={alt}
				loading={loading}
				decoding="async"
				onError={() => setFailedSrc(src)}
				className={cn("h-full w-full object-cover", className)}
			/>
		);
	}

	return (
		<div
			className={cn(
				"flex h-full w-full items-center justify-center bg-[var(--surface-2)] text-[var(--text-muted)]",
				className,
			)}
		>
			<User className={cn("h-1/2 w-1/2", iconClassName)} />
		</div>
	);
}
