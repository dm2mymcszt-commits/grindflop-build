export type SyncProtocolErrorCode =
	| "invalid-package"
	| "unsupported-version"
	| "integrity-failed"
	| "identity-mismatch"
	| "sequence-gap"
	| "chain-mismatch"
	| "identifier-collision";

export class SyncProtocolError extends Error {
	readonly code: SyncProtocolErrorCode;
	readonly cause?: unknown;

	constructor(code: SyncProtocolErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "SyncProtocolError";
		this.code = code;
		this.cause = cause;
	}
}
