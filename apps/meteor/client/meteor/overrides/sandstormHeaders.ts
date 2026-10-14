import { toSandstormHeaderName } from '../../../lib/sandstormHeaders';
import { isSandstorm } from '../../lib/meteorRuntimeConfig';

// Sandstorm's HTTP bridge only forwards a whitelist of non-standard request headers,
// which drops Rocket.Chat's X-User-Id / X-Auth-Token (and X-2fa-*, ...). Headers
// named X-Sandstorm-App-* are always forwarded, so inside a grain every request to
// the grain sends its custom headers under that prefix; server/sandstorm maps them
// back.
if (isSandstorm()) {
	const isSameOrigin = (url: string | URL): boolean => {
		try {
			return new URL(url, window.location.href).origin === window.location.origin;
		} catch {
			return false;
		}
	};

	const renameHeaders = (init: HeadersInit | undefined): Headers => {
		const headers = new Headers(init);
		const renamed = new Headers();
		headers.forEach((value, name) => renamed.set(toSandstormHeaderName(name), value));
		return renamed;
	};

	const originalFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : input;
		if (!isSameOrigin(url)) {
			return originalFetch(input, init);
		}
		if (input instanceof Request) {
			return originalFetch(new Request(input, { ...init, headers: renameHeaders(init?.headers ?? input.headers) }));
		}
		return originalFetch(input, { ...init, headers: renameHeaders(init?.headers) });
	};

	const sameOriginRequests = new WeakSet<XMLHttpRequest>();
	const { open, setRequestHeader } = XMLHttpRequest.prototype;
	XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
		if (isSameOrigin(args[1])) {
			sameOriginRequests.add(this);
		}
		return open.apply(this, args);
	} as XMLHttpRequest['open'];
	XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
		return setRequestHeader.call(this, sameOriginRequests.has(this) ? toSandstormHeaderName(name) : name, value);
	};
}
