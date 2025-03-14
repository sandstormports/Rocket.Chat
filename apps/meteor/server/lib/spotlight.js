import { escapeRegExp } from '@rocket.chat/string-helpers';
import { Users, Subscriptions as SubscriptionsRaw, Rooms as RoomsRaw } from '@rocket.chat/models';

import { hasAllPermission, canAccessRoomAsync, roomAccessAttributes } from '../../app/authorization/server';
import { hasPermissionAsync } from '../../app/authorization/server/functions/hasPermission';
import { Subscriptions, Rooms } from '../../app/models/server';
import { settings } from '../../app/settings/server';
import { readSecondaryPreferred } from '../database/readSecondaryPreferred';
import { roomCoordinator } from './rooms/roomCoordinator';
import { trim } from '../../lib/utils/stringUtils';

export class Spotlight {
	async fetchRooms(userId, rooms) {
		if (!settings.get('Store_Last_Message') || (await hasPermissionAsync(userId, 'preview-c-room'))) {
			return rooms;
		}

		return rooms.map((room) => {
			delete room.lastMessage;
			return room;
		});
	}

	async searchRooms({ userId, text, includeFederatedRooms = false }) {
		const regex = new RegExp(trim(escapeRegExp(text)), 'i');

		const roomOptions = {
			limit: 5,
			fields: {
				t: 1,
				name: 1,
				fname: 1,
				joinCodeRequired: 1,
				lastMessage: 1,
				federated: true,
			},
			sort: {
				name: 1,
			},
		};

		if (userId == null) {
			if (!settings.get('Accounts_AllowAnonymousRead')) {
				return [];
			}

			return this.fetchRooms(userId, await RoomsRaw.findByNameAndTypeNotDefault(regex, 'c', roomOptions, includeFederatedRooms).toArray());
		}

		if (!hasAllPermission(userId, ['view-outside-room', 'view-c-room'])) {
			return [];
		}

		const searchableRoomTypeIds = roomCoordinator.searchableRoomTypes();

		const roomIds = Subscriptions.findByUserIdAndTypes(userId, searchableRoomTypeIds, {
			fields: { rid: 1 },
		})
			.fetch()
			.map((s) => s.rid);
		const exactRoom = await RoomsRaw.findOneByNameAndType(text, searchableRoomTypeIds, roomOptions, includeFederatedRooms);
		if (exactRoom) {
			roomIds.push(exactRoom.rid);
		}

		return this.fetchRooms(
			userId,
			await RoomsRaw.findByNameAndTypesNotInIds(regex, searchableRoomTypeIds, roomIds, roomOptions, includeFederatedRooms).toArray(),
		);
	}

	mapOutsiders(u) {
		u.outside = true;
		return u;
	}

	processLimitAndUsernames(options, usernames, users) {
		// Reduce the results from the limit for the next query
		options.limit -= users.length;

		// If the limit was reached, return
		if (options.limit <= 0) {
			return users;
		}

		// Prevent the next query to get the same users
		usernames.push(...users.map((u) => u.username).filter((u) => !usernames.includes(u)));
	}

	async _searchInsiderUsers({ rid, text, usernames, options, users, insiderExtraQuery, match = { startsWith: false, endsWith: false } }) {
		// Get insiders first
		if (rid) {
			const searchFields = settings.get('Accounts_SearchFields').trim().split(',');

			users.push(...(await Users.findByActiveUsersExcept(text, usernames, options, searchFields, insiderExtraQuery, match).toArray()));

			// If the limit was reached, return
			if (this.processLimitAndUsernames(options, usernames, users)) {
				return users;
			}
		}
	}

	async _searchConnectedUsers(userId, { text, usernames, options, users, match = { startsWith: false, endsWith: false } }, roomType) {
		const searchFields = settings.get('Accounts_SearchFields').trim().split(',');

		users.push(
			...(
				await SubscriptionsRaw.findConnectedUsersExcept(userId, text, usernames, searchFields, {}, options.limit || 5, roomType, match, {
					readPreference: options.readPreference,
				})
			).map(this.mapOutsiders),
		);

		// If the limit was reached, return
		if (this.processLimitAndUsernames(options, usernames, users)) {
			return users;
		}
	}

	async _searchOutsiderUsers({ text, usernames, options, users, canListOutsiders, match = { startsWith: false, endsWith: false } }) {
		// Then get the outsiders if allowed
		if (canListOutsiders) {
			const searchFields = settings.get('Accounts_SearchFields').trim().split(',');
			users.push(
				...(await Users.findByActiveUsersExcept(text, usernames, options, searchFields, undefined, match).toArray()).map(this.mapOutsiders),
			);

			// If the limit was reached, return
			if (this.processLimitAndUsernames(options, usernames, users)) {
				return users;
			}
		}
	}

	async _performExtraUserSearches(/* userId, searchParams */) {
		// Overwrite this method to include extra searches
	}

	async searchUsers({ userId, rid, text, usernames, mentions }) {
		const users = [];

		const options = {
			limit: settings.get('Number_of_users_autocomplete_suggestions'),
			projection: {
				username: 1,
				nickname: 1,
				name: 1,
				status: 1,
				statusText: 1,
				avatarETag: 1,
			},
			sort: {
				[settings.get('UI_Use_Real_Name') ? 'name' : 'username']: 1,
			},
			readPreference: readSecondaryPreferred(Users.col.s.db),
		};

		const room = Rooms.findOneById(rid, { fields: { ...roomAccessAttributes, _id: 1, t: 1, uids: 1 } });

		if (rid && !room) {
			return users;
		}

		const canListOutsiders = hasAllPermission(userId, ['view-outside-room', 'view-d-room']);
		const canListInsiders = canListOutsiders || (rid && (await canAccessRoomAsync(room, { _id: userId })));

		const insiderExtraQuery = [];

		if (rid) {
			switch (room.t) {
				case 'd':
					insiderExtraQuery.push({
						_id: { $in: room.uids.filter((id) => id !== userId) },
					});
					break;
				case 'l':
					insiderExtraQuery.push({
						_id: {
							$in: Subscriptions.findByRoomId(room._id)
								.fetch()
								.map((s) => s.u?._id)
								.filter((id) => id && id !== userId),
						},
					});
					break;
				default:
					insiderExtraQuery.push({
						__rooms: rid,
					});
					break;
			}
		}

		const searchParams = {
			rid,
			text,
			usernames,
			options,
			users,
			canListOutsiders,
			insiderExtraQuery,
			mentions,
		};

		// Exact match for username only
		if (rid && canListInsiders) {
			const exactMatch = await Users.findOneByUsernameAndRoomIgnoringCase(text, rid, {
				projection: options.projection,
				readPreference: options.readPreference,
			});
			if (exactMatch) {
				users.push(exactMatch);
				this.processLimitAndUsernames(options, usernames, users);
			}
		}

		if (users.length === 0 && canListOutsiders) {
			const exactMatch = await Users.findOneByUsernameIgnoringCase(text, {
				projection: options.projection,
				readPreference: options.readPreference,
			});
			if (exactMatch) {
				users.push(this.mapOutsiders(exactMatch));
				this.processLimitAndUsernames(options, usernames, users);
			}
		}

		if (canListInsiders && rid) {
			// Search for insiders
			if (await this._searchInsiderUsers(searchParams)) {
				return users;
			}

			// Search for users that the requester has DMs with
			if (await this._searchConnectedUsers(userId, searchParams, 'd')) {
				return users;
			}
		}

		// If the user can search outsiders, search for any user in the server
		// Otherwise, search for users that are subscribed to the same rooms as the requester
		if (canListOutsiders) {
			if (await this._searchOutsiderUsers(searchParams)) {
				return users;
			}
		} else if (await this._searchConnectedUsers(userId, searchParams)) {
			return users;
		}

		if (await this._performExtraUserSearches(userId, searchParams)) {
			return users;
		}

		return users;
	}
}
