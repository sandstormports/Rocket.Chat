import type { IncomingMessage, ServerResponse } from 'node:http';

import type { IUser } from '@rocket.chat/core-typings';
import { Users } from '@rocket.chat/models';
import { Accounts } from 'meteor/accounts-base';
import { WebApp } from 'meteor/webapp';

import { readSandstormIdentity } from './identity';
import type { SandstormIdentity } from './identity';
import { SystemLogger } from '../lib/logger/system';
import { notifyOnUserChange } from '../lib/notifyListener';
import { addUserRolesAsync } from '../lib/roles/addUserRoles';
import { removeUserFromRolesAsync } from '../lib/roles/removeUserFromRoles';
import { generateUsernameSuggestion } from '../lib/users/getUsernameSuggestion';

// Sandstorm login, built on Rocket.Chat's iframe authentication.
//
// The launcher (.sandstorm/start.js) points Accounts_Iframe_api_url here; the
// login page POSTs to it on load, and a `{ loginToken }` answer is passed to
// Meteor.loginWithToken (client/views/root/hooks/useIframe.ts). Visitors
// without a Sandstorm identity get a 401, so the login page frames
// Accounts_iframe_url (LOGIN_REQUIRED_PATH) instead.
//
// The header protocol follows kenton:accounts-sandstorm; unlike that package
// this issues a normal resume token, which Rocket.Chat's REST client needs.

const LOGIN_PATH = '/.sandstorm-login';
const LOGIN_REQUIRED_PATH = '/.sandstorm-login-required';

// Sandstorm permission (sandstorm-pkgdef.capnp viewInfo) that maps to the Rocket.Chat admin role.
const ADMIN_PERMISSION = 'admin';

const syncAdminRole = async (user: Pick<IUser, '_id' | 'roles'>, identity: SandstormIdentity): Promise<void> => {
	const shouldBeAdmin = identity.permissions.includes(ADMIN_PERMISSION);
	const isAdmin = user.roles?.includes('admin') ?? false;

	if (shouldBeAdmin && !isAdmin) {
		await addUserRolesAsync(user._id, ['admin']);
	} else if (!shouldBeAdmin && isAdmin) {
		await removeUserFromRolesAsync(user._id, ['admin']);
	} else {
		return;
	}

	const updated = await Users.findOneById(user._id, { projection: { roles: 1 } });
	if (updated) {
		void notifyOnUserChange({ clientAction: 'updated', id: user._id, diff: { roles: updated.roles } });
	}
};

const createUser = async (identity: SandstormIdentity): Promise<IUser['_id']> => {
	const username = await generateUsernameSuggestion({ name: identity.preferredHandle || identity.name });

	return Accounts.insertUserDoc(
		{
			profile: { name: identity.name },
			// Sandstorm permissions decide who is admin (syncAdminRole), not "first user wins".
			skipAdminCheck: true,
		},
		{
			username,
			name: identity.name,
			services: { sandstorm: identity },
		},
	);
};

const findOrCreateSandstormUser = async (identity: SandstormIdentity): Promise<IUser['_id']> => {
	const existing = await Users.findOne<Pick<IUser, '_id' | 'roles' | 'name'>>(
		{ 'services.sandstorm.id': identity.id },
		{ projection: { _id: 1, roles: 1, name: 1 } },
	);

	if (!existing) {
		const userId = await createUser(identity);
		const created = await Users.findOneById<Pick<IUser, '_id' | 'roles'>>(userId, { projection: { _id: 1, roles: 1 } });
		if (created) {
			await syncAdminRole(created, identity);
		}
		return userId;
	}

	await Users.updateOne({ _id: existing._id }, { $set: { 'services.sandstorm': identity } });
	await syncAdminRole(existing, identity);

	return existing._id;
};

// The login page can fire two requests at once on its first load; without this
// both would try to create the same new user.
const pendingLogins = new Map<string, Promise<IUser['_id']>>();

const loginSandstormUser = (identity: SandstormIdentity): Promise<IUser['_id']> => {
	const pending = pendingLogins.get(identity.id);
	if (pending) {
		return pending;
	}
	const login = findOrCreateSandstormUser(identity).finally(() => pendingLogins.delete(identity.id));
	pendingLogins.set(identity.id, login);
	return login;
};

const issueResumeToken = async (userId: IUser['_id']): Promise<string> => {
	const stampedToken = Accounts._generateStampedLoginToken();
	await Accounts._insertLoginToken(userId, stampedToken);
	return stampedToken.token;
};

const sendJSON = (res: ServerResponse, status: number, body: unknown): void => {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(body));
};

const LOGIN_REQUIRED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Rocket.Chat</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#2f343d;background:#fff;text-align:center}</style>
</head><body><p>Sign in to Sandstorm to join this chat.</p></body></html>`;

export const registerSandstormLogin = (): void => {
	WebApp.rawConnectHandlers.use(LOGIN_REQUIRED_PATH, (_req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(LOGIN_REQUIRED_PAGE);
	});

	WebApp.rawConnectHandlers.use(LOGIN_PATH, (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== 'POST') {
			res.setHeader('Allow', 'POST');
			sendJSON(res, 405, { error: 'method-not-allowed' });
			return;
		}

		const identity = readSandstormIdentity(req.headers);
		if (!identity) {
			sendJSON(res, 401, { error: 'not-logged-in-to-sandstorm' });
			return;
		}

		void (async () => {
			try {
				const userId = await loginSandstormUser(identity);
				sendJSON(res, 200, { loginToken: await issueResumeToken(userId) });
			} catch (err) {
				SystemLogger.error({ msg: 'Sandstorm login failed', err });
				sendJSON(res, 500, { error: 'sandstorm-login-failed' });
			}
		})();
	});
};
