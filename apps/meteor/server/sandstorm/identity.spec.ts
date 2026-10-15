import { readSandstormIdentity } from './identity';

describe('readSandstormIdentity', () => {
	it('returns undefined for anonymous visitors', () => {
		expect(readSandstormIdentity({ 'x-sandstorm-username': 'Anonymous%20User', 'x-sandstorm-permissions': '' })).toBeUndefined();
	});

	it('reads the bridge headers', () => {
		expect(
			readSandstormIdentity({
				'x-sandstorm-user-id': 'a11ce',
				'x-sandstorm-username': 'Alice%20Ow%C3%B1er',
				'x-sandstorm-preferred-handle': 'alice',
				'x-sandstorm-permissions': 'admin,participate',
				'x-sandstorm-user-picture': 'https://static.example/alice.png',
				'x-sandstorm-user-pronouns': 'female',
			}),
		).toEqual({
			id: 'a11ce',
			name: 'Alice Owñer',
			preferredHandle: 'alice',
			permissions: ['admin', 'participate'],
			picture: 'https://static.example/alice.png',
			pronouns: 'female',
		});
	});

	it('handles missing optional headers', () => {
		expect(readSandstormIdentity({ 'x-sandstorm-user-id': 'b0b', 'x-sandstorm-permissions': '' })).toEqual({
			id: 'b0b',
			name: 'b0b',
			permissions: [],
			picture: undefined,
			preferredHandle: undefined,
			pronouns: undefined,
		});
	});

	it('falls back to the preferred handle for the name', () => {
		expect(readSandstormIdentity({ 'x-sandstorm-user-id': 'c4', 'x-sandstorm-preferred-handle': 'carol' })?.name).toBe('carol');
	});

	it('keeps a malformed percent-encoded name as is', () => {
		expect(readSandstormIdentity({ 'x-sandstorm-user-id': 'd5', 'x-sandstorm-username': '100%' })?.name).toBe('100%');
	});
});
