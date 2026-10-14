// SANDSTORM-FOSS-STUB (MIT). The media-call server is an Enterprise feature; this
// accepts the calls core makes while it configures itself and never places a call.
const { EventEmitter } = require('node:events');

const callServer = {
	emitter: new EventEmitter(),
	setHooks: () => undefined,
	configure: () => undefined,
	receiveCallUpdate: () => undefined,
	receiveSignal: async () => undefined,
	hangupExpiredCalls: async () => undefined,
	scheduleExpirationCheck: () => undefined,
};

module.exports = {
	callServer,
	getSignalsForExistingCall: async () => [],
};
