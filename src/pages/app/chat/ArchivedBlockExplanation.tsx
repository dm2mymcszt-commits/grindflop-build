import { useEffect, useState } from "react";
import { getLatestBlockLogEntry } from "../../../services/chatDb";
import { explainBlock, type BlockExplanation } from "../../../utils/blockExplanation";
import { BlockExplanationLines } from "../gridpage/components/BlockExplanationLines";

/**
 * How and why this account blocked the person an archived chat is with, read
 * from the Stats block log — the same two lines their profile shows, here so
 * a wrong automatic block can be spotted without leaving the conversation.
 *
 * Renders nothing when the log has no block for them (Stats was off, or the
 * newest entry is an unblock).
 */
export function ArchivedBlockExplanation({
	profileId,
	className,
}: {
	profileId: string | number | null | undefined;
	className?: string;
}) {
	const id = profileId == null ? null : String(profileId);
	const [found, setFound] = useState<{ profileId: string; explanation: BlockExplanation } | null>(
		null,
	);

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

		const look = (isRetry: boolean) => {
			void getLatestBlockLogEntry(id)
				.then((entry) => {
					if (cancelled) return;
					const explanation = explainBlock(entry);
					if (explanation) {
						setFound({ profileId: id, explanation });
						return;
					}
					// The chat is archived the moment the block succeeds, and the log
					// row is written just after: one more look catches it.
					if (!isRetry) {
						retryTimer = setTimeout(() => look(true), 2000);
					}
				})
				.catch(() => {});
		};
		look(false);

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [id]);

	if (!found || found.profileId !== id) return null;
	return <BlockExplanationLines explanation={found.explanation} className={className} compact />;
}
