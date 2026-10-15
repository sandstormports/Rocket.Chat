// SANDSTORM-FOSS-STUB (MIT). The omnichannel queue worker and PDF transcripts are
// Enterprise features; these register under the same names and do nothing.
const { ServiceClassInternal } = require('@rocket.chat/core-services');

class QueueWorker extends ServiceClassInternal {
	constructor() {
		super();
		this.name = 'queue-worker';
	}
}

class OmnichannelTranscript extends ServiceClassInternal {
	constructor() {
		super();
		this.name = 'omnichannel-transcript';
	}
}

module.exports = { QueueWorker, OmnichannelTranscript };
