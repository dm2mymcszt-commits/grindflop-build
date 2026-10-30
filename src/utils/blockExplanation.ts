/**
 * How and why someone was blocked, read from the Stats block log and kept
 * free of storage and wording so it can be tested on its own.
 *
 * The log's reason is the sentence the blocker put in its notification, plus
 * the kind read out of it (statsLogRules.classifyBlockReason). This turns one
 * log row into the handful of facts the profile screen words for the user, so
 * a wrong automatic block can be spotted and undone from there.
 */

/** One row of stats_block_log, as chatDb hands it over. */
export type BlockLogEntry = {
	eventType: string;
	timestamp: number;
	method: string | null;
	source: string | null;
	reasonKind: string | null;
	reasonDetail: string | null;
	reasonLabel: string | null;
	ruleName: string | null;
};

/** What triggered the block. `unknown` is an automatic block of unrecorded origin. */
export type BlockTrigger =
	| "manual"
	| "view_scan"
	| "inbox_scan"
	| "inbox_filter"
	| "live_chat"
	| "automation"
	| "counter_block"
	| "unknown";

export type BlockReasonKind =
	| "age"
	| "no_age"
	| "distance"
	| "right_now"
	| "looking_for"
	| "social_link"
	| "name_keyword"
	| "bio_keyword"
	| "message_keyword"
	| "keyword"
	| "first_message"
	| "first_media"
	| "left_on_seen"
	| "faceless_no_media"
	| "faceless_sent_photos"
	| "faceless_profile_photos"
	| "faceless"
	| "explicit_profile_photo"
	| "explicit_video"
	| "explicit_photo"
	| "rule"
	| "counter_block"
	| "other";

export type BlockExplanation = {
	timestamp: number;
	automatic: boolean;
	trigger: BlockTrigger;
	/** Null for a manual block: nothing decided it but the user. */
	reason: {
		kind: BlockReasonKind;
		/** The age, the keyword, the minutes — whatever the kind carries. */
		detail: string | null;
		/** The blocker's own sentence, for kinds this file has no wording for. */
		label: string | null;
	} | null;
};

const AUTOMATIC_TRIGGERS: ReadonlySet<string> = new Set([
	"view_scan",
	"inbox_scan",
	"inbox_filter",
	"live_chat",
	"automation",
	"counter_block",
]);

/** Kinds that mean nothing without their detail fall back to a plainer one. */
const NEEDS_DETAIL: Partial<Record<BlockReasonKind, BlockReasonKind>> = {
	name_keyword: "keyword",
	bio_keyword: "keyword",
	message_keyword: "keyword",
	age: "other",
	left_on_seen: "other",
	first_message: "other",
};

const PLAIN_KINDS: ReadonlySet<string> = new Set([
	"age",
	"no_age",
	"distance",
	"right_now",
	"looking_for",
	"social_link",
	"name_keyword",
	"bio_keyword",
	"message_keyword",
	"keyword",
	"first_message",
	"first_media",
	"left_on_seen",
	"counter_block",
]);

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function resolveReasonKind(entry: BlockLogEntry, label: string | null): BlockReasonKind {
	const kind = entry.reasonKind ?? "other";
	if (kind === "faceless") {
		// The log keeps one kind for three different findings; the sentence
		// says which.
		if (label && /no media sent/i.test(label)) return "faceless_no_media";
		if (label && /photos they sent/i.test(label)) return "faceless_sent_photos";
		if (label && /profile photos/i.test(label)) return "faceless_profile_photos";
		return "faceless";
	}
	if (kind === "explicit_media") {
		if (label && /^(?:scanner:\s*)?explicit profile photo/i.test(label)) {
			return "explicit_profile_photo";
		}
		if (label && /^(?:scanner:\s*)?explicit video/i.test(label)) return "explicit_video";
		return "explicit_photo";
	}
	if (kind === "rule") return "rule";
	if (PLAIN_KINDS.has(kind)) return kind as BlockReasonKind;
	return "other";
}

/**
 * Null unless the newest thing logged about them is a block: an unblock since
 * means whatever blocks them now was not recorded here, and an older block's
 * reason would be passed off as this one's.
 */
export function explainBlock(entry: BlockLogEntry | null | undefined): BlockExplanation | null {
	if (!entry || entry.eventType !== "block") return null;
	if (!Number.isFinite(entry.timestamp) || entry.timestamp <= 0) return null;

	const source = entry.source ?? "";
	const automatic = entry.method === "auto";
	if (!automatic) {
		return { timestamp: entry.timestamp, automatic: false, trigger: "manual", reason: null };
	}

	const label = clean(entry.reasonLabel)?.replace(/^scanner:\s*/i, "") ?? null;
	let kind = resolveReasonKind(entry, label);
	let detail = clean(entry.reasonDetail);
	if (kind === "rule") {
		detail = clean(entry.ruleName) ?? detail;
	}
	if (detail === null && NEEDS_DETAIL[kind]) {
		kind = NEEDS_DETAIL[kind] as BlockReasonKind;
	}

	return {
		timestamp: entry.timestamp,
		automatic: true,
		trigger: AUTOMATIC_TRIGGERS.has(source) ? (source as BlockTrigger) : "unknown",
		reason: { kind, detail, label },
	};
}
