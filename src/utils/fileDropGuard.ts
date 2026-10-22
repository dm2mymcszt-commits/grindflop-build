/**
 * Keeps a file dropped on the wrong spot from replacing the app.
 *
 * The window hands file drops to the page itself, so that a photo can be
 * dropped onto a chat. A browser's answer to a file dropped anywhere else is
 * to open it, which would swap the whole app for a picture. This turns every
 * file drop that no part of the page has claimed into nothing at all.
 */

function isFileDrag(event: DragEvent): boolean {
	return event.dataTransfer?.types.includes("Files") ?? false;
}

function refuseUnclaimedFile(event: DragEvent): void {
	// A part of the page that takes files has already said so by now: its own
	// handlers run before the window's.
	if (!isFileDrag(event) || event.defaultPrevented) {
		return;
	}
	event.preventDefault();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "none";
	}
}

let installed = false;

export function installFileDropGuard(): void {
	if (installed || typeof window === "undefined") {
		return;
	}
	installed = true;
	window.addEventListener("dragover", refuseUnclaimedFile);
	window.addEventListener("drop", refuseUnclaimedFile);
}
