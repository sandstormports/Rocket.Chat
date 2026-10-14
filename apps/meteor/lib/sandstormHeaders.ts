// Sandstorm's HTTP bridge forwards only whitelisted non-standard request headers,
// but always forwards X-Sandstorm-App-*. Inside a grain the client sends its custom
// X-* headers under that prefix (client/meteor/overrides/sandstormHeaders.ts) and
// the server restores them (server/sandstorm/headers.ts).
// See headerWhitelist in Sandstorm's src/sandstorm/web-session.capnp.

const APP_PREFIX = 'x-sandstorm-app-';

// Non-standard headers the bridge forwards as they are.
const FORWARDED = new Set(['x-requested-with', 'x-csrftoken', 'x-csrf-token']);

export const toSandstormHeaderName = (name: string): string => {
	const lower = name.toLowerCase();
	if (!lower.startsWith('x-') || lower.startsWith('x-sandstorm-') || FORWARDED.has(lower)) {
		return name;
	}
	return `${APP_PREFIX}${lower.slice(2)}`;
};

// The original header name for an aliased one, or undefined if `name` is not an alias.
export const fromSandstormHeaderName = (name: string): string | undefined => {
	const lower = name.toLowerCase();
	return lower.startsWith(APP_PREFIX) && lower.length > APP_PREFIX.length ? `x-${lower.slice(APP_PREFIX.length)}` : undefined;
};
