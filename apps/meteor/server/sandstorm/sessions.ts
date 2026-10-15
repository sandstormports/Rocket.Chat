import type { IncomingMessage, ServerResponse } from 'node:http';

import { WebApp } from 'meteor/webapp';

// Calls to the Sandstorm API act on behalf of a session: an activity event is
// attributed to the session's user, and a Powerbox offer is shown in it. The
// latest session seen for each Sandstorm user is kept so that work done after
// the request (e.g. afterSaveMessage) can still be attributed to that user.
const sessions = new Map<string, string>();

const header = (req: IncomingMessage, name: string): string | undefined => {
	const value = req.headers[name];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const getSessionId = (req: IncomingMessage): string | undefined => header(req, 'x-sandstorm-session-id');

export const getLatestSessionId = (sandstormUserId: string): string | undefined => sessions.get(sandstormUserId);

export const forgetSessionId = (sandstormUserId: string, sessionId: string): void => {
	if (sessions.get(sandstormUserId) === sessionId) {
		sessions.delete(sandstormUserId);
	}
};

export const registerSessionTracking = (): void => {
	WebApp.rawConnectHandlers.use((req: IncomingMessage, _res: ServerResponse, next: () => void) => {
		const sandstormUserId = header(req, 'x-sandstorm-user-id');
		const sessionId = getSessionId(req);
		if (sandstormUserId && sessionId) {
			sessions.set(sandstormUserId, sessionId);
		}
		next();
	});
};
