// End-to-end smoke test of a running grain, through dev-bridge.js:
//
//   ./sandbox.sh &            # or start.js directly, see README.md
//   node dev-bridge.js &
//   node smoke-test.mjs       # BASE=http://127.0.0.1:9000 by default
//
// Covers Sandstorm login and roles, the forced settings, chat between two users,
// uploads, and the Community build's license stand-ins.
const BASE = process.env.BASE || 'http://127.0.0.1:9000';
let failures = 0;
const check = (cond, msg, extra) => {
	console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${extra !== undefined ? ` ${JSON.stringify(extra)}` : ''}`);
	if (!cond) failures++;
};

async function sandstormLogin(user) {
	const res = await fetch(`${BASE}/.sandstorm-login?sandstorm_user=${user}`, { method: 'POST' });
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function restSession(loginToken) {
	const res = await fetch(`${BASE}/api/v1/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ resume: loginToken }),
	});
	const body = await res.json();
	return { userId: body.data?.userId, authToken: body.data?.authToken, status: res.status };
}

const api = (s) => async (method, path, body) => {
	const res = await fetch(`${BASE}/api/v1/${path}`, {
		method,
		// The names the client uses inside a grain (lib/sandstormHeaders.ts); the bridge drops X-User-Id.
		headers: {
			'X-Sandstorm-App-User-Id': s.userId,
			'X-Sandstorm-App-Auth-Token': s.authToken,
			...(body && { 'Content-Type': 'application/json' }),
		},
		body: body && JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
};

// Anonymous visitors get a 401 so the login page frames the "sign in" page.
const anon = await sandstormLogin('anonymous');
check(anon.status === 401, 'anonymous /.sandstorm-login is 401', anon.status);
const page = await fetch(`${BASE}/.sandstorm-login-required`);
check(page.status === 200 && (await page.text()).includes('Sign in to Sandstorm'), 'login-required page served');
const get = await fetch(`${BASE}/.sandstorm-login`);
check(get.status === 405, 'GET /.sandstorm-login is 405', get.status);

// Owner (admin permission) and member.
const alice = await sandstormLogin('alice');
check(alice.status === 200 && typeof alice.body?.loginToken === 'string', 'alice gets a loginToken', alice.status);
const bob = await sandstormLogin('bob');
check(bob.status === 200 && typeof bob.body?.loginToken === 'string', 'bob gets a loginToken', bob.status);

const aliceS = await restSession(alice.body.loginToken);
const bobS = await restSession(bob.body.loginToken);
check(aliceS.authToken && bobS.authToken, 'resume tokens work for REST login');
const asAlice = api(aliceS);
const asBob = api(bobS);

const aliceMe = (await asAlice('GET', 'me')).body;
const bobMe = (await asBob('GET', 'me')).body;
check(aliceMe?.username === 'alice', 'alice username from preferred handle', aliceMe?.username);
check(aliceMe?.name === 'Alice Owner', 'alice display name from X-Sandstorm-Username', aliceMe?.name);
check(aliceMe?.roles?.includes('admin'), 'alice is admin', aliceMe?.roles);
check(bobMe?.username === 'bob' && !bobMe?.roles?.includes('admin'), 'bob is a non-admin user', bobMe?.roles);

// Logging in again must reuse the same account.
const alice2 = await restSession((await sandstormLogin('alice')).body.loginToken);
check(alice2.userId === aliceS.userId, 'second login reuses the account');

// Admin-only endpoint.
const settingsA = await asAlice('GET', 'statistics');
const settingsB = await asBob('GET', 'statistics');
check(settingsA.status === 200, 'admin can read statistics', settingsA.status);
check(settingsB.status !== 200, 'member cannot read statistics', settingsB.status);

// Forced settings.
const iframe = await asAlice('GET', 'settings/Iframe_Restrict_Access');
check(iframe.body?.value === false, 'Iframe_Restrict_Access forced off', iframe.body?.value);
const storage = await asAlice('GET', 'settings/FileUpload_Storage_Type');
check(storage.body?.value === 'FileSystem', 'uploads on FileSystem', storage.body?.value);
const xfo = (await fetch(`${BASE}/home`)).headers.get('x-frame-options');
check(!xfo, 'no X-Frame-Options header on pages', xfo);

// Chat between users.
const text = `hello from alice ${Date.now()}`;
const sent = await asAlice('POST', 'chat.postMessage', { channel: '#general', text });
check(sent.body?.success, 'alice posts to #general', sent.body?.error);
const hist = await asBob('GET', 'channels.history?roomName=general&count=5');
check(
	hist.body?.messages?.some((m) => m.msg === text),
	"bob reads alice's message",
);

// Community build: no license, and therefore no read-only restriction.
const lic = await asAlice('GET', 'licenses.info');
check(lic.status === 200 && lic.body?.license?.hasValidLicense === false, 'licenses.info reports no license', lic.status);
const restriction = await asAlice('GET', 'settings/Cloud_Workspace_AirGapped_Restrictions_Remaining_Days');
check(
	restriction.status !== 200 || restriction.body?.value === -1 || restriction.body?.value === undefined,
	'no air-gapped countdown',
	restriction.body?.value,
);

// File upload to the filesystem store.
const roomId = sent.body?.message?.rid || 'GENERAL';
const form = new FormData();
form.append('file', new Blob(['sandstorm upload test'], { type: 'text/plain' }), 'test.txt');
const up = await fetch(`${BASE}/api/v1/rooms.media/${roomId}`, {
	method: 'POST',
	headers: { 'X-Sandstorm-App-User-Id': aliceS.userId, 'X-Sandstorm-App-Auth-Token': aliceS.authToken },
	body: form,
});
const upBody = await up.json().catch(() => null);
check(up.status === 200 && upBody?.file?.url, 'upload accepted', upBody);
if (upBody?.file?.url) {
	const url = upBody.file.url.startsWith('http') ? upBody.file.url : `${BASE}${upBody.file.url}`;
	check(upBody.file.url.startsWith('/'), 'file URL is relative to the grain', upBody.file.url);
	const dl = await fetch(url, { headers: { Cookie: `rc_uid=${aliceS.userId}; rc_token=${aliceS.authToken}` } });
	check(dl.status === 200 && (await dl.text()) === 'sandstorm upload test', 'uploaded file downloads', dl.status);
}

// Roles follow Sandstorm permissions on every login.
const bobPromoted = await fetch(`${BASE}/.sandstorm-login?sandstorm_user=bob&sandstorm_permissions=admin`, { method: 'POST' });
check(bobPromoted.status === 200, 'bob logs in with admin permission');
check((await asBob('GET', 'me')).body?.roles?.includes('admin'), 'bob promoted to admin');
await sandstormLogin('bob');
check(!(await asBob('GET', 'me')).body?.roles?.includes('admin'), 'bob demoted again');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
