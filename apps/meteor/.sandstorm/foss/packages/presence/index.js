// SANDSTORM-FOSS-STUB (MIT). A small presence service for the Sandstorm Community
// build, standing in for the Enterprise-licensed @rocket.chat/presence. It
// implements IPresence (packages/core-services/src/types/IPresence.ts) for a
// single server process, which is all a grain ever runs:
//
//   - DDP connections are reported by apps/meteor/ee/server/presence.ts (overlay)
//     and kept in memory, each with its own online/away state;
//   - a user's status is offline without connections, otherwise their manual
//     status (away, busy, invisible), a temporary "active state" (calendar or
//     call), or online/away from their connections;
//   - changes are written to the user and broadcast as `presence.status`, which
//     the streamer turns into client updates.
const { api, ServiceClassInternal } = require('@rocket.chat/core-services');
const { Users } = require('@rocket.chat/models');

const ONLINE = 'online';
const AWAY = 'away';
const OFFLINE = 'offline';

const USER_PROJECTION = { username: 1, name: 1, roles: 1, status: 1, statusDefault: 1, statusText: 1, statusSource: 1, statusExpiresAt: 1 };

class Presence extends ServiceClassInternal {
	constructor() {
		super();
		this.name = 'presence';
		// uid -> Map(connectionId -> 'online' | 'away')
		this.connections = new Map();
		// uid -> { statusDefault, statusSource, statusText, statusExpiresAt, statusId }
		this.activeStates = new Map();
		this.peak = 0;
		this.broadcastEnabled = true;
	}

	async started() {
		// Connections only live in this process, so nobody is connected after a restart.
		await Users.updateMany({ type: 'user', status: { $ne: OFFLINE } }, { $set: { status: OFFLINE, statusConnection: OFFLINE } });
	}

	connectionCount() {
		let count = 0;
		for (const sessions of this.connections.values()) {
			count += sessions.size;
		}
		return count;
	}

	connectionStatus(uid) {
		const sessions = this.connections.get(uid);
		if (!sessions || sessions.size === 0) {
			return OFFLINE;
		}
		return [...sessions.values()].includes(ONLINE) ? ONLINE : AWAY;
	}

	async refresh(uid, changes = {}) {
		const user = await Users.findOneById(uid, { projection: USER_PROJECTION });
		if (!user) {
			return false;
		}

		const statusConnection = this.connectionStatus(uid);
		const statusDefault = changes.statusDefault ?? user.statusDefault ?? ONLINE;
		const active = this.activeStates.get(uid);

		let status = statusConnection;
		if (statusConnection !== OFFLINE) {
			if (statusDefault !== ONLINE) {
				status = statusDefault;
			} else if (active) {
				status = active.statusDefault;
			}
		}

		const statusText = changes.statusText !== undefined ? String(changes.statusText).trim().slice(0, 120) : user.statusText;
		const statusSource = active && status === active.statusDefault ? active.statusSource : undefined;
		const statusExpiresAt = active && status === active.statusDefault ? active.statusExpiresAt : undefined;

		await Users.updateOne(
			{ _id: uid },
			{
				$set: { status, statusConnection, statusDefault, ...(statusText !== undefined && { statusText }) },
			},
		);

		if (this.broadcastEnabled && (status !== user.status || statusText !== user.statusText || changes.force)) {
			void api.broadcast('presence.status', {
				user: { _id: uid, username: user.username, name: user.name, roles: user.roles, status, statusText, statusSource, statusExpiresAt },
				previousStatus: user.status,
			});
		}
		return true;
	}

	async newConnection(uid, session) {
		if (!uid || !session) {
			return undefined;
		}
		const sessions = this.connections.get(uid) ?? new Map();
		sessions.set(session, ONLINE);
		this.connections.set(uid, sessions);
		this.peak = Math.max(this.peak, this.connectionCount());
		await this.refresh(uid);
		return { uid, connectionId: session };
	}

	async removeConnection(uid, session) {
		if (!uid || !session) {
			return undefined;
		}
		const sessions = this.connections.get(uid);
		if (sessions) {
			sessions.delete(session);
			if (sessions.size === 0) {
				this.connections.delete(uid);
			}
		}
		await this.refresh(uid);
		return { uid, session };
	}

	async updateConnection(uid, connectionId) {
		return this.connections.get(uid)?.has(connectionId) ? { uid, connectionId } : undefined;
	}

	async removeLostConnections() {
		// Single process: there are never connections from other nodes to clean up.
		return [];
	}

	async setStatus(uid, status, statusText) {
		return this.refresh(uid, { statusDefault: status, statusText, force: true });
	}

	async setConnectionStatus(uid, status, session) {
		const sessions = this.connections.get(uid);
		if (!sessions?.has(session)) {
			return false;
		}
		sessions.set(session, status === AWAY ? AWAY : ONLINE);
		return this.refresh(uid);
	}

	async setActiveState(uid, newState) {
		this.activeStates.set(uid, newState);
		return this.refresh(uid, { force: true });
	}

	async endActiveState(uid, statusId) {
		const active = this.activeStates.get(uid);
		if (!active || (statusId && active.statusId && active.statusId !== statusId)) {
			return false;
		}
		this.activeStates.delete(uid);
		return this.refresh(uid, { force: true });
	}

	async clearActiveState(uid) {
		this.activeStates.delete(uid);
		return this.refresh(uid, { force: true });
	}

	toggleBroadcast(enabled) {
		this.broadcastEnabled = enabled;
	}

	getConnectionCount() {
		return { current: this.connectionCount(), max: this.peak };
	}

	getPeakConnections(reset) {
		const { peak } = this;
		if (reset) {
			this.resetPeakConnections();
		}
		return peak;
	}

	resetPeakConnections() {
		this.peak = this.connectionCount();
	}
}

module.exports = { Presence };
