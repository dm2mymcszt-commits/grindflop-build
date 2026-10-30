import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
	BlockExplanation,
	BlockReasonKind,
	BlockTrigger,
} from "../../../../utils/blockExplanation";
import { formatDateTime24 } from "../../chat/chatUtils";
import { localizeBlockReason } from "../../../../utils/blockReasonText";

const HOW_DEFAULTS: Record<BlockTrigger, string> = {
	manual: "You blocked them yourself on {{date}}.",
	view_scan: "Blocked automatically on {{date}}, when they viewed your profile.",
	inbox_scan: "Blocked automatically on {{date}}, by the inbox scan.",
	inbox_filter: "Blocked automatically on {{date}}, by the inbox filter.",
	live_chat: "Blocked automatically on {{date}}, when their message arrived.",
	automation: "Blocked automatically on {{date}}, by an automation rule.",
	counter_block: "Blocked automatically on {{date}}, after they blocked you.",
	unknown: "Blocked automatically on {{date}}.",
};

const WHY_DEFAULTS: Record<BlockReasonKind, string> = {
	age: "Their age ({{detail}}) is outside your age limits.",
	no_age: "Their profile shows no age.",
	distance: "They are outside your distance limit.",
	right_now: "They have an active Right Now post.",
	looking_for: "Their profile has a \"Looking for\" tag you don't allow.",
	social_link: "Their profile links an X / Twitter account.",
	name_keyword: "Their name contains a banned keyword: \"{{detail}}\".",
	bio_keyword: "Their bio contains a banned keyword: \"{{detail}}\".",
	message_keyword: "Their message contained a banned keyword: \"{{detail}}\".",
	keyword: "A banned keyword matched.",
	first_message: "Their first message was a banned opener: \"{{detail}}\".",
	first_media: "Their first message was a photo or video.",
	left_on_seen: "They left you on seen for {{detail}} minutes.",
	faceless_no_media: "No face photo: they sent no photo within 5 minutes of their first message.",
	faceless_sent_photos: "No face photo: none of the photos they sent shows a face.",
	faceless_profile_photos: "No face photo: none of their profile photos shows a face.",
	faceless: "No face photo.",
	explicit_profile_photo: "An explicit profile photo.",
	explicit_video: "They sent an explicit video.",
	explicit_photo: "They sent an explicit photo.",
	rule: "An automation rule matched.",
	counter_block: "They blocked you first.",
	other: "The reason was not recorded.",
};

/** Kinds whose detail is what the detector saw, added after the sentence. */
const SEEN_DETAIL_KINDS: ReadonlySet<BlockReasonKind> = new Set<BlockReasonKind>([
	"explicit_profile_photo",
	"explicit_video",
	"explicit_photo",
]);

function describeReason(t: TFunction, reason: NonNullable<BlockExplanation["reason"]>): string {
	// Nothing this screen has wording for: the blocker's own sentence is
	// still more use than "not recorded".
	if (reason.kind === "other" && reason.label) return localizeBlockReason(reason.label);
	if (reason.kind === "rule" && reason.detail) {
		return t("profile_unavailable.why.rule_named", {
			defaultValue: "Automation rule: {{detail}}.",
			detail: reason.detail,
		});
	}
	const text = t(`profile_unavailable.why.${reason.kind}`, {
		defaultValue: WHY_DEFAULTS[reason.kind],
		detail: reason.detail ?? "",
	});
	return SEEN_DETAIL_KINDS.has(reason.kind) && reason.detail ? `${text} (${reason.detail})` : text;
}

/**
 * How and why this account blocked someone, in two lines: what triggered the
 * block and when, then the reason an automatic blocker gave. There to make a
 * wrong automatic block easy to spot, right next to Unblock.
 */
export function BlockExplanationLines({
	explanation,
	className,
	compact = false,
}: {
	explanation: BlockExplanation;
	className?: string;
	/** The smaller text of the chat's archived banner. */
	compact?: boolean;
}) {
	const lineClassName = `${compact ? "text-xs" : "text-sm leading-relaxed"} text-[var(--text)]`;
	const { t } = useTranslation();
	const how = t(`profile_unavailable.how.${explanation.trigger}`, {
		defaultValue: HOW_DEFAULTS[explanation.trigger],
		date: formatDateTime24(explanation.timestamp),
	});
	const why = explanation.reason ? describeReason(t, explanation.reason) : null;

	return (
		<div className={className}>
			<p className={lineClassName}>{how}</p>
			{why && (
				<p className={lineClassName}>
					<span className="font-semibold">
						{t("profile_unavailable.why.label", { defaultValue: "Why:" })}
					</span>{" "}
					{why}
				</p>
			)}
		</div>
	);
}
