import type { IncomingMessage, ServerResponse } from 'node:http';

import { WebApp } from 'meteor/webapp';

import { fromSandstormHeaderName } from '../../lib/sandstormHeaders';

// Restores the X-* request headers the client sent as X-Sandstorm-App-* to get them
// past Sandstorm's HTTP bridge (see lib/sandstormHeaders.ts), before anything reads them.
export const registerHeaderAliases = (): void => {
	WebApp.rawConnectHandlers.use((req: IncomingMessage, _res: ServerResponse, next: () => void) => {
		for (const [name, value] of Object.entries(req.headers)) {
			const original = fromSandstormHeaderName(name);
			if (original && req.headers[original] === undefined && typeof value === 'string') {
				req.headers[original] = value;
				req.rawHeaders.push(original, value);
			}
		}
		next();
	});
};
