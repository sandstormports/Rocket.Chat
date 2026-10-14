// SANDSTORM-FOSS-STUB (MIT). Replaces the Enterprise-licensed apps/meteor/ee/server
// in the Community build made by .sandstorm/build.sh. core imports this barrel from
// server/main.ts; see .sandstorm/foss/README.md.
import { API } from '../../server/api/api';
import { registerModel, ReadReceiptsDummy } from '@rocket.chat/models';

import './presence';

// Models only the EE code registers but core touches unconditionally (e.g. when
// deleting messages or users); without a registration their proxies throw.
registerModel('IReadReceiptsArchiveModel', new ReadReceiptsDummy(), false);

const LIMIT_KINDS = ['activeUsers', 'guestUsers', 'roomsPerGuest', 'privateApps', 'marketplaceApps', 'monthlyActiveContacts'] as const;

// The client asks for license info on every page load; a Community build has none.
API.v1.addRoute(
	'licenses.info',
	{ authRequired: true },
	{
		async get() {
			return API.v1.success({
				license: {
					activeModules: [],
					externalModules: [],
					preventedActions: Object.fromEntries(LIMIT_KINDS.map((kind) => [kind, false])),
					limits: Object.fromEntries(LIMIT_KINDS.map((kind) => [kind, { max: -1 }])),
					tags: [],
					trial: false,
					hasValidLicense: false,
				},
			});
		},
	},
);

API.v1.addRoute(
	'licenses.maxActiveUsers',
	{ authRequired: true },
	{
		async get() {
			return API.v1.success({ maxActiveUsers: null, activeUsers: 0 });
		},
	},
);

// The Apps-Engine orchestrator is Enterprise-licensed; a Community build runs without apps.
export const startupApp = async (): Promise<void> => undefined;

export const registerEEBroker = async (): Promise<void> => undefined;
