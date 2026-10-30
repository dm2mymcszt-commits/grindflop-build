import z from "zod";

/**
 * What the Rust side reports about an account's standing with Grindr, and the
 * few things the screen showing it has to work out. Nothing is imported here
 * beyond zod, so the tests can load it.
 */

/** The Rust side announces every change of the signed-in account's standing on this event. */
export const ACCOUNT_STATUS_EVENT = "auth:account-status";

/** A sign-in, or the renewal of a session, that Grindr answered with one of its ban codes. */
export const banInfoSchema = z.object({
	/** What the refusal is aimed at: "profile", "device", "network" or "underage". */
	kind: z.string(),
	code: z.number(),
	message: z.string().nullish(),
	reason: z.string().nullish(),
	subReason: z.string().nullish(),
	automated: z.boolean().nullish(),
});

/** A limit the session token says Grindr has put on the account. */
export const restrictionSchema = z.object({
	/** "ageVerification", "timedBan", "trustVendorRejected" or "other". */
	kind: z.string(),
	/** Grindr's own name for it. */
	code: z.string().nullish(),
	/** Where an age check applies: "uk", "br", "au", "us" or "other". */
	region: z.string().nullish(),
	reason: z.string().nullish(),
	/** When a timed ban ends, in Unix seconds. */
	expiresAt: z.number().nullish(),
	subReason: z.string().nullish(),
	automated: z.boolean().nullish(),
});

export const accountStatusSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("banned"), info: banInfoSchema }),
	z.object({ kind: z.literal("restriction"), restriction: restrictionSchema }),
	/** A token sign-in whose token has run out, with nothing to renew it with. */
	z.object({ kind: z.literal("sessionExpired") }),
]);

export type BanInfo = z.infer<typeof banInfoSchema>;
export type Restriction = z.infer<typeof restrictionSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/**
 * Reads a status as the Rust side sends it. Anything else, a kind added later
 * included, is no status: this only decides what the user is told, and an
 * answer nobody can read is better left unsaid than guessed at.
 */
export function parseAccountStatus(value: unknown): AccountStatus | null {
	const parsed = accountStatusSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The status a sign-in result's `restriction` field stands for. */
export function restrictionStatus(value: unknown): AccountStatus | null {
	const parsed = restrictionSchema.safeParse(value);
	return parsed.success ? { kind: "restriction", restriction: parsed.data } : null;
}

/** The ban details a refused sign-in carries in its error. */
export function parseBanInfo(value: unknown): BanInfo | null {
	const parsed = banInfoSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * Two statuses with the same key say the same thing. Dismissing one covers
 * every repeat of it, and anything that differs is shown again.
 */
export function accountStatusKey(status: AccountStatus): string {
	if (status.kind === "banned") {
		const { info } = status;
		return JSON.stringify([
			"banned",
			info.kind,
			info.code,
			info.message ?? null,
			info.reason ?? null,
			info.subReason ?? null,
			info.automated ?? null,
		]);
	}
	if (status.kind === "restriction") {
		const { restriction } = status;
		return JSON.stringify([
			"restriction",
			restriction.kind,
			restriction.code ?? null,
			restriction.region ?? null,
			restriction.reason ?? null,
			restriction.expiresAt ?? null,
			restriction.subReason ?? null,
			restriction.automated ?? null,
		]);
	}
	return JSON.stringify([status.kind]);
}

/**
 * One of Grindr's codes ("DRUG_SALES") as words ("Drug sales"). Text that was
 * already written for people, such as a vendor's own sentence, is kept as it is.
 */
export function humanizeCode(code: string): string {
	const trimmed = code.trim();
	if (!/^[A-Z0-9]+(?:_+[A-Z0-9]+)*$/.test(trimmed) || !/[A-Z]/.test(trimmed)) {
		return trimmed;
	}
	const words = trimmed.replace(/_+/g, " ").toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * When a timed ban ends, in milliseconds. Grindr documents Unix seconds; a
 * number too large to be seconds is taken as milliseconds already. Returns
 * null for anything that is not a usable moment.
 */
export function expiryToMillis(expiresAt: number | null | undefined): number | null {
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
		return null;
	}
	const millis = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
	return Number.isFinite(new Date(millis).getTime()) ? millis : null;
}
