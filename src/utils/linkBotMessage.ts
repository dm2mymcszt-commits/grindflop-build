/**
 * linkBotMessage.ts — telling a link bot from a person.
 *
 * Bots and hacked accounts open with a bare link ("bassew.com") and nothing
 * else; a person does not. Someone counts as a link bot only when every
 * message they have ever sent is a bare link and this account never wrote
 * to them, so a link sent in the middle of a real conversation, or after a
 * "hey", never qualifies.
 *
 * A leaf module on purpose (no imports), so tests can import it.
 */

export const LINK_BOT_SETTING_KEY = "fg-block-link-bots";
/** Saved in English like every block reason; blockReasonText.ts translates it for display. */
export const LINK_BOT_REASON = "First message was only a link (bot)";

/** On unless turned off: the user asked for these chats to go without having to switch anything on. */
export function isLinkBotRuleEnabled(): boolean {
	try {
		return window.localStorage.getItem(LINK_BOT_SETTING_KEY) !== "false";
	} catch {
		return false;
	}
}

// A bare domain needs one of these endings to count, so that "Mr.Smith" or
// "lol.ok" is not taken for a link. With "http(s)://" or "www." in front,
// any ending counts.
const LINK_ENDINGS = new Set([
	"com", "net", "org", "info", "biz", "xyz", "top", "site", "online", "club", "live", "me", "io", "app",
	"link", "fun", "vip", "cc", "co", "shop", "store", "icu", "buzz", "win", "bid", "click", "pw", "tk",
	"ml", "ga", "cf", "gq", "best", "life", "world", "today", "space", "website", "tech", "pro", "one",
	"asia", "lol", "monster", "cyou", "rest", "sbs", "cfd", "bond", "quest", "beauty", "love", "sex",
	"porn", "xxx", "cam", "chat", "social", "date", "dating", "tv", "ru", "su", "ly", "gg", "ai", "to",
	"ws", "la", "mobi", "page", "fr", "de", "uk", "us", "eu", "be", "nl", "es", "it", "pl", "br", "in",
	"cn", "ph", "tw", "vn", "id", "my", "th", "kr", "jp", "mx", "ar", "ca", "au", "ch", "at", "pt", "se",
]);

const LINK_PATTERN =
	/^(https?:\/\/)?(www\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{2,5})?(?:[/?#]\S*)?$/i;

/** Whether a message is a link and nothing else, give or take quotes or a full stop around it. */
export function isLinkOnlyMessage(text: string | null | undefined): boolean {
	if (!text) return false;
	const bare = text.trim().replace(/^[<("'“«]+/, "").replace(/[>)"'”».,!;:]+$/, "");
	if (!bare || /\s/.test(bare)) return false;
	const match = LINK_PATTERN.exec(bare);
	if (!match) return false;
	if (match[1] || match[2]) return true;
	return LINK_ENDINGS.has(match[4].toLowerCase());
}

export type LinkBotMessage = {
	senderId?: unknown;
	type?: string | null;
	body?: unknown;
	text?: string | null;
};

/** The text of a stored or live message (`body.text`), or of an inbox preview (`text`). */
export function linkBotMessageText(message: LinkBotMessage): string {
	const body = message.body;
	if (typeof body === "string") return body;
	if (body && typeof body === "object" && typeof (body as { text?: unknown }).text === "string") {
		return (body as { text: string }).text;
	}
	return typeof message.text === "string" ? message.text : "";
}

/**
 * Whether a conversation's whole history says link bot: they sent at least
 * one message, every one of theirs is a bare link, and none came from this
 * account. The app's own notes ("You blocked this person", sender 0) do not
 * count either way.
 */
export function isLinkBotHistory(messages: readonly LinkBotMessage[], userId: number | string | null | undefined): boolean {
	if (userId == null) return false;
	let theirs = 0;
	for (const message of messages) {
		const sender = Number(message.senderId);
		if (!Number.isFinite(sender) || sender === 0) continue;
		if (message.type && /^system/i.test(message.type)) continue;
		if (sender === Number(userId)) return false;
		if (!isLinkOnlyMessage(linkBotMessageText(message))) return false;
		theirs += 1;
	}
	return theirs > 0;
}
