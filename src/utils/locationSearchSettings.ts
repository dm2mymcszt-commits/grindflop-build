/**
 * Whether the location screen puts the cursor in its search field as soon as
 * it opens. On a phone that brings the keyboard up at once, which not
 * everyone wants. Kept on the device, and on by default, as it always was.
 */
export const LOCATION_SEARCH_AUTOFOCUS_KEY = "fg-location-search-autofocus";

export function isLocationSearchAutoFocusEnabled(): boolean {
	try {
		return window.localStorage.getItem(LOCATION_SEARCH_AUTOFOCUS_KEY) !== "false";
	} catch {
		return true;
	}
}

export function setLocationSearchAutoFocusEnabled(enabled: boolean): void {
	try {
		window.localStorage.setItem(LOCATION_SEARCH_AUTOFOCUS_KEY, String(enabled));
	} catch {
		// Storage unavailable: the field simply keeps taking the cursor.
	}
}
