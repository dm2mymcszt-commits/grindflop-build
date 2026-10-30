import { translate } from "./translate";

/**
 * Block reasons are saved in English, and other code reads the saved wording
 * back (the block log, the profile screen, the old-account notes), so what is
 * saved must not change with the app's language. This puts a saved reason
 * into the app's language at the moment it is shown: a notification, a toast,
 * the detector's list. A sentence it does not know comes back untouched.
 */

const SEEN_WORDS: Record<string, () => string> = {
	genitals: () => translate("block_reason.seen.genitals", { defaultValue: "genitals" }),
	anus: () => translate("block_reason.seen.anus", { defaultValue: "anus" }),
	"bare buttocks": () => translate("block_reason.seen.bare_buttocks", { defaultValue: "bare buttocks" }),
};

const FIXED: Record<string, () => string> = {
	"no age set": () => translate("block_reason.no_age", { defaultValue: "No Age Set" }),
	"distance limit": () => translate("block_reason.distance", { defaultValue: "Distance limit" }),
	"has active 'right now' status": () =>
		translate("block_reason.right_now", { defaultValue: "Has active 'Right Now' status" }),
	"forbidden 'looking for' tag": () =>
		translate("block_reason.looking_for", { defaultValue: "Forbidden 'Looking For' tag" }),
	"has an x / twitter account": () =>
		translate("block_reason.social_link", { defaultValue: "Has an X / Twitter account" }),
	"keyword match": () => translate("block_reason.keyword", { defaultValue: "Keyword match" }),
	"first message was media (bot evasion)": () =>
		translate("block_reason.first_media", { defaultValue: "First message was media (Bot evasion)" }),
	"first message was only a link (bot)": () =>
		translate("block_reason.link_bot", { defaultValue: "First message was only a link (bot)" }),
	"faceless profile: no face in the photos they sent": () =>
		translate("block_reason.faceless_sent", { defaultValue: "Faceless profile: No face in the photos they sent" }),
	"faceless profile: no media sent 5min after first message": () =>
		translate("block_reason.faceless_no_media", {
			defaultValue: "Faceless profile: No media sent 5min after first message",
		}),
	"faceless profile: no face in profile photos": () =>
		translate("block_reason.faceless_profile", { defaultValue: "Faceless profile: No face in profile photos" }),
	"explicit photo": () => translate("block_reason.explicit_photo", { defaultValue: "Explicit photo" }),
	"explicit video": () => translate("block_reason.explicit_video", { defaultValue: "Explicit video" }),
	"explicit profile photo": () =>
		translate("block_reason.explicit_profile_photo", { defaultValue: "Explicit profile photo" }),
	"explicit album": () => translate("block_reason.explicit_album", { defaultValue: "Explicit album" }),
	"they blocked you": () => translate("block_reason.counter_block", { defaultValue: "They blocked you" }),
	"automation rule": () => translate("block_reason.rule", { defaultValue: "Automation rule" }),
	"grindr had dropped your block. blocked again.": () =>
		translate("block_reason.dropped_block", { defaultValue: "Grindr had dropped your block. Blocked again." }),
	"a photo they sent could not be checked. it stays covered and they were not blocked.": () =>
		translate("block_reason.left_alone.unchecked", {
			defaultValue: "A photo they sent could not be checked. It stays covered and they were not blocked.",
		}),
	"a photo they sent took too long to check. it stays covered and they were not blocked.": () =>
		translate("block_reason.left_alone.too_slow", {
			defaultValue: "A photo they sent took too long to check. It stays covered and they were not blocked.",
		}),
	"could not tell whether what they sent shows a face, so they were not blocked.": () =>
		translate("block_reason.left_alone.face_sent_unsure", {
			defaultValue: "Could not tell whether what they sent shows a face, so they were not blocked.",
		}),
	"could not tell whether their profile photos show a face, so they were not blocked.": () =>
		translate("block_reason.left_alone.face_profile_unsure", {
			defaultValue: "Could not tell whether their profile photos show a face, so they were not blocked.",
		}),
};

const WITH_DETAIL: readonly [RegExp, (detail: string) => string][] = [
	[/^age limit \((.+)\)$/i, (detail) => translate("block_reason.age", { defaultValue: "Age limit ({{detail}})", detail })],
	[
		/^distance limit \((.+)\)$/i,
		(detail) => translate("block_reason.distance_detail", { defaultValue: "Distance limit ({{detail}})", detail }),
	],
	[
		/^name keyword: (.+)$/i,
		(detail) => translate("block_reason.name_keyword", { defaultValue: "Name keyword: {{detail}}", detail }),
	],
	[
		/^bio keyword: (.+)$/i,
		(detail) => translate("block_reason.bio_keyword", { defaultValue: "Bio keyword: {{detail}}", detail }),
	],
	[
		/^message keyword: (.+)$/i,
		(detail) => translate("block_reason.message_keyword", { defaultValue: "Message keyword: {{detail}}", detail }),
	],
	[
		/^first message: (.+)$/i,
		(detail) => translate("block_reason.first_message", { defaultValue: "First message: {{detail}}", detail }),
	],
	[
		/^left on seen for (\d+)\s*min$/i,
		(detail) => translate("block_reason.left_on_seen", { defaultValue: "Left on seen for {{detail}}min", detail }),
	],
];

/** "Explicit photo: bare buttocks, 77% sure", as explicitNotice writes it. */
const SEEN_NOTICE = /^(explicit (?:photo|video|profile photo|album)): (.+), (\d+)% sure$/i;

export function localizeBlockReason(label: string): string {
	const scanner = /^scanner:\s*/i.exec(label);
	const text = (scanner ? label.slice(scanner[0].length) : label).trim();
	const lower = text.toLowerCase();

	const fixed = FIXED[lower];
	if (fixed) return fixed();

	const seen = SEEN_NOTICE.exec(text);
	if (seen) {
		const reason = FIXED[seen[1].toLowerCase()];
		const what = SEEN_WORDS[seen[2].toLowerCase()];
		if (reason) {
			return translate("block_reason.explicit_seen", {
				defaultValue: "{{reason}}: {{what}}, {{percent}}% sure",
				reason: reason(),
				what: what ? what() : seen[2],
				percent: seen[3],
			});
		}
	}

	for (const [pattern, build] of WITH_DETAIL) {
		const match = pattern.exec(text);
		if (match) return build(match[1]);
	}
	return label;
}
