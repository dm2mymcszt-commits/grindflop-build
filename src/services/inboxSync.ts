/**
 * inboxSync.ts — throttled background sync of the chat list and each
 * changed conversation's latest messages into chatDb, run every time a
 * profile is loaded (app start / login / account switch).
 *
 * The very first run for a profile walks the *entire* inbox (every page) and
 * fetches every conversation's latest messages, then marks that profile as
 * having completed a full sync. Every run after that is incremental: since
 * the inbox is server-sorted pinned-first then most-recently-active-first,
 * a page where nothing is new or updated (every entry's
 * lastActivityTimestamp already matches what's stored) means every deeper
 * page is unchanged too, so paging stops right there instead of re-walking
 * conversations that haven't moved. Latest messages are then only re-fetched
 * for the conversations that page-walk actually found to be new or updated.
 *
 * Deliberately slow and sequential: one request at a time with a delay in
 * between, so it never competes with the foreground chat UI (or the
 * server's rate limits) while the user is actively using the app. All
 * writes go through chatDb's normal idempotent upserts, so if the app
 * closes mid-sync nothing is corrupted.
 *
 * The first full walk is resumable as well: once a page has been processed
 * in full the next page number is saved (inboxSyncResumePageV1), so a restart
 * partway through page 40 of 100 carries on at page 40 instead of walking
 * 1..40 again. The saved page only means something until the "done" flag is
 * set; it is reset when the walk completes, since incremental runs already
 * stop early by themselves (see pageHadChange below).
 *
 * The "done" flag only covers the conversation-list walk, not individual
 * message fetches — each conversation row also tracks the
 * lastActivityTimestamp it last had its messages fetched at
 * (messagesSyncedActivityTimestamp, set via chatDb.markConversationMessagesSynced
 * only on a successful fetch). A conversation is re-enqueued for message
 * fetching whenever that doesn't match its current lastActivityTimestamp —
 * whether because it's genuinely new/updated, or because a prior run was
 * interrupted before ever fetching its messages. So an interrupted
 * first-ever run (e.g. the app closed partway through 1800 conversations)
 * resumes on next launch by skipping every conversation already fetched and
 * picking up only where it left off, rather than restarting the multi-hour
 * message-fetch pass from scratch.
 */

import type { createApiFunctions } from "./apiFunctions";
import * as chatDb from "./chatDb";
import { upsertChatContactIndexFromInbox } from "./chatContactIndex";
import { getOtherParticipant } from "../pages/app/chat/chatUtils";
import { appLog } from "../utils/logger";
import {
	reconcileCounterBlocks,
	reconcileReappearedConversation,
	CHAT_SYSTEM_MESSAGE_EVENT,
} from "./conversationArchive";
import { classifyProfileAccess } from "../utils/profileAccessStatus";
import type { Message } from "../types/messages";

type ApiFunctions = ReturnType<typeof createApiFunctions>;

const INBOX_SYNC_DONE_SETTING_KEY = "inboxSyncCompletedV1";
// The page to resume the first full walk from. Device-local like the flag
// above: settings are only synced or copied from an allowlist, and this is not
// on it.
const INBOX_SYNC_RESUME_PAGE_SETTING_KEY = "inboxSyncResumePageV1";
const PAGE_DELAY_MS = 400;
const MESSAGE_FETCH_DELAY_MS = 2_500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Live status — a tiny framework-agnostic pub/sub so a Settings screen can
// show progress without polling. Keyed by profile id since chatDb (and so
// the sync) is scoped per profile; readers just ask for whichever profile is
// currently signed in. Snapshots are only ever replaced wholesale (never
// mutated), so a subscriber can safely compare by reference.
// ---------------------------------------------------------------------------

export type InboxSyncStatus =
	| { phase: "idle" }
	| { phase: "syncing_list"; conversationsSoFar: number; changedSoFar: number }
	| { phase: "syncing_messages"; completed: number; total: number }
	| { phase: "done"; conversations: number; changed: number }
	| { phase: "error"; message: string };

const IDLE_STATUS: InboxSyncStatus = { phase: "idle" };

const statusByUser = new Map<number, InboxSyncStatus>();
const statusListeners = new Set<() => void>();

function setStatus(userId: number, status: InboxSyncStatus): void {
	statusByUser.set(userId, status);
	for (const listener of statusListeners) {
		listener();
	}
}

export function getInboxSyncStatus(userId: number | null): InboxSyncStatus {
	if (userId == null) {
		return IDLE_STATUS;
	}
	return statusByUser.get(userId) ?? IDLE_STATUS;
}

export function subscribeInboxSyncStatus(listener: () => void): () => void {
	statusListeners.add(listener);
	return () => {
		statusListeners.delete(listener);
	};
}

// Bumped every time a new sync starts, invalidating whatever run came before
// it — guards against a still-running sync from a previous profile writing
// into the newly active one after a fast account switch (chatDb always
// targets whatever profile setActiveChatDbUser last pointed it at).
let currentToken = 0;
const inFlightByUser = new Map<number, Promise<void>>();

/**
 * Starts (or reuses an already-running) inbox sync for `userId`. Safe — and
 * intended — to call on every profile load: the first run for a profile
 * does a full walk, every run after is incremental (see module docstring).
 */
export function runInboxSync(
	apiFunctions: ApiFunctions,
	userId: number,
	isStillActive: () => boolean,
): Promise<void> {
	const existing = inFlightByUser.get(userId);
	if (existing) {
		return existing;
	}

	currentToken += 1;
	const myToken = currentToken;
	const isStale = () => myToken !== currentToken || !isStillActive();

	const promise = doSync(apiFunctions, userId, isStale).finally(() => {
		inFlightByUser.delete(userId);
	});
	inFlightByUser.set(userId, promise);
	return promise;
}

async function doSync(
	apiFunctions: ApiFunctions,
	userId: number,
	isStale: () => boolean,
): Promise<void> {
	try {
		const hasCompletedFullSync = await chatDb.getSetting<boolean>(INBOX_SYNC_DONE_SETTING_KEY);
		if (isStale()) {
			return;
		}

		const savedResumePage = hasCompletedFullSync
			? null
			: await chatDb.getSetting<number>(INBOX_SYNC_RESUME_PAGE_SETTING_KEY).catch(() => null);
		if (isStale()) {
			return;
		}
		const startPage =
			typeof savedResumePage === "number" && Number.isInteger(savedResumePage) && savedResumePage > 1
				? savedResumePage
				: 1;

		appLog.info("[inbox-sync] starting sync", { userId, hasCompletedFullSync, startPage });
		setStatus(userId, { phase: "syncing_list", conversationsSoFar: 0, changedSoFar: 0 });

		let conversationsSeen = 0;
		const changedConversations: { conversationId: string; lastActivityTimestamp: number | null }[] = [];
		// Counter-block needs to know which conversations the inbox no longer
		// returns, and "absent" only means anything after a walk that reached
		// the last page. The early-stop below is what usually prevents that, so
		// the sweep is only trusted when the loop ran out of pages.
		const sweepStartedAt = Date.now();
		const seenConversationIds: string[] = [];
		let walkedEveryPage = false;
		// A walk that resumed partway never asked for the earlier pages, so
		// reaching the end of it says nothing about what the inbox no longer
		// holds. Only a walk that began at page 1 may feed the counter-block
		// sweep; a resumed one would hand it every conversation on the pages it
		// skipped as "gone".
		const walkBeganAtFirstPage = startPage === 1;

		let page: number | null = startPage;
		while (page != null) {
			if (isStale()) {
				return;
			}

			const response = await apiFunctions.listConversations({ page });

			const contactEntries = response.entries
				.map((entry) => {
					const other = getOtherParticipant(entry, userId);
					if (!other?.profileId) {
						return null;
					}
					return {
						profileId: String(other.profileId),
						conversationId: entry.data.conversationId,
						lastMessageTimestamp: entry.data.lastActivityTimestamp ?? null,
						unreadCount: entry.data.unreadCount ?? 0,
					};
				})
				.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

			if (contactEntries.length > 0) {
				await upsertChatContactIndexFromInbox(contactEntries).catch((error) => {
					appLog.warn("[inbox-sync] failed to persist chat contact index", error);
				});
			}

			let pageHadChange = false;
			const reappearedMessages: Message[] = [];
			for (const entry of response.entries) {
				if (isStale()) {
					return;
				}

				const existing = await chatDb.getConversation(entry.data.conversationId).catch(() => null);
				// "Changed" means either the metadata moved, or messages were never
				// actually fetched for the conversation's current state — the
				// latter is what makes a sync interrupted mid-message-fetch resume
				// correctly instead of silently skipping conversations whose row
				// got upserted but whose messages never landed.
				const isNewOrChanged =
					!existing ||
					existing.entry.data.lastActivityTimestamp !== entry.data.lastActivityTimestamp ||
					existing.messagesSyncedActivityTimestamp !== entry.data.lastActivityTimestamp;

				const other = getOtherParticipant(entry, userId);
				await chatDb
					.upsertConversation(entry, other?.profileId != null ? String(other.profileId) : null)
					.catch((error) => {
						appLog.warn("[inbox-sync] failed to persist conversation", error);
					});

				// This conversation showing up here at all means the server can
				// still produce it — the same "reappeared" signal ChatPage's
				// foreground /v4/inbox poll uses to clear a stale block-related
				// archive. Without this, a block/unblock that happens on another
				// device while this device's WS is disconnected (so neither the
				// live WS path nor the foreground poll ever saw it) leaves the
				// conversation archived — with a stale "blocked" block_state, and
				// so a stale unblock button — forever, even though this background
				// sync just fetched its latest messages successfully.
				if (existing?.archived) {
					const message = await reconcileReappearedConversation(
						entry.data.conversationId,
						existing.archivedReason,
					).catch(() => null);
					if (message) {
						reappearedMessages.push(message);
					}
				}

				conversationsSeen += 1;
				seenConversationIds.push(entry.data.conversationId);
				if (isNewOrChanged) {
					pageHadChange = true;
					changedConversations.push({
						conversationId: entry.data.conversationId,
						lastActivityTimestamp: entry.data.lastActivityTimestamp ?? null,
					});
				}
			}
			if (reappearedMessages.length > 0 && typeof window !== "undefined") {
				window.dispatchEvent(
					new CustomEvent<Message[]>(CHAT_SYSTEM_MESSAGE_EVENT, { detail: reappearedMessages }),
				);
			}
			setStatus(userId, {
				phase: "syncing_list",
				conversationsSoFar: conversationsSeen,
				changedSoFar: changedConversations.length,
			});

			if (response.entries.length === 0) {
				walkedEveryPage = walkBeganAtFirstPage;
				break;
			}

			// Once a full walk has happened before, the inbox's sort order
			// (pinned, then most-recently-active first) guarantees a page with
			// no new/updated entries means every page after it is unchanged
			// too — stop instead of re-walking the whole inbox every launch.
			if (hasCompletedFullSync && !pageHadChange) {
				break;
			}

			page = response.nextPage ?? null;
			if (page == null) {
				walkedEveryPage = walkBeganAtFirstPage;
				break;
			}
			if (!hasCompletedFullSync) {
				await chatDb.setSetting(INBOX_SYNC_RESUME_PAGE_SETTING_KEY, page).catch(() => {});
			}
			await sleep(PAGE_DELAY_MS);
		}

		await chatDb
			.touchConversationsSeenInInbox(seenConversationIds, sweepStartedAt)
			.catch((error) => {
				appLog.warn("[inbox-sync] failed to record inbox presence", error);
			});

		appLog.info("[inbox-sync] chat list sync complete, fetching latest messages", {
			userId,
			conversationsSeen,
			changed: changedConversations.length,
		});
		setStatus(userId, { phase: "syncing_messages", completed: 0, total: changedConversations.length });

		for (let i = 0; i < changedConversations.length; i += 1) {
			if (isStale()) {
				return;
			}
			const { conversationId, lastActivityTimestamp } = changedConversations[i];
			try {
				const response = await apiFunctions.listMessages({ conversationId });
				if (response.messages.length > 0) {
					await chatDb.upsertMessages(conversationId, response.messages);
				}
				// Only recorded on success — a failed fetch leaves this
				// conversation looking "not yet synced" so the next run (whether
				// that's a retry moments later or after the app was closed and
				// reopened) picks it back up instead of silently giving up on it.
				await chatDb.markConversationMessagesSynced(conversationId, lastActivityTimestamp);
			} catch (error) {
				appLog.warn("[inbox-sync] failed to fetch/persist latest messages", {
					conversationId,
					error,
				});
			}
			setStatus(userId, {
				phase: "syncing_messages",
				completed: i + 1,
				total: changedConversations.length,
			});
			await sleep(MESSAGE_FETCH_DELAY_MS);
		}

		if (!isStale()) {
			if (!hasCompletedFullSync) {
				await chatDb.setSetting(INBOX_SYNC_DONE_SETTING_KEY, true);
				await chatDb.setSetting(INBOX_SYNC_RESUME_PAGE_SETTING_KEY, 1).catch(() => {});
			}

			// Runs on every sync, not just complete ones: one half re-attempts
			// blocks already attributed to the other party, which is what repairs
			// a counter-block whose request failed or whose live event fired with
			// nothing listening. The other half is handed the sweep only when the
			// walk actually reached the last page, since otherwise "absent from
			// the inbox" just means "never asked for". Both confirm each block
			// with a live profile lookup before blocking anyone back.
			await reconcileCounterBlocks({
				blockedProfileIds: await apiFunctions
					.getBlockedProfileIds()
					.catch(() => [] as string[]),
				currentUserId: userId,
				blockProfile: (profileId) => apiFunctions.blockProfile(profileId),
				checkConversationAccessible: async (profileId) => {
					try {
						return classifyProfileAccess(
							await apiFunctions.getProfileDetail(profileId),
						);
					} catch {
						return "accessible";
					}
				},
				missingFromInbox: walkedEveryPage ? { sweepStartedAt } : undefined,
			}).catch((error) => {
				appLog.warn("[inbox-sync] counter-block reconciliation failed", error);
			});
			const totalConversations = await chatDb
				.listConversations({ includeArchived: true })
				.then((rows) => rows.length)
				.catch(() => conversationsSeen);
			setStatus(userId, {
				phase: "done",
				conversations: totalConversations,
				changed: changedConversations.length,
			});
			appLog.info("[inbox-sync] sync finished", {
				userId,
				conversations: totalConversations,
				changed: changedConversations.length,
			});
		}
	} catch (error) {
		appLog.error("[inbox-sync] sync failed", { userId, error });
		setStatus(userId, {
			phase: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
