// SANDSTORM-FOSS-STUB (MIT). Matrix federation is an Enterprise feature (and a grain has no network).
const { randomBytes } = require('node:crypto');

module.exports = {
	// An Ed25519 secret key is 32 random bytes; core only stores it as a setting default.
	generateEd25519RandomSecretKey: () => randomBytes(32),
	validateFederatedUsername: () => false,
};
