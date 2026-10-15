import type { IMessage, IRoom } from '@rocket.chat/core-typings';
import { Random } from '@rocket.chat/random';

import { sdk } from '../lib/SDKClient';
import { messageBox } from '../lib/messageBox';
import { dispatchToastMessage } from '../lib/toast';

// Sharing grains: asks Sandstorm's Powerbox for a grain to post to the room,
// and opens a shared grain when its message is clicked.
// https://docs.sandstorm.io/en/latest/developing/powerbox/

// A packed PowerboxDescriptor that matches any grain (a UiView). The bridge
// client builds the same value as UI_VIEW_QUERY.
const GRAIN_QUERY = 'EAZQAQEAABEBF1EEAQH_5-Jn6pjXtNsAAAA';

// Where a shared grain's message links to (server/sandstorm/powerbox.ts).
const GRAIN_LINK_PATH = '/.sandstorm-grain/';

type PowerboxReply = { rpcId: string; token?: string; descriptor?: string; canceled?: boolean; error?: string };

const pendingRequests = new Map<string, (reply: PowerboxReply) => void>();

const requestGrain = (): Promise<{ token: string; descriptor: string } | undefined> =>
	new Promise((resolve, reject) => {
		const rpcId = Random.id();
		pendingRequests.set(rpcId, ({ token, descriptor, error }) => {
			if (error) {
				reject(new Error(error));
				return;
			}
			resolve(token && descriptor ? { token, descriptor } : undefined);
		});
		window.parent.postMessage(
			{ powerboxRequest: { rpcId, query: [GRAIN_QUERY], saveLabel: { defaultText: 'Shared in Rocket.Chat' } } },
			'*',
		);
	});

const shareGrain = async (rid: IRoom['_id'], tmid?: IMessage['_id']): Promise<void> => {
	try {
		const grain = await requestGrain();
		if (grain) {
			await sdk.call('sandstorm.shareGrain', rid, tmid, grain.token, grain.descriptor);
		}
	} catch (error) {
		dispatchToastMessage({ type: 'error', message: error });
	}
};

const openGrain = async (mid: IMessage['_id']): Promise<void> => {
	try {
		await sdk.call('sandstorm.openGrain', mid);
	} catch (error) {
		dispatchToastMessage({ type: 'error', message: error });
	}
};

export const registerPowerbox = (): void => {
	window.addEventListener('message', ({ source, data }: MessageEvent) => {
		if (source !== window.parent || typeof data?.rpcId !== 'string') {
			return;
		}
		const reply = pendingRequests.get(data.rpcId);
		if (reply) {
			pendingRequests.delete(data.rpcId);
			reply(data);
		}
	});

	messageBox.actions.add('Sandstorm', 'Sandstorm_Share_Grain', {
		id: 'sandstorm-share-grain',
		icon: 'cube',
		action: ({ rid, tmid }) => void shareGrain(rid, tmid),
	});

	// Capture phase, so the link's default action (opening a new tab) never runs.
	document.addEventListener(
		'click',
		(event) => {
			const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
			if (!(link instanceof HTMLAnchorElement)) {
				return;
			}
			const { pathname } = new URL(link.href, window.location.href);
			if (!pathname.startsWith(GRAIN_LINK_PATH)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void openGrain(pathname.slice(GRAIN_LINK_PATH.length));
		},
		true,
	);
};
