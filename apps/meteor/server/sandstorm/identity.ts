import type { IncomingHttpHeaders } from 'node:http';

// The identity sandstorm-http-bridge attaches to every request it forwards.
// The bridge strips any X-Sandstorm-* headers the browser sends, so on a grain
// these headers can be trusted.
// https://docs.sandstorm.io/en/latest/developing/auth/
export type SandstormIdentity = {
	id: string;
	name: string;
	permissions: string[];
	picture?: string;
	preferredHandle?: string;
	pronouns?: string;
};

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
	const value = headers[name];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const decode = (value: string): string => {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
};

// Returns undefined for visitors Sandstorm has not authenticated (no user ID).
export const readSandstormIdentity = (headers: IncomingHttpHeaders): SandstormIdentity | undefined => {
	const id = header(headers, 'x-sandstorm-user-id');
	if (!id) {
		return undefined;
	}

	const preferredHandle = header(headers, 'x-sandstorm-preferred-handle');
	return {
		id,
		// X-Sandstorm-Username is percent-encoded UTF-8.
		name: decode(header(headers, 'x-sandstorm-username') || preferredHandle || id),
		permissions: (header(headers, 'x-sandstorm-permissions') || '').split(',').filter(Boolean),
		picture: header(headers, 'x-sandstorm-user-picture'),
		preferredHandle,
		pronouns: header(headers, 'x-sandstorm-user-pronouns'),
	};
};
