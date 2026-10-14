import { randomUUIDFromRandomValues } from './randomUUID';

describe('randomUUIDFromRandomValues', () => {
	it('returns version 4, variant 1 UUIDs', () => {
		for (let i = 0; i < 100; i++) {
			expect(randomUUIDFromRandomValues()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		}
	});

	it('does not repeat itself', () => {
		const ids = new Set(Array.from({ length: 1000 }, randomUUIDFromRandomValues));
		expect(ids.size).toBe(1000);
	});
});
