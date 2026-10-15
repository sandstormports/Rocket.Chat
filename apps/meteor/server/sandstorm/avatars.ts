import type { IncomingMessage, ServerResponse } from 'node:http';

import type { IUser } from '@rocket.chat/core-typings';
import { Users } from '@rocket.chat/models';
import { WebApp } from 'meteor/webapp';

import type { SandstormIdentity } from './identity';

// Users who have not set an avatar in Rocket.Chat show their Sandstorm profile
// picture. A grain cannot fetch it (it has no network access), but the browser
// can, from Sandstorm's static host; so the avatar URL redirects there.

type AvatarUser = Pick<IUser, 'avatarOrigin'> & { services?: { sandstorm?: Pick<SandstormIdentity, 'picture'> } };

const projection = { 'avatarOrigin': 1, 'services.sandstorm.picture': 1 };

const findUser = (path: string): Promise<AvatarUser | null> | undefined => {
	const [first, second] = path.split('/');
	if (first === 'room' || !first || first.startsWith('@')) {
		return undefined;
	}
	if (first === 'uid') {
		return second ? Users.findOneById<AvatarUser>(second, { projection }) : undefined;
	}
	return Users.findOneByUsernameIgnoringCase<AvatarUser>(first, { projection });
};

export const registerSandstormAvatars = (): void => {
	WebApp.rawConnectHandlers.use('/avatar/', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const path = decodeURIComponent((req.url ?? '').slice(1).replace(/\?.*$/, ''));
		const lookup = findUser(path);
		if (!lookup) {
			next();
			return;
		}

		void lookup.then(
			(user) => {
				const picture = user?.services?.sandstorm?.picture;
				if (!picture || user.avatarOrigin) {
					next();
					return;
				}
				// The picture changes when the user changes it in Sandstorm, under the same avatar URL.
				res.writeHead(302, { 'Location': picture, 'Cache-Control': 'no-cache' });
				res.end();
			},
			() => next(),
		);
	});
};
