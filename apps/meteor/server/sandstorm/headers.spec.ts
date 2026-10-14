import { fromSandstormHeaderName, toSandstormHeaderName } from '../../lib/sandstormHeaders';

describe('Sandstorm header aliases', () => {
	it('moves custom headers under the X-Sandstorm-App- prefix', () => {
		expect(toSandstormHeaderName('X-Auth-Token')).toBe('x-sandstorm-app-auth-token');
		expect(toSandstormHeaderName('x-user-id')).toBe('x-sandstorm-app-user-id');
		expect(toSandstormHeaderName('X-2fa-Code')).toBe('x-sandstorm-app-2fa-code');
	});

	it('leaves standard, Sandstorm and already-forwarded headers alone', () => {
		expect(toSandstormHeaderName('Content-Type')).toBe('Content-Type');
		expect(toSandstormHeaderName('X-Sandstorm-User-Id')).toBe('X-Sandstorm-User-Id');
		expect(toSandstormHeaderName('X-Requested-With')).toBe('X-Requested-With');
		expect(toSandstormHeaderName('x-csrf-token')).toBe('x-csrf-token');
	});

	it('restores the original names', () => {
		expect(fromSandstormHeaderName('x-sandstorm-app-auth-token')).toBe('x-auth-token');
		expect(fromSandstormHeaderName('X-Sandstorm-App-User-Id')).toBe('x-user-id');
		expect(fromSandstormHeaderName(toSandstormHeaderName('X-Visitor-Token'))).toBe('x-visitor-token');
	});

	it('ignores headers that are not aliases', () => {
		expect(fromSandstormHeaderName('x-sandstorm-user-id')).toBeUndefined();
		expect(fromSandstormHeaderName('x-sandstorm-app-')).toBeUndefined();
		expect(fromSandstormHeaderName('x-auth-token')).toBeUndefined();
	});
});
