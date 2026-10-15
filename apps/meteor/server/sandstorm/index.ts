import { registerHeaderAliases } from './headers';
import { registerSandstormLogin } from './login';

// Sandstorm integration. The grain launcher (.sandstorm/start.js) sets SANDSTORM=1;
// nothing is registered on a regular deployment.
if (process.env.SANDSTORM === '1') {
	// Lets the client know it runs in a grain (client/lib/meteorRuntimeConfig.ts).
	__meteor_runtime_config__.SANDSTORM = true;
	registerHeaderAliases();
	registerSandstormLogin();
}
