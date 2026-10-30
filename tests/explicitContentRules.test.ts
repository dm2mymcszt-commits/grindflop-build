import { describe, expect, test } from "bun:test";
import {
	albumCoverFor,
	albumFaceVerdict,
	combineContentScores,
	coverForVerdict,
	decideExplicitBlock,
	isConversationParticipant,
	describeExplicitScores,
	EXPLICIT_BLOCK_SCORE,
	EXPLICIT_PROFILE_PHOTO_REASON,
	EXPLICIT_UNSURE_SCORE,
	explicitNotice,
	FACE_FAR_SHARE,
	faceVerdict,
	NO_CONTENT_SCORES,
	profileFaceVerdict,
	scoreDetections,
	sentMediaSaves,
	verdictFromScores,
} from "../src/utils/explicitContentRules";

const ME = 920000003;
const THEM = 111;
const ENABLED_AT = 1_790_000_000_000;

function verdictOf(detections: { label: string; score: number }[]) {
	return verdictFromScores(scoreDetections(detections));
}

describe("verdictFromScores", () => {
	test("nothing found is clear", () => {
		expect(verdictOf([])).toBe("clear");
	});

	test("a confident explicit detection is explicit", () => {
		expect(verdictOf([{ label: "MALE_GENITALIA_EXPOSED", score: 0.83 }])).toBe("explicit");
		expect(verdictOf([{ label: "ANUS_EXPOSED", score: EXPLICIT_BLOCK_SCORE }])).toBe("explicit");
		expect(verdictOf([{ label: "BUTTOCKS_EXPOSED", score: 0.6 }])).toBe("explicit");
	});

	test("the first real case blocks: a bare-buttocks photo with the back of a head", () => {
		expect(
			verdictOf([
				{ label: "BUTTOCKS_EXPOSED", score: 0.771 },
				{ label: "FACE_MALE", score: 0.329 },
				{ label: "MALE_BREAST_EXPOSED", score: 0.245 },
			]),
		).toBe("explicit");
	});

	test("a detection the detector is only half sure of covers, and does not block", () => {
		expect(verdictOf([{ label: "BUTTOCKS_EXPOSED", score: 0.5 }])).toBe("unsure");
		expect(verdictOf([{ label: "MALE_GENITALIA_EXPOSED", score: 0.59 }])).toBe("unsure");
	});

	test("a weak explicit detection is unsure, never clear", () => {
		expect(verdictOf([{ label: "MALE_GENITALIA_EXPOSED", score: 0.3 }])).toBe("unsure");
		expect(verdictOf([{ label: "MALE_GENITALIA_EXPOSED", score: EXPLICIT_UNSURE_SCORE }])).toBe("unsure");
	});

	test("a shirtless photo is clear, however confident", () => {
		expect(
			verdictOf([
				{ label: "MALE_BREAST_EXPOSED", score: 0.95 },
				{ label: "BELLY_EXPOSED", score: 0.9 },
				{ label: "ARMPITS_EXPOSED", score: 0.8 },
				{ label: "FACE_MALE", score: 0.9 },
			]),
		).toBe("clear");
	});

	test("underwear is clear: covered is not exposed", () => {
		expect(
			verdictOf([
				{ label: "BUTTOCKS_COVERED", score: 0.9 },
				{ label: "ANUS_COVERED", score: 0.7 },
				{ label: "FEMALE_GENITALIA_COVERED", score: 0.7 },
			]),
		).toBe("clear");
	});

	test("a chest the detector reads as a bare female one is still just a shirtless photo", () => {
		// It made that reading on 43 of 246 real profile photos of men.
		expect(verdictOf([{ label: "FEMALE_BREAST_EXPOSED", score: 0.9 }])).toBe("clear");
	});

	test("the strongest explicit detection decides, whatever else is there", () => {
		const scores = scoreDetections([
			{ label: "BELLY_EXPOSED", score: 0.99 },
			{ label: "BUTTOCKS_EXPOSED", score: 0.5 },
			{ label: "MALE_GENITALIA_EXPOSED", score: 0.7 },
		]);
		expect(scores.explicitLabel).toBe("MALE_GENITALIA_EXPOSED");
		expect(describeExplicitScores(scores)).toBe("genitals 70%");
	});

	test("the notice says what was seen and how sure", () => {
		const scores = scoreDetections([{ label: "BUTTOCKS_EXPOSED", score: 0.771 }]);
		expect(explicitNotice(EXPLICIT_PROFILE_PHOTO_REASON, scores)).toBe(
			"Explicit profile photo: bare buttocks, 77% sure",
		);
		expect(explicitNotice("Explicit photo", scoreDetections([]))).toBe("Explicit photo");
	});

	test("a score that is not a number is ignored", () => {
		expect(verdictOf([{ label: "MALE_GENITALIA_EXPOSED", score: Number.NaN }])).toBe("clear");
	});
});

describe("combineContentScores", () => {
	test("a video is as explicit as its worst frame", () => {
		const combined = combineContentScores([
			scoreDetections([{ label: "FACE_MALE", score: 0.8 }]),
			scoreDetections([{ label: "MALE_GENITALIA_EXPOSED", score: 0.7 }]),
			scoreDetections([]),
		]);
		expect(verdictFromScores(combined)).toBe("explicit");
		expect(combined.faceScore).toBe(0.8);
	});

	test("no frames is no evidence of anything", () => {
		expect(combineContentScores([])).toEqual(NO_CONTENT_SCORES);
	});
});

/** A face box of a given score and share of the photo, placed clear of the edges unless told otherwise. */
function face(score: number, share = 0.09, y = 0.3) {
	const side = Math.sqrt(share);
	return scoreDetections([{ label: "FACE_MALE", score, x: 0.2, y, width: side, height: side }]);
}

describe("faceVerdict", () => {
	test("a confident, close face is a face", () => {
		expect(faceVerdict(face(0.9))).toBe("face");
	});

	test("nothing found is no face", () => {
		expect(faceVerdict(scoreDetections([]))).toBe("no_face");
		expect(faceVerdict(face(0.1))).toBe("no_face");
	});

	test("a face too far away to recognise is no face, however sure the detector is", () => {
		expect(faceVerdict(face(0.9, FACE_FAR_SHARE * 0.8))).toBe("no_face");
	});

	test("the strongest face decides, with its own size", () => {
		const scores = scoreDetections([
			{ label: "FACE_MALE", score: 0.5, x: 0.5, y: 0.5, width: 0.01, height: 0.01 },
			{ label: "FACE_FEMALE", score: 0.8, x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
		]);
		expect(scores.faceScore).toBe(0.8);
		expect(scores.faceShare).toBeCloseTo(0.16);
		expect(faceVerdict(scores)).toBe("face");
	});

	test("a check made before sizes were kept is never a definite face or a far-away one", () => {
		const old = { ...NO_CONTENT_SCORES, faceScore: 0.9, faceShare: null };
		expect(faceVerdict(old)).toBe("unsure");
		expect(faceVerdict({ ...old, faceScore: 0.05 })).toBe("no_face");
	});

	// The cases below are real photos from the 2026-10-02 collection, by what
	// the detector reported for each.
	test("a chin at the top of a torso photo is not a face: its box runs off the photo", () => {
		expect(faceVerdict(face(0.64, 0.086, 0))).toBe("no_face");
		expect(faceVerdict(face(0.56, 0.032, 0.004))).toBe("no_face");
	});

	test("a face next to a cut-off chin still counts", () => {
		const scores = scoreDetections([
			{ label: "FACE_MALE", score: 0.7, x: 0.3, y: 0, width: 0.3, height: 0.1 },
			{ label: "FACE_MALE", score: 0.55, x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
		]);
		expect(scores.faceScore).toBe(0.55);
		expect(faceVerdict(scores)).toBe("face");
	});

	test("a full-length mirror selfie with a small but clear face is a face", () => {
		expect(faceVerdict(face(0.57, 0.011))).toBe("face");
	});

	test("someone standing a few metres off still shows their face: the user's call on real examples", () => {
		expect(faceVerdict(face(0.63, 0.0047))).toBe("face");
		expect(faceVerdict(face(0.69, 0.0053))).toBe("face");
		expect(faceVerdict(face(0.61, 0.0085))).toBe("face");
	});

	test("a speck of a face the detector is not sure of is no face", () => {
		expect(faceVerdict(face(0.23, 0.004))).toBe("no_face");
		expect(faceVerdict(face(0.63, 0.0015))).toBe("no_face");
	});

	test("the back or side of a head, and an emoji over a face, are no face", () => {
		expect(faceVerdict(face(0.2, 0.091))).toBe("no_face");
		expect(faceVerdict(face(0.22, 0.042))).toBe("no_face");
	});

	test("real faces the detector was only half sure of are unsure, never no face", () => {
		// A close face under a cap, and one looking away: 0.32 and 0.41.
		expect(faceVerdict(face(0.32, 0.115))).toBe("unsure");
		expect(faceVerdict(face(0.41, 0.129))).toBe("unsure");
	});

	test("a sure face of in-between size is unsure", () => {
		expect(faceVerdict(face(0.7, 0.003))).toBe("unsure");
	});
});

describe("profileFaceVerdict", () => {
	test("one photo with a face is enough", () => {
		expect(profileFaceVerdict(["no_face", "no_face", "face"])).toBe("face");
		expect(profileFaceVerdict([null, "face"])).toBe("face");
	});

	test("no face only when every photo is a definite no", () => {
		expect(profileFaceVerdict(["no_face", "no_face"])).toBe("no_face");
	});

	test("a photo that could not be checked, or is unsure, leaves the profile unsure", () => {
		expect(profileFaceVerdict(["no_face", null])).toBe("unsure");
		expect(profileFaceVerdict(["no_face", "unsure"])).toBe("unsure");
		expect(profileFaceVerdict([null])).toBe("unsure");
	});

	test("no photos at all is not this rule's business", () => {
		expect(profileFaceVerdict([])).toBe("unsure");
	});
});

describe("sentMediaSaves", () => {
	test("sending nothing saves nobody", () => {
		expect(sentMediaSaves([], false)).toBe(false);
		expect(sentMediaSaves([], true)).toBe(false);
	});

	test("without the face option, any media saves, as before", () => {
		expect(sentMediaSaves(["no_face"], false)).toBe(true);
	});

	test("with it, a photo of a face saves", () => {
		expect(sentMediaSaves(["no_face", "face"], true)).toBe(true);
	});

	test("with it, photos that all show no face do not save", () => {
		expect(sentMediaSaves(["no_face", "no_face"], true)).toBe(false);
	});

	test("anything that could not be judged saves: an album, a failed check, an unsure face", () => {
		expect(sentMediaSaves(["no_face", "unknown"], true)).toBe(true);
		expect(sentMediaSaves(["unsure"], true)).toBe(true);
	});
});

describe("albumCoverFor", () => {
	test("an album whose items are all clear is shown", () => {
		expect(albumCoverFor(["clear", "clear"])).toBeNull();
	});

	test("one explicit item covers the whole album", () => {
		expect(albumCoverFor(["clear", "explicit", "unsure"])).toBe("explicit");
	});

	test("an unsure item covers it too", () => {
		expect(albumCoverFor(["clear", "unsure"])).toBe("unsure");
	});

	test("an item nobody has checked, or an album nobody has opened, stays covered", () => {
		expect(albumCoverFor(["clear", null])).toBe("unchecked");
		expect(albumCoverFor([])).toBe("unchecked");
	});
});

describe("albumFaceVerdict", () => {
	test("one item with a face is enough", () => {
		expect(albumFaceVerdict(["no_face", "face"])).toBe("face");
	});

	test("no face only when every item was checked and none shows one", () => {
		expect(albumFaceVerdict(["no_face", "no_face"])).toBe("no_face");
	});

	test("anything less is unknown, which counts in their favour", () => {
		expect(albumFaceVerdict(["no_face", null])).toBe("unknown");
		expect(albumFaceVerdict(["no_face", "unsure"])).toBe("unknown");
		expect(albumFaceVerdict([])).toBe("unknown");
		expect(sentMediaSaves([albumFaceVerdict(["no_face", null])], true)).toBe(true);
	});
});

describe("coverForVerdict", () => {
	test("only a clear verdict uncovers", () => {
		expect(coverForVerdict("clear")).toBeNull();
		expect(coverForVerdict("explicit")).toBe("explicit");
		expect(coverForVerdict("unsure")).toBe("unsure");
	});

	test("a photo nobody has checked stays covered", () => {
		expect(coverForVerdict(null)).toBe("unchecked");
		expect(coverForVerdict(undefined)).toBe("unchecked");
	});
});

describe("decideExplicitBlock", () => {
	const base = {
		blockingEnabled: true,
		verdict: "explicit" as const,
		senderId: THEM,
		userId: ME,
		messageTimestamp: ENABLED_AT + 60_000,
		filterEnabledAt: ENABLED_AT,
		whitelisted: false,
		conversationArchived: false,
	};

	test("an explicit photo from someone else, sent after the filter went on, blocks", () => {
		expect(decideExplicitBlock(base)).toEqual({ block: true });
	});

	test("an unsure or clear verdict never blocks", () => {
		expect(decideExplicitBlock({ ...base, verdict: "unsure" })).toEqual({ block: false, why: "not_explicit" });
		expect(decideExplicitBlock({ ...base, verdict: "clear" })).toEqual({ block: false, why: "not_explicit" });
	});

	test("a photo that could not be checked never blocks", () => {
		expect(decideExplicitBlock({ ...base, verdict: null })).toEqual({ block: false, why: "not_explicit" });
	});

	test("this account's own photo never blocks the other person", () => {
		expect(decideExplicitBlock({ ...base, senderId: ME })).toEqual({ block: false, why: "own_message" });
		expect(decideExplicitBlock({ ...base, senderId: String(ME) })).toEqual({ block: false, why: "own_message" });
	});

	test("a sender that cannot be named is not blocked", () => {
		expect(decideExplicitBlock({ ...base, senderId: null })).toEqual({ block: false, why: "unknown_sender" });
		expect(decideExplicitBlock({ ...base, senderId: 0 })).toEqual({ block: false, why: "unknown_sender" });
		expect(decideExplicitBlock({ ...base, userId: null })).toEqual({ block: false, why: "unknown_sender" });
	});

	// A chat merged into another brings its photos along, still under the
	// profile that sent them. Looking at them must not block that old profile
	// again, nor anyone else.
	test("a photo merged in from a chat with another profile never blocks", () => {
		expect(decideExplicitBlock({ ...base, senderInConversation: false })).toEqual({
			block: false,
			why: "merged_history",
		});
	});

	test("a photo from the person the chat is with still blocks, and so does one that cannot be placed", () => {
		expect(decideExplicitBlock({ ...base, senderInConversation: true })).toEqual({ block: true });
		expect(decideExplicitBlock({ ...base, senderInConversation: null })).toEqual({ block: true });
	});

	test("old history does not block: only photos sent after the filter went on", () => {
		expect(decideExplicitBlock({ ...base, messageTimestamp: ENABLED_AT - 1 })).toEqual({
			block: false,
			why: "before_filter_was_on",
		});
		expect(decideExplicitBlock({ ...base, messageTimestamp: null })).toEqual({
			block: false,
			why: "before_filter_was_on",
		});
		expect(decideExplicitBlock({ ...base, filterEnabledAt: null })).toEqual({
			block: false,
			why: "before_filter_was_on",
		});
	});

	test("a message time in seconds is read as seconds", () => {
		expect(decideExplicitBlock({ ...base, messageTimestamp: (ENABLED_AT + 60_000) / 1000 })).toEqual({ block: true });
		expect(decideExplicitBlock({ ...base, messageTimestamp: (ENABLED_AT - 60_000) / 1000 })).toEqual({
			block: false,
			why: "before_filter_was_on",
		});
	});

	test("whitelisted people are covered, not blocked", () => {
		expect(decideExplicitBlock({ ...base, whitelisted: true })).toEqual({ block: false, why: "whitelisted" });
	});

	test("an archived chat is left alone", () => {
		expect(decideExplicitBlock({ ...base, conversationArchived: true })).toEqual({
			block: false,
			why: "conversation_archived",
		});
	});

	test("blocking switched off blocks nobody", () => {
		expect(decideExplicitBlock({ ...base, blockingEnabled: false })).toEqual({ block: false, why: "blocking_off" });
	});
});

describe("isConversationParticipant", () => {
	test("tells whether a profile is one of the two people a chat is between", () => {
		expect(isConversationParticipant("123:456", 123)).toBe(true);
		expect(isConversationParticipant("123:456", "456")).toBe(true);
		expect(isConversationParticipant("123:456", 789)).toBe(false);
	});

	test("does not take one id for another that starts the same", () => {
		expect(isConversationParticipant("123:456", 12)).toBe(false);
		expect(isConversationParticipant("123:456", "45")).toBe(false);
	});

	test("cannot tell for an id of another shape", () => {
		expect(isConversationParticipant("direct:123", 123)).toBeNull();
		expect(isConversationParticipant("123", 123)).toBeNull();
		expect(isConversationParticipant("", 123)).toBeNull();
		expect(isConversationParticipant("1:2:3", 2)).toBeNull();
	});
});
