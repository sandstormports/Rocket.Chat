import { router } from '../providers/RouterProvider';

// Keeps the Sandstorm shell's address bar and window title in step with the
// app, so that a copied grain URL opens the same room.
// https://docs.sandstorm.io/en/latest/developing/path/
export const syncWithShell = (): void => {
	const postToShell = (message: Record<string, string>): void => window.parent.postMessage(message, '*');

	let path: string | undefined;
	const syncPath = (): void => {
		const current = `${router.getLocationPathname()}${router.getLocationSearch()}${router.getLocationHash()}`;
		if (current !== path) {
			path = current;
			postToShell({ setPath: current });
		}
	};
	router.subscribeToRouteChange(syncPath);
	syncPath();

	let title: string | undefined;
	const syncTitle = (): void => {
		if (document.title !== title) {
			title = document.title;
			postToShell({ setTitle: title });
		}
	};
	new MutationObserver(syncTitle).observe(document.head, { childList: true, subtree: true, characterData: true });
	syncTitle();
};
