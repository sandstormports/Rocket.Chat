// Stand-in for sandstorm-http-bridge, for trying the grain outside Sandstorm.
//
// Proxies HTTP and WebSocket traffic to the launcher's port and, like the real
// bridge, drops any X-Sandstorm-* headers from the browser and sets them from a
// fake identity, and drops custom X-* request headers that are not on Sandstorm's
// whitelist (headerWhitelist in Sandstorm's web-session.capnp). Pick the identity per browser with a query parameter on any
// page load (it is remembered in a cookie):
//
//   ?sandstorm_user=alice            admin (owner)
//   ?sandstorm_user=bob              member
//   ?sandstorm_user=anonymous        no identity, like a logged-out visitor
//
// ?sandstorm_permissions=admin (or empty) overrides the permissions for that one
// request, e.g. to test promoting and demoting a user.
//
// Usage: node dev-bridge.js [listenPort=9000] [targetPort=8000]
// Not part of the package.

const http = require('http');
const net = require('net');

const LISTEN_PORT = Number(process.argv[2] || 9000);
const TARGET_PORT = Number(process.argv[3] || 8000);

const USERS = {
	alice: { id: 'a11ce000000000000000000000000000', name: 'Alice Owner', handle: 'alice', permissions: 'admin' },
	bob: { id: 'b0b00000000000000000000000000000', name: 'Bob Member', handle: 'bob', permissions: '' },
	carol: { id: 'ca7010000000000000000000000000000', name: 'Carol Member', handle: 'carol', permissions: '' },
};

function pickUser(req) {
	const url = new URL(req.url, 'http://localhost');
	const fromQuery = url.searchParams.get('sandstorm_user');
	if (fromQuery) {
		return { name: fromQuery, setCookie: true };
	}
	const cookie = /(?:^|;\s*)sandstorm_user=([^;]+)/.exec(req.headers.cookie || '');
	return { name: cookie ? cookie[1] : 'alice', setCookie: false };
}

// Non-standard request headers the real bridge forwards.
const FORWARDED = [/^x-sandstorm-app-/, /^x-requested-with$/, /^x-csrf-?token$/, /^x-oc-mtime$/, /^x-hgarg-/, /^x-phabricator-/];
const forwarded = (name) => !name.startsWith('x-') || FORWARDED.some((re) => re.test(name));

function sandstormHeaders(req) {
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (forwarded(key)) {
			headers[key] = value;
		}
	}
	const { name, setCookie } = pickUser(req);
	const user = USERS[name];
	const permissionsOverride = new URL(req.url, 'http://localhost').searchParams.get('sandstorm_permissions');
	headers['x-sandstorm-session-id'] = 'dev-session';
	if (user) {
		headers['x-sandstorm-user-id'] = user.id;
		headers['x-sandstorm-username'] = encodeURIComponent(user.name);
		headers['x-sandstorm-preferred-handle'] = user.handle;
		headers['x-sandstorm-permissions'] = permissionsOverride ?? user.permissions;
	} else {
		headers['x-sandstorm-username'] = encodeURIComponent('Anonymous User');
		headers['x-sandstorm-permissions'] = '';
	}
	return { headers, cookie: setCookie ? `sandstorm_user=${name}; Path=/` : undefined };
}

const server = http.createServer((req, res) => {
	const { headers, cookie } = sandstormHeaders(req);
	const upstream = http.request({ host: '127.0.0.1', port: TARGET_PORT, method: req.method, path: req.url, headers }, (upstreamRes) => {
		const responseHeaders = { ...upstreamRes.headers };
		if (cookie) {
			responseHeaders['set-cookie'] = [...[].concat(responseHeaders['set-cookie'] || []), cookie];
		}
		res.writeHead(upstreamRes.statusCode, responseHeaders);
		upstreamRes.pipe(res);
	});
	upstream.on('error', (error) => {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end(`dev-bridge: ${error.message}`);
	});
	req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
	const { headers } = sandstormHeaders(req);
	const upstream = net.connect(TARGET_PORT, '127.0.0.1', () => {
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (const [key, value] of Object.entries(headers)) {
			for (const v of [].concat(value)) {
				lines.push(`${key}: ${v}`);
			}
		}
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
		upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	const close = () => {
		socket.destroy();
		upstream.destroy();
	};
	upstream.on('error', close);
	socket.on('error', close);
});

server.listen(LISTEN_PORT, () => {
	console.log(`dev-bridge: http://localhost:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT}`);
	console.log(`identities: ${Object.keys(USERS).join(', ')}, anonymous (?sandstorm_user=NAME)`);
});
