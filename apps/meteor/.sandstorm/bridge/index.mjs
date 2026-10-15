// Cap'n Proto RPC to sandstorm-http-bridge, for the Sandstorm features that the
// X-Sandstorm-* request headers cannot provide: activity events (Sandstorm's
// notifications and unread state) and Powerbox grain sharing.
//
// The bridge offers these only on its /tmp/sandstorm-api socket. This module
// runs outside the Meteor bundle: build-deps.sh copies this directory into the
// grain, and server/sandstorm/bridge.ts loads it from SANDSTORM_BRIDGE_MODULE.
// The connection code is adapted from WeKan's imports/sandstorm/bridgeClient.mjs
// (MIT); see README.md for where every vendored file comes from.

import net from 'node:net';

import { UiView$Client, UiView_PowerboxTag } from './capnp/grain.mjs';
import { PowerboxDescriptor } from './capnp/powerbox.mjs';
import { SandstormHttpBridge } from './capnp/sandstorm-http-bridge.mjs';
import { StaticAsset_Protocol } from './capnp/util.mjs';
import { Conn, DeferredTransport, Message, utils } from './capnp-es/index.mjs';

export const SANDSTORM_API_SOCKET = '/tmp/sandstorm-api';

// Cap'n Proto stream framing: a segment count and the segment sizes in words,
// padded to 8 bytes, then the segments.
export const frameSize = (buf) => {
	if (buf.length < 4) {
		return null;
	}
	const segments = buf.readUInt32LE(0) + 1;
	const header = 4 + 4 * segments + (segments % 2 === 0 ? 4 : 0);
	if (buf.length < header) {
		return null;
	}
	let words = 0;
	for (let i = 0; i < segments; i++) {
		words += buf.readUInt32LE(4 + 4 * i);
	}
	return header + words * 8;
};

class SocketTransport extends DeferredTransport {
	constructor(socket) {
		super();
		this.socket = socket;
		this.pending = Buffer.alloc(0);
		socket.on('data', (chunk) => this.onData(chunk));
		// A failed socket also closes; the connection is shut down then.
		socket.on('error', () => undefined);
		socket.on('close', () => this.close());
	}

	onData(chunk) {
		this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		for (;;) {
			const size = frameSize(this.pending);
			if (size === null || this.pending.length < size) {
				return;
			}
			const frame = this.pending.subarray(0, size);
			this.pending = this.pending.subarray(size);
			// A copy: the message keeps its buffer for its whole lifetime.
			this.resolve(frame.buffer.slice(frame.byteOffset, frame.byteOffset + size));
		}
	}

	sendMessage(msg) {
		if (!this.closed) {
			this.socket.write(Buffer.from(msg.segment.message.toArrayBuffer()));
		}
	}

	close() {
		if (!this.closed) {
			super.close();
			this.socket.destroy();
		}
	}
}

// Sends the Release for a capability now rather than when it is garbage collected.
const release = (...clients) => {
	for (const c of clients) {
		try {
			c?.client?.close?.();
		} catch {
			// already released
		}
	}
};

// Sets an untyped `:Capability` field (pointer `index` of struct) to client.
const setCapability = (struct, index, client) => {
	utils.setInterfacePointer(struct.segment.message.addCap(client), utils.getPointer(index, struct));
};

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// The Powerbox's base64 flavour: '/' and '+' are replaced so the value survives URLs.
const fromPowerboxBase64 = (value) => Buffer.from(value.replace(/_/g, '/').replace(/-/g, '+'), 'base64');
const toPowerboxBase64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');

// A packed PowerboxDescriptor matching any UiView (a grain), optionally tagged with its title.
const uiViewDescriptor = (title) => {
	const message = new Message();
	const tag = message.initRoot(PowerboxDescriptor)._initTags(1).get(0);
	tag.id = UiView$Client.interfaceId;
	if (title !== undefined) {
		const value = new Message().initRoot(UiView_PowerboxTag);
		value.title = title;
		tag.value = value;
	}
	return message;
};

// The query the client passes to the Powerbox to ask the user for a grain.
export const UI_VIEW_QUERY = toPowerboxBase64(uiViewDescriptor().toPackedArrayBuffer());

const titleFromDescriptor = (descriptorBase64) => {
	const descriptor = new Message(toArrayBuffer(fromPowerboxBase64(descriptorBase64)), true).getRoot(PowerboxDescriptor);
	const tag = descriptor.tags.get(0);
	return utils.getAs(UiView_PowerboxTag, tag.value).title;
};

// The app a grain belongs to, for display. Not every grain can say (Sandstorm
// fails getViewInfo for apps without a grain icon), and none of it is needed to
// open the grain later.
const describeApp = async (view) => {
	let viewInfo;
	try {
		viewInfo = await view.getViewInfo(() => undefined).promise();
	} catch {
		return {};
	}
	const app = { appTitle: viewInfo.appTitle.defaultText || undefined };
	try {
		const url = await viewInfo.grainIcon.getUrl(() => undefined).promise();
		const protocol = Object.keys(StaticAsset_Protocol).find((key) => StaticAsset_Protocol[key] === url.protocol);
		app.appIconUrl = `${protocol.toLowerCase()}://${url.hostPath}`;
	} catch {
		// no icon
	} finally {
		release(viewInfo.grainIcon);
	}
	return app;
};

// One connection to the bridge, opened on first use and reopened after it
// drops. The bridge lives as long as the grain, but a broken socket must not
// disable these features until the next restart.
export const createBridge = ({ socketPath = SANDSTORM_API_SOCKET, connect = net.connect } = {}) => {
	let state = null;

	const open = () => {
		if (state && !state.transport.closed) {
			return state;
		}
		const socket = connect(socketPath);
		const transport = new SocketTransport(socket);
		const conn = new Conn(transport);
		conn.onError = () => undefined;
		// Calls still waiting when the socket closes would otherwise never settle.
		// Some of those questions have no caller (the bootstrap), so their rejection
		// is marked handled here; callers still see it.
		socket.on('close', () => {
			for (const question of conn.questions) {
				question?.deferred.promise.catch(() => undefined);
			}
			conn.shutdown(new Error('Sandstorm API socket closed'));
		});
		state = { conn, transport, bridge: conn.bootstrap(SandstormHttpBridge), identities: new Map() };
		return state;
	};

	const sessionContext = async (sessionId) => {
		const { context } = await open()
			.bridge.getSessionContext((p) => {
				p.id = sessionId;
			})
			.promise();
		return context;
	};

	const sandstormApi = async () => {
		const { api } = await open()
			.bridge.getSandstormApi(() => undefined)
			.promise();
		return api;
	};

	// Saved identities are kept for the life of the connection, since every
	// activity event names its users again. An identity that no longer resolves
	// (the user lost access, or was seen before saveIdentityCaps) is dropped.
	const savedIdentity = async (identityId) => {
		const { bridge, identities } = open();
		let identity = identities.get(identityId);
		if (!identity) {
			identity = (async () => {
				const result = await bridge
					.getSavedIdentity((p) => {
						p.identityId = identityId;
					})
					.promise();
				await result.identity.getProfile(() => undefined).promise();
				return result.identity;
			})();
			identities.set(identityId, identity);
		}
		try {
			return await identity;
		} catch {
			identities.delete(identityId);
			return null;
		}
	};

	return {
		// Reports an event as done by the user of sessionId. users: [{ id, mentioned }],
		// id being the Sandstorm user ID; mentioned users are notified.
		async reportActivity(sessionId, { path, type, caption, users = [] }) {
			const resolved = (await Promise.all(users.map(async (user) => ({ user, identity: await savedIdentity(user.id) })))).filter(
				({ identity }) => identity,
			);
			const context = await sessionContext(sessionId);
			try {
				await context
					.activity((p) => {
						const event = p._initEvent();
						event.path = path;
						event.type = type;
						if (caption) {
							event._initNotification()._initCaption().defaultText = caption;
						}
						const list = event._initUsers(resolved.length);
						resolved.forEach(({ user, identity }, i) => {
							const entry = list.get(i);
							entry.identity = identity;
							entry.mentioned = Boolean(user.mentioned);
						});
					})
					.promise();
			} finally {
				release(context);
			}
		},

		// Redeems the token from a Powerbox request for a grain and keeps the grain
		// in this grain's storage. Returns the token to restore it with, its title and its app.
		async claimUiView(sessionId, requestToken, descriptor, label) {
			const context = await sessionContext(sessionId);
			let view;
			let api;
			try {
				const claimed = await context
					.claimRequest((p) => {
						p.requestToken = requestToken;
						p._initRequiredPermissions(0);
					})
					.promise();
				view = new UiView$Client(utils.getInterfaceClientOrNullAt(0, claimed));
				api = await sandstormApi();
				const [saved, app] = await Promise.all([
					api
						.save((p) => {
							setCapability(p, 0, view.client);
							p._initLabel().defaultText = label;
						})
						.promise(),
					describeApp(view),
				]);
				return {
					token: Buffer.from(saved.token.toUint8Array()).toString('base64'),
					title: titleFromDescriptor(descriptor),
					...app,
				};
			} finally {
				release(view, api, context);
			}
		},

		// Offers a grain kept by claimUiView to the user of sessionId; Sandstorm
		// then lets them open it.
		async offerUiView(sessionId, token, title) {
			const context = await sessionContext(sessionId);
			let api;
			let cap;
			try {
				api = await sandstormApi();
				const bytes = Buffer.from(token, 'base64');
				const restored = await api
					.restore((p) => {
						p._initToken(bytes.length).copyBuffer(bytes);
					})
					.promise();
				cap = utils.getInterfaceClientOrNullAt(0, restored);
				const descriptor = uiViewDescriptor(title).getRoot(PowerboxDescriptor);
				await context
					.offer((p) => {
						setCapability(p, 0, cap);
						p._initRequiredPermissions(0);
						p.descriptor = descriptor;
					})
					.promise();
			} finally {
				cap?.close();
				release(api, context);
			}
		},

		close() {
			if (state) {
				state.conn.shutdown();
				state = null;
			}
		},
	};
};
