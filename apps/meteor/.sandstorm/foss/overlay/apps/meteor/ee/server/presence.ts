// SANDSTORM-FOSS-STUB (MIT). Feeds DDP connections to the Presence service (the
// MIT implementation in .sandstorm/foss/packages/presence), which the
// Enterprise-licensed broker startup does in a regular build.
import { Presence } from '@rocket.chat/core-services';
import { Accounts } from 'meteor/accounts-base';
import { Meteor } from 'meteor/meteor';

const NODE_ID = 'local';

// Only real DDP sockets count: REST logins also fire Accounts.onLogin, with a
// synthetic connection that never closes.
const ddpConnections = new Set<string>();
const userByConnection = new Map<string, string>();

Meteor.onConnection((connection) => {
	ddpConnections.add(connection.id);
	connection.onClose(() => {
		ddpConnections.delete(connection.id);
		const uid = userByConnection.get(connection.id);
		userByConnection.delete(connection.id);
		if (uid) {
			void Presence.removeConnection(uid, connection.id, NODE_ID);
		}
	});
});

Accounts.onLogin((login: { user?: { _id: string }; connection?: { id: string } }) => {
	const uid = login.user?._id;
	const connectionId = login.connection?.id;
	if (!uid || !connectionId || !ddpConnections.has(connectionId)) {
		return;
	}
	const previous = userByConnection.get(connectionId);
	userByConnection.set(connectionId, uid);
	if (previous && previous !== uid) {
		void Presence.removeConnection(previous, connectionId, NODE_ID);
	}
	void Presence.newConnection(uid, connectionId, NODE_ID);
});

Accounts.onLogout((logout: { user?: { _id: string }; connection?: { id: string } }) => {
	const connectionId = logout.connection?.id;
	if (!connectionId) {
		return;
	}
	const uid = logout.user?._id ?? userByConnection.get(connectionId);
	userByConnection.delete(connectionId);
	if (uid) {
		void Presence.removeConnection(uid, connectionId, NODE_ID);
	}
});
