// Checks bridge/index.mjs against an in-process mock of sandstorm-http-bridge's
// API socket, built from the same generated schemas.
// Usage: node bridge-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge');
const load = (p) => import(pathToFileURL(path.join(dir, p)).href);

const { createBridge, UI_VIEW_QUERY, frameSize } = await load('index.mjs');
const { Conn, DeferredTransport, Message, utils } = await load('capnp-es/index.mjs');
const { SandstormHttpBridge } = await load('capnp/sandstorm-http-bridge.mjs');
const { SessionContext, SandstormApi, UiView, UiView_PowerboxTag } = await load('capnp/grain.mjs');
const { Identity } = await load('capnp/identity.mjs');
const { StaticAsset, StaticAsset_Protocol } = await load('capnp/util.mjs');
const { PowerboxDescriptor } = await load('capnp/powerbox.mjs');

class SocketTransport extends DeferredTransport {
	constructor(socket) {
		super();
		this.socket = socket;
		this.pending = Buffer.alloc(0);
		socket.on('data', (chunk) => {
			this.pending = Buffer.concat([this.pending, chunk]);
			for (;;) {
				const size = frameSize(this.pending);
				if (size === null || this.pending.length < size) return;
				const frame = this.pending.subarray(0, size);
				this.pending = this.pending.subarray(size);
				this.resolve(frame.buffer.slice(frame.byteOffset, frame.byteOffset + size));
			}
		});
		socket.on('error', (err) => this.reject(err));
		socket.on('close', () => this.close());
	}

	sendMessage(msg) {
		if (!this.closed) this.socket.write(Buffer.from(msg.segment.message.toArrayBuffer()));
	}

	close() {
		if (!this.closed) {
			super.close();
			this.socket.destroy();
		}
	}
}

const setCap = (struct, index, client) => utils.setInterfacePointer(struct.segment.message.addCap(client), utils.getPointer(index, struct));

const log = { activity: [], offers: [], saved: new Map(), savedLabels: [], claimed: [] };

const identity = (id) =>
	new Identity.Server({
		async getProfile(_p, r) {
			r._initProfile()._initDisplayName().defaultText = `user ${id}`;
		},
	});

const grainView = new UiView.Server({
	async getViewInfo(_p, r) {
		r._initAppTitle().defaultText = 'Etherpad';
		r.grainIcon = new StaticAsset.Server({
			async getUrl(_p2, r2) {
				r2.protocol = StaticAsset_Protocol.HTTPS;
				r2.hostPath = 'static.example.org/icon.svg';
			},
		}).client();
	},
});

const sessionContext = (sessionId) =>
	new SessionContext.Server({
		async activity(p) {
			const e = p.event;
			log.activity.push({
				sessionId,
				path: e.path,
				type: e.type,
				caption: e._hasNotification() ? e.notification.caption.defaultText : undefined,
				users: e.users.map((u) => ({ mentioned: u.mentioned, hasIdentity: !utils.isNull(utils.getPointer(0, u)) })),
			});
		},
		async claimRequest(p, r) {
			log.claimed.push({ sessionId, token: p.requestToken });
			setCap(r, 0, grainView);
		},
		async offer(p) {
			const tag = p.descriptor.tags.get(0);
			const cap = utils.getInterfaceClientOrNullAt(0, p);
			log.offers.push({ sessionId, tagId: tag.id, title: utils.getAs(UiView_PowerboxTag, tag.value).title, hasCap: Boolean(cap) });
		},
	}).client();

const api = new SandstormApi.Server({
	async save(p, r) {
		const token = Buffer.from(`token-${log.saved.size + 1}`);
		log.saved.set(token.toString('base64'), utils.getInterfaceClientOrNullAt(0, p));
		log.savedLabels.push(p.label.defaultText);
		r._initToken(token.length).copyBuffer(token);
	},
	async restore(p, r) {
		const key = Buffer.from(p.token.toUint8Array()).toString('base64');
		assert.ok(log.saved.has(key), `restore of unknown token ${key}`);
		setCap(r, 0, grainView);
	},
}).client();

const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')), 'api');
const server = net.createServer((socket) => {
	const conn = new Conn(new SocketTransport(socket));
	conn.onError = () => undefined;
	conn.initMain(SandstormHttpBridge, {
		async getSandstormApi(_p, r) {
			r.api = api;
		},
		async getSessionContext(p, r) {
			r.context = sessionContext(p.id);
		},
		async getSavedIdentity(p, r) {
			if (p.identityId === 'gone') return; // no capability: the identity no longer resolves
			r.identity = identity(p.identityId).client();
		},
	});
});
await new Promise((resolve) => server.listen(socketPath, resolve));

const bridge = createBridge({ socketPath });

// UI_VIEW_QUERY decodes to a descriptor for UiView.
const query = new Message(Buffer.from(UI_VIEW_QUERY.replace(/_/g, '/').replace(/-/g, '+'), 'base64'), true).getRoot(PowerboxDescriptor);
assert.equal(query.tags.get(0).id, UiView.Client.interfaceId);
// The client sends the same query without loading the bridge.
const clientSource = fs.readFileSync(path.join(dir, '../../client/sandstorm/powerbox.ts'), 'utf8');
assert.equal(/const GRAIN_QUERY = '([^']+)'/.exec(clientSource)?.[1], UI_VIEW_QUERY);

await bridge.reportActivity('s1', {
	path: 'channel/general?msg=abc',
	type: 1,
	caption: 'alice: hi @bob',
	users: [{ id: 'bob', mentioned: true }, { id: 'carol' }, { id: 'gone', mentioned: true }],
});
assert.deepEqual(log.activity, [
	{
		sessionId: 's1',
		path: 'channel/general?msg=abc',
		type: 1,
		caption: 'alice: hi @bob',
		users: [
			{ mentioned: true, hasIdentity: true },
			{ mentioned: false, hasIdentity: true },
		],
	},
]);

// A descriptor as the Powerbox returns it: the UiView tag with the grain's title.
const chosen = new Message();
const chosenTag = chosen.initRoot(PowerboxDescriptor)._initTags(1).get(0);
chosenTag.id = UiView.Client.interfaceId;
const titleTag = new Message().initRoot(UiView_PowerboxTag);
titleTag.title = 'Team notes';
chosenTag.value = titleTag;
const chosenBase64 = Buffer.from(chosen.toPackedArrayBuffer()).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');

const grain = await bridge.claimUiView('s2', 'request-token', chosenBase64, 'Shared in Rocket.Chat by alice');
assert.deepEqual(grain, {
	token: Buffer.from('token-1').toString('base64'),
	title: 'Team notes',
	appTitle: 'Etherpad',
	appIconUrl: 'https://static.example.org/icon.svg',
});
assert.deepEqual(log.claimed, [{ sessionId: 's2', token: 'request-token' }]);
assert.deepEqual(log.savedLabels, ['Shared in Rocket.Chat by alice']);

await bridge.offerUiView('s3', grain.token, grain.title);
assert.deepEqual(log.offers, [{ sessionId: 's3', tagId: UiView.Client.interfaceId, title: 'Team notes', hasCap: true }]);

bridge.close();
server.close();

// Without the socket (outside a grain, or after the bridge went away) calls fail instead of hanging.
const orphan = createBridge({ socketPath: path.join(path.dirname(socketPath), 'missing') });
const outcome = await Promise.race([
	orphan.reportActivity('s4', { path: '', type: 0, users: [{ id: 'bob', mentioned: true }] }).then(
		() => 'resolved',
		() => 'rejected',
	),
	new Promise((resolve) => setTimeout(resolve, 5000, 'hung')),
]);
assert.equal(outcome, 'rejected');
console.log('mock bridge: all checks passed');
