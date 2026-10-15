import { registerPowerbox } from './powerbox';
import { syncWithShell } from './shell';
import { isSandstorm } from '../lib/meteorRuntimeConfig';

// Sandstorm integration for a grain's browser side; see server/sandstorm.
if (isSandstorm() && window.parent !== window) {
	syncWithShell();
	registerPowerbox();
}
