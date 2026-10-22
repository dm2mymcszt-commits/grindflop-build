/**
 * tapsSync.ts — reconciles taps received while the app was closed against
 * the "tap_received" automation trigger. There's no local record of taps to
 * diff against (unlike inboxSync.ts, which persists conversations to chatDb
 * and can tell new/changed apart), and no live WS replay for missed taps
 * either — so this just re-scans the whole received-taps list every run.
 * That's safe and cheap: runAutomationRulesForSender dedupes on
 * (trigger, sender) forever, so an already-processed sender short-circuits
 * immediately instead of being re-evaluated.
 */

import type { createApiFunctions } from "./apiFunctions";
import { runAutomationRulesForSender } from "../utils/automationRules";
import { withPreservingBlock } from "./autoBlockConversation";
import { appLog } from "../utils/logger";

type ApiFunctions = ReturnType<typeof createApiFunctions>;

export async function runTapsAutomationSync(
	apiFunctions: ApiFunctions,
	isStillActive: () => boolean,
	userId: number | null = null,
): Promise<void> {
	try {
		const response = await apiFunctions.getTaps();
		// A tap rule that blocks must still preserve the conversation first —
		// the sender may well have an existing chat with albums and photos in
		// it, and the raw endpoint would take it away before anything is saved.
		const runner = withPreservingBlock(apiFunctions, userId);
		for (const entry of response.profiles) {
			if (!isStillActive()) return;
			const profileId = entry.profileId ?? entry.senderId;
			if (!profileId) continue;

			await runAutomationRulesForSender(
				String(profileId),
				"tap_received",
				runner,
				{
					profileImageMediaHash:
						entry.profileImageMediaHash ?? entry.photoHash ?? entry.mediaHash ?? null,
				},
			).catch(() => {});
		}
	} catch (error) {
		appLog.warn("[taps-sync] failed to reconcile received taps for automation", error);
	}
}
