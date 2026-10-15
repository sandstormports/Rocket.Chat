import type { IMessage, MessageAttachment } from '@rocket.chat/core-typings';
import type { ServerMethods } from '@rocket.chat/ddp-client';
import { Messages, Rooms } from '@rocket.chat/models';
import { Random } from '@rocket.chat/random';
import { check, Match } from 'meteor/check';
import { Meteor } from 'meteor/meteor';

import { getSandstormBridge } from './bridge';
import type { SandstormGrain } from './bridge';
import { canAccessRoomAsync } from '../lib/authorization';
import { canSendMessageAsync } from '../lib/authorization/canSendMessage';
import { SystemLogger } from '../lib/logger/system';
import { sendMessage } from '../lib/messages/sendMessage';

// Sharing grains through the Powerbox. The client asks Sandstorm's Powerbox for
// a grain and passes the result to sandstorm.shareGrain, which keeps the grain
// and posts it to the room. Anyone in the room can then open it: clicking it
// calls sandstorm.openGrain, which offers the grain to them in Sandstorm.

// A shared grain links here; the client catches the click and calls
// sandstorm.openGrain instead (client/sandstorm/powerbox.ts). Attachment links
// must be absolute, and ROOT_URL is never reachable from a grain's browser.
const GRAIN_LINK_PATH = '.sandstorm-grain/';

type GrainMessage = IMessage & { sandstormGrain?: Pick<SandstormGrain, 'token' | 'title'> };

declare module '@rocket.chat/ddp-client' {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface ServerMethods {
		'sandstorm.shareGrain'(rid: string, tmid: string | undefined, requestToken: string, descriptor: string): IMessage['_id'];
		'sandstorm.openGrain'(mid: string): void;
	}
}

const sessionIdOf = (connection: Meteor.Connection | null): string => {
	// A Fetch Headers object when the method is called over REST (method.call), a plain object over DDP.
	const headers: unknown = connection?.httpHeaders;
	const sessionId =
		headers instanceof Headers
			? headers.get('x-sandstorm-session-id')
			: (headers as Record<string, unknown> | undefined)?.['x-sandstorm-session-id'];
	if (typeof sessionId !== 'string' || !sessionId) {
		throw new Meteor.Error('error-sandstorm-session', 'This request did not come through Sandstorm');
	}
	return sessionId;
};

const grainAttachment = (mid: IMessage['_id'], grain: SandstormGrain): MessageAttachment => ({
	title: grain.title,
	title_link: Meteor.absoluteUrl(`${GRAIN_LINK_PATH}${mid}`),
	...(grain.appTitle && { author_name: grain.appTitle, ...(grain.appIconUrl && { author_icon: grain.appIconUrl }) }),
});

export const registerPowerbox = (): void => {
	Meteor.methods<ServerMethods>({
		async 'sandstorm.shareGrain'(rid, tmid, requestToken, descriptor) {
			check(rid, String);
			check(tmid, Match.Maybe(String));
			check(requestToken, String);
			check(descriptor, String);

			const user = await Meteor.userAsync();
			if (!user) {
				throw new Meteor.Error('error-not-allowed', 'Not allowed');
			}
			const room = await canSendMessageAsync(rid, { uid: user._id, username: user.username, type: user.type });
			const sessionId = sessionIdOf(this.connection);

			let grain: SandstormGrain;
			try {
				grain = await getSandstormBridge().claimUiView(sessionId, requestToken, descriptor, `Shared in Rocket.Chat by ${user.username}`);
			} catch (err) {
				SystemLogger.error({ msg: 'Sandstorm grain could not be shared', err });
				throw new Meteor.Error('error-sandstorm-powerbox', 'The grain could not be shared');
			}

			const _id = Random.id();
			const message = {
				_id,
				msg: '',
				...(tmid && { tmid }),
				attachments: [grainAttachment(_id, grain)],
				sandstormGrain: { token: grain.token, title: grain.title },
			};
			await sendMessage(user, message, room);
			return _id;
		},

		async 'sandstorm.openGrain'(mid) {
			check(mid, String);

			const userId = Meteor.userId();
			if (!userId) {
				throw new Meteor.Error('error-not-allowed', 'Not allowed');
			}
			const message = await Messages.findOneById<Pick<GrainMessage, 'rid' | 'sandstormGrain'>>(mid, {
				projection: { rid: 1, sandstormGrain: 1 },
			});
			const room = message?.sandstormGrain && (await Rooms.findOneById(message.rid));
			if (!message?.sandstormGrain || !room || !(await canAccessRoomAsync(room, { _id: userId }))) {
				throw new Meteor.Error('error-not-allowed', 'Not allowed');
			}

			try {
				await getSandstormBridge().offerUiView(sessionIdOf(this.connection), message.sandstormGrain.token, message.sandstormGrain.title);
			} catch (err) {
				SystemLogger.error({ msg: 'Sandstorm grain could not be offered', err });
				throw new Meteor.Error('error-sandstorm-powerbox', 'The grain could not be opened');
			}
		},
	});
};
