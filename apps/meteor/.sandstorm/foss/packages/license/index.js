// SANDSTORM-FOSS-STUB (MIT). A Community build has no license: no modules, no
// limits, nothing to enforce. Covers the members core code uses at runtime.
const { EventEmitter } = require('node:events');

const noop = () => undefined;

const License = {
	hasModule: () => false,
	hasValidLicense: () => false,
	hasOfflineLicense: () => false,
	getLicense: () => undefined,
	getModules: () => [],
	getTags: () => [],
	getWorkspaceUrl: () => undefined,
	getHashedWorkspaceUrl: () => undefined,
	shouldPreventAction: async () => false,
	onValidFeature: noop,
	onInvalidFeature: noop,
	onLimitReached: noop,
	onValidateLicense: noop,
	onInvalidateLicense: noop,
	onRemoveLicense: noop,
	onLicense: noop,
	onModule: noop,
	onToggledFeature: () => noop,
};

class DuplicatedLicenseError extends Error {}

class AirGappedRestrictionClass extends EventEmitter {
	get restricted() {
		return false;
	}

	async computeRestriction() {
		this.emit('remainingDays', { days: -1 });
	}

	isWarningPeriod() {
		return false;
	}
}

module.exports = {
	License,
	LicenseManager: class {},
	DuplicatedLicenseError,
	AirGappedRestriction: new AirGappedRestrictionClass(),
	applyLicense: async () => false,
	applyLicenseOrRemove: async () => false,
	getAppsConfig: () => ({ maxPrivateApps: -1, maxMarketplaceApps: -1 }),
};
