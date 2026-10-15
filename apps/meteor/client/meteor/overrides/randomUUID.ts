import { randomUUIDFromRandomValues } from '../../lib/utils/randomUUID';

// Browsers only provide crypto.randomUUID in secure contexts (HTTPS or localhost), but
// Rocket.Chat is also served over plain HTTP, e.g. by a Sandstorm server on an http://
// address, and uses it for request IDs (RoomHistoryManager). Without it rooms never
// load their history there.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
	Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: randomUUIDFromRandomValues });
}
