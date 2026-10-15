import { isEditedMessage } from '@rocket.chat/core-typings';
import type { IMessage, IRoom, IUser } from '@rocket.chat/core-typings';
import { Messages, Subscriptions, Users } from '@rocket.chat/models';

import { getSandstormBridge } from './bridge';
import type { SandstormIdentity } from './identity';
import { forgetSessionId, getLatestSessionId } from './sessions';
import { getMentions } from '../hooks/messages/notifyUsersOnMessage';
import { callbacks } from '../lib/callbacks';
import { SystemLogger } from '../lib/logger/system';
import { roomCoordinator } from '../lib/rooms/roomCoordinator';

// Reports new messages to Sandstorm as activity events. Sandstorm marks the
// grain unread for the people who can see the message, and notifies the ones it
// concerns: the other side of a direct message, @-mentioned members, and the
// followers of a thread.

// Indexes into sandstorm-pkgdef.capnp's bridgeConfig.viewInfo.eventTypes.
const EVENT_TYPES = { message: 0, privateMessage: 1 } as const;

const CAPTION_LENGTH = 140;

type SandstormUser = Pick<IUser, '_id'> & { services?: { sandstorm?: Pick<SandstormIdentity, 'id'> } };

const sandstormIds = async (userIds: Iterable<string>): Promise<Map<string, string>> => {
	const users = await Users.find<SandstormUser>(
		{ '_id': { $in: [...userIds] }, 'services.sandstorm.id': { $exists: true } },
		{ projection: { 'services.sandstorm.id': 1 } },
	).toArray();
	return new Map(users.flatMap((user) => (user.services?.sandstorm ? [[user._id, user.services.sandstorm.id]] : [])));
};

const memberIds = async (room: IRoom): Promise<string[]> => {
	if (room.t === 'd' && room.uids) {
		return room.uids;
	}
	const subscriptions = await Subscriptions.findByRoomId(room._id, { projection: { 'u._id': 1 } }).toArray();
	return subscriptions.map(({ u }) => u._id);
};

// Members who would want to be told about the message, minus those who muted the room or the sender.
const notifiedIds = async (message: IMessage, room: IRoom): Promise<Set<string>> => {
	const senderId = message.u._id;
	const notMuted = { 'rid': room._id, 'u._id': { $ne: senderId }, 'disableNotifications': { $ne: true }, 'ignored': { $ne: senderId } };

	if (room.t === 'd') {
		const subscriptions = await Subscriptions.find(notMuted, { projection: { 'u._id': 1 } }).toArray();
		return new Set(subscriptions.map(({ u }) => u._id));
	}

	const { toAll, toHere, mentionIds } = await getMentions(message);
	const candidates = new Set(mentionIds);
	if (message.tmid) {
		const thread = await Messages.findOneById<Pick<IMessage, 'replies'>>(message.tmid, { projection: { replies: 1 } });
		thread?.replies?.forEach((id) => candidates.add(id));
	}

	const subscriptions = await Subscriptions.find(
		{
			...notMuted,
			$or: [{ 'u._id': { $in: [...candidates] } }, ...(toAll || toHere ? [{ muteGroupMentions: { $ne: true } }] : [])],
		},
		{ projection: { 'u._id': 1 } },
	).toArray();
	return new Set(subscriptions.map(({ u }) => u._id));
};

const messagePath = (message: IMessage, room: IRoom): string => {
	const roomPath = roomCoordinator.getRouteLink(room.t, { rid: room._id, name: room.name }) || '/home';
	const path = message.tmid ? `${roomPath}/thread/${message.tmid}` : roomPath;
	return `${path.replace(/^\//, '')}?msg=${message._id}`;
};

const caption = (message: IMessage): string => {
	const text = message.msg || message.attachments?.[0]?.title || message.file?.name || '';
	const full = `${message.u.name || message.u.username}: ${text}`;
	return full.length > CAPTION_LENGTH ? `${full.slice(0, CAPTION_LENGTH - 1)}…` : full;
};

const reportMessage = async (message: IMessage, room: IRoom): Promise<void> => {
	const senderSandstormId = (await sandstormIds([message.u._id])).get(message.u._id);
	const sessionId = senderSandstormId && getLatestSessionId(senderSandstormId);
	if (!senderSandstormId || !sessionId) {
		return;
	}

	const isPrivate = room.t === 'd' || room.t === 'p';
	const notified = await notifiedIds(message, room);
	// A private room's events are visible only to the users they list, so every member is listed.
	const listed = isPrivate ? new Set([...(await memberIds(room)), ...notified]) : notified;
	listed.delete(message.u._id);
	const ids = await sandstormIds(listed);

	try {
		await getSandstormBridge().reportActivity(sessionId, {
			path: messagePath(message, room),
			type: isPrivate ? EVENT_TYPES.privateMessage : EVENT_TYPES.message,
			caption: caption(message),
			users: [...ids].map(([userId, id]) => ({ id, mentioned: notified.has(userId) })),
		});
	} catch (err) {
		// The session may have ended; the user's next request brings a new one.
		forgetSessionId(senderSandstormId, sessionId);
		SystemLogger.warn({ msg: 'Sandstorm activity event not sent', err });
	}
};

export const registerActivityEvents = (): void => {
	callbacks.add(
		'afterSaveMessage',
		(message, { room }) => {
			// System messages, edits and omnichannel are not activity.
			if (message.t || isEditedMessage(message) || room.t === 'l') {
				return message;
			}
			void reportMessage(message, room);
			return message;
		},
		callbacks.priority.LOW,
		'sandstormActivity',
	);
};
