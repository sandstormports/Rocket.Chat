// SANDSTORM-FOSS-STUB (MIT). Endpoints that declare required license modules are
// refused, since a Community build has none.
import type { MiddlewareHandler } from 'hono';

export const license =
	(options: { license?: string[] }, licenseManager: { hasModule(module: string): boolean }): MiddlewareHandler =>
	async (c, next) => {
		if (!options.license || options.license.every((module) => licenseManager.hasModule(module))) {
			return next();
		}
		return c.json(
			{ success: false, error: 'This is an enterprise feature [error-action-not-allowed]', errorType: 'error-action-not-allowed' },
			400,
		);
	};
