import type { RestResponse } from "../types/chat-service";

export class ApiFunctionError extends Error {
	status: number;
	payload: unknown;

	constructor(message: string, status: number, payload: unknown) {
		super(message);
		this.name = "ApiFunctionError";
		this.status = status;
		this.payload = payload;
	}
}

export async function parseJsonSafe(response: RestResponse | Response): Promise<unknown> {
	try {
		return response.json();
	} catch {
		return null;
	}
}

export async function assertSuccess(response: RestResponse | Response, fallbackMessage: string) {
	const status = "status" in response ? response.status : (response as Response).status;
	if (status >= 200 && status < 300) {
		return;
	}

	const payload = await parseJsonSafe(response);
	let message = fallbackMessage;

	if (payload && typeof payload === "object") {
		const p = payload as Record<string, unknown>;
		if (typeof p.message === "string" && p.message) {
			message = p.message;
		} else if (typeof p.error === "string" && p.error) {
			message = p.error;
		}
	}

	throw new ApiFunctionError(message, status, payload);
}
