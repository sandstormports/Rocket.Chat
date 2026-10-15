// Rocket.Chat on Sandstorm: grain launcher.
//
// sandstorm-http-bridge runs this with the grain's bundled Node (/bin/node). A
// grain has no shell and no coreutils, so everything the old launcher.sh did is
// done here in Node:
//
//   1. answer the bridge port with a "please wait" page right away, so Sandstorm
//      never shows a connection error while the database and Meteor boot;
//   2. start the database (DB_BACKEND=mongod, or the experimental ferretdb);
//   3. configure Rocket.Chat through environment variables;
//   4. load the Meteor bundle's main.js in this process, handing the port from the
//      please-wait page to Meteor at the moment Meteor binds it.
//
// Layout inside a grain (see sandstorm-pkgdef.capnp and build-deps.sh):
//   /bin/node, /bin/mongod, /bin/ferretdb   from .build/deps
//   /sandstorm/start.js                     this file
//   /main.js, /programs/...                 from .build/bundle (meteor build)
//   /var                                    the only writable directory
//
// For a local smoke test outside Sandstorm, point the overrides below at the
// build output, e.g.:
//   GRAIN_VAR=/tmp/rc-grain RC_BUNDLE_DIR=.build/bundle .build/deps/bin/node start.js

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const { createRequire } = require('module');
const net = require('net');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.resolve(process.env.RC_BUNDLE_DIR || APP_ROOT);
const VAR = path.resolve(process.env.GRAIN_VAR || '/var');
const BIN = path.join(APP_ROOT, 'bin');

const APP_PORT = process.env.PORT || '8000';
const DB_PORT = process.env.DB_PORT || '4001';
const DB_NAME = 'rocketchat';
const REPL_SET = 'rs0';
const DB_BACKEND = process.env.DB_BACKEND || 'mongod';

const log = (...args) => console.log('[sandstorm-launcher]', ...args);

function fatal(message, error) {
	console.error('[sandstorm-launcher]', message, error && (error.stack || error));
	process.exit(1);
}

// ── please-wait page ────────────────────────────────────────────────────────
// Sandstorm frames the grain and proxies to APP_PORT. While nothing listens there
// the user sees an error page, and Meteor 3 only binds after every startup hook
// has run, which takes a while on a cold grain. Keep a tiny server on APP_PORT
// until Meteor calls listen() on the same port.
const PLEASE_WAIT = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="3"><title>Rocket.Chat</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#2f343d;background:#fff}</style>
</head><body><p>Rocket.Chat is starting&hellip;</p></body></html>`;

let pleaseWait = null;

function startPleaseWait() {
	pleaseWait = http.createServer((req, res) => {
		res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '3', 'Cache-Control': 'no-store' });
		res.end(PLEASE_WAIT);
	});
	pleaseWait.on('error', (error) => log('please-wait server error:', error.message));
	pleaseWait.listen(APP_PORT, '127.0.0.1');
}

// Debugging aid (GRAIN_HTTP_LOG=1 in the pkgdef environ): log what the bridge
// forwards, including WebSocket upgrades, with the Sandstorm identity headers.
function logHttp(server) {
	const who = (req) => `${req.headers['x-sandstorm-user-id'] ? 'user' : 'anon'}`;
	server.on('request', (req, res) => {
		res.on('finish', () => log(`http ${req.method} ${req.url.split('?')[0]} -> ${res.statusCode} (${who(req)})`));
	});
	server.on('upgrade', (req) =>
		log(`upgrade ${req.url.split('?')[0]} (${who(req)}, protocol ${req.headers['sec-websocket-protocol'] || '-'})`),
	);
}

function yieldPortToMeteor() {
	const { listen } = net.Server.prototype;
	net.Server.prototype.listen = function (...args) {
		const [opts] = args;
		const port = opts && typeof opts === 'object' ? opts.port : opts;
		if (String(port) !== String(APP_PORT) || this === pleaseWait || !pleaseWait) {
			return listen.apply(this, args);
		}
		net.Server.prototype.listen = listen;
		if (process.env.GRAIN_HTTP_LOG === '1') {
			logHttp(this);
		}
		const server = pleaseWait;
		pleaseWait = null;
		server.close(() => {
			log(`handing port ${APP_PORT} to Rocket.Chat`);
			listen.apply(this, args);
		});
		server.closeAllConnections();
		return this;
	};
}

// ── database ────────────────────────────────────────────────────────────────
function waitForPort(port, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
			socket.once('connect', () => {
				socket.destroy();
				resolve();
			});
			socket.once('error', () => {
				socket.destroy();
				if (Date.now() > deadline) {
					reject(new Error(`nothing listening on port ${port} after ${timeoutMs}ms`));
					return;
				}
				setTimeout(attempt, 250);
			});
		};
		attempt();
	});
}

function superviseDb(child, name) {
	child.on('error', (error) => fatal(`could not start ${name}`, error));
	child.on('exit', (code, signal) => fatal(`${name} exited (code ${code}, signal ${signal}); stopping grain`));
	process.on('exit', () => {
		try {
			child.kill('SIGTERM');
		} catch (_) {
			// already gone
		}
	});
}

// Rocket.Chat uses multi-document transactions (wrapInSessionTransaction), which
// MongoDB only allows on a replica set member, so the grain's mongod runs as a
// single-node replica set. Its oplog also lets Meteor tail changes instead of
// polling.
function startMongod() {
	const dbPath = path.join(VAR, 'mongodb');
	fs.mkdirSync(dbPath, { recursive: true });
	const child = spawn(
		path.join(BIN, 'mongod'),
		[
			'--dbpath',
			dbPath,
			'--bind_ip',
			'127.0.0.1',
			'--port',
			DB_PORT,
			'--replSet',
			REPL_SET,
			'--oplogSize',
			'990',
			// mongod sizes its cache from detected RAM, which a grain cannot read.
			'--wiredTigerCacheSizeGB',
			'0.25',
			'--setParameter',
			'diagnosticDataCollectionEnabled=false',
			'--nounixsocket',
			'--quiet',
		],
		{ stdio: 'inherit' },
	);
	superviseDb(child, 'mongod');
}

function loadMongoDriver() {
	// Use the driver Meteor already ships in the bundle instead of adding one.
	const candidates = [
		path.join(BUNDLE_DIR, 'programs/server/npm/node_modules/meteor/npm-mongo/node_modules/mongodb'),
		path.join(BUNDLE_DIR, 'programs/server/npm/node_modules/mongodb'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return createRequire(path.join(candidate, 'package.json'))(candidate);
		}
	}
	throw new Error(`mongodb driver not found in ${BUNDLE_DIR}`);
}

async function ensureReplicaSet() {
	const { MongoClient } = loadMongoDriver();
	const client = new MongoClient(`mongodb://127.0.0.1:${DB_PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 60000 });
	await client.connect();
	try {
		const admin = client.db('admin');
		try {
			await admin.command({ replSetGetStatus: 1 });
		} catch (error) {
			// 94 NotYetInitialized: first boot of this grain.
			if (error.code !== 94) {
				throw error;
			}
			log('initiating single-node replica set');
			await admin.command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host: `127.0.0.1:${DB_PORT}` }] } });
		}
		const deadline = Date.now() + 60000;
		for (;;) {
			const hello = await admin.command({ hello: 1 });
			if (hello.isWritablePrimary) {
				return;
			}
			if (Date.now() > deadline) {
				throw new Error('replica set did not elect a primary');
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	} finally {
		await client.close();
	}
}

// Experimental (Milestone 2): wekan/FerretDB v1 on embedded SQLite. Rocket.Chat
// 8.x no longer needs change streams or an oplog for realtime, so FerretDB runs
// without its oplog emulation and Meteor polls.
function startFerretdb() {
	const sqliteDir = path.join(VAR, 'ferretdb');
	const stateDir = path.join(VAR, 'ferretdb-state');
	fs.mkdirSync(sqliteDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	const child = spawn(
		path.join(BIN, 'ferretdb'),
		[
			'--handler=sqlite',
			`--sqlite-url=file:${sqliteDir}/`,
			`--state-dir=${stateDir}`,
			`--listen-addr=127.0.0.1:${DB_PORT}`,
			'--telemetry=disable',
		],
		{ stdio: 'inherit', env: { ...process.env, DO_NOT_TRACK: '1', FERRETDB_TELEMETRY: 'disable' } },
	);
	superviseDb(child, 'ferretdb');
}

async function startDatabase() {
	if (DB_BACKEND === 'ferretdb') {
		startFerretdb();
		await waitForPort(DB_PORT);
		process.env.MONGO_URL = `mongodb://127.0.0.1:${DB_PORT}/${DB_NAME}`;
		delete process.env.MONGO_OPLOG_URL;
		// FerretDB reports a MongoDB version Rocket.Chat may not accept.
		process.env.BYPASS_MONGO_VALIDATION = 'true';
		process.env.SKIP_MONGODEPRECATION_CHECK = 'true';
		return;
	}
	if (DB_BACKEND !== 'mongod') {
		throw new Error(`unknown DB_BACKEND "${DB_BACKEND}" (expected mongod or ferretdb)`);
	}
	startMongod();
	await waitForPort(DB_PORT);
	await ensureReplicaSet();
	process.env.MONGO_URL = `mongodb://127.0.0.1:${DB_PORT}/${DB_NAME}?replicaSet=${REPL_SET}&directConnection=true`;
	process.env.MONGO_OPLOG_URL = `mongodb://127.0.0.1:${DB_PORT}/local?replicaSet=${REPL_SET}&directConnection=true`;
}

// ── Rocket.Chat configuration ───────────────────────────────────────────────
// OVERWRITE_SETTING_<id> forces a setting on every boot and stops admins from
// changing it. Only things the sandbox makes impossible or meaningless go here.
const FORCED_SETTINGS = {
	// A grain has no outbound network, and the bridge serves it inside an iframe.
	Iframe_Restrict_Access: 'false',
	Register_Server: 'false',
	Update_EnableChecker: 'false',
	Statistics_reporting: 'false',
	Troubleshoot_Disable_Statistics_Generator: 'true',
	Troubleshoot_Disable_Workspace_Sync: 'true',
	Push_enable: 'false',
	Push_enable_gateway: 'false',
	API_Embed: 'false',
	Accounts_SetDefaultAvatar: 'false',

	// Sandstorm is the identity provider: the login page fetches /.sandstorm-login
	// (see server/sandstorm/login.ts), and shows Accounts_iframe_url to anonymous
	// visitors.
	Accounts_iframe_enabled: 'true',
	Accounts_iframe_url: '/.sandstorm-login-required',
	Accounts_Iframe_api_url: '/.sandstorm-login',
	Accounts_Iframe_api_method: 'POST',
	Accounts_ShowFormLogin: 'false',
	Accounts_RegistrationForm: 'Disabled',
	Accounts_PasswordReset: 'false',
	Accounts_AllowPasswordChange: 'false',
	Accounts_AllowEmailChange: 'false',
	Accounts_TwoFactorAuthentication_Enabled: 'false',
	Show_Setup_Wizard: 'completed',

	// Keep files out of GridFS, under the grain's writable /var.
	FileUpload_Storage_Type: 'FileSystem',
	FileUpload_FileSystemPath: path.join(VAR, 'uploads'),
	EmojiUpload_Storage_Type: 'FileSystem',
	EmojiUpload_FileSystemPath: path.join(VAR, 'custom_emoji'),
	CustomSounds_Storage_Type: 'FileSystem',
	CustomSounds_FileSystemPath: path.join(VAR, 'custom_sounds'),
	Apps_Framework_Source_Package_Storage_Type: 'filesystem',
	Apps_Framework_Source_Package_Storage_FileSystem_Path: path.join(VAR, 'apps'),
};

// Settings that have no meaning without email or a public URL.
const HIDDEN_SETTINGS = [
	'Email',
	'Email_Header',
	'Email_Footer',
	'SMTP_Host',
	'SMTP_Port',
	'SMTP_Username',
	'SMTP_Password',
	'From_Email',
	'SMTP_Test_Button',
	'Invitation_Customized',
	'Invitation_Subject',
	'Invitation_HTML',
	'Accounts_Enrollment_Customized',
	'Accounts_Enrollment_Email_Subject',
	'Accounts_Enrollment_Email',
	'Accounts_UserAddedEmail_Customized',
	'Accounts_UserAddedEmailSubject',
	'Accounts_UserAddedEmail',
	'Forgot_Password_Customized',
	'Forgot_Password_Email_Subject',
	'Forgot_Password_Email',
	'Verification_Customized',
	'Verification_Email_Subject',
	'Verification_Email',
];

function configureRocketChat() {
	for (const dir of ['uploads', 'custom_emoji', 'custom_sounds', 'apps']) {
		fs.mkdirSync(path.join(VAR, dir), { recursive: true });
	}

	for (const [id, value] of Object.entries(FORCED_SETTINGS)) {
		process.env[`OVERWRITE_SETTING_${id}`] = value;
	}
	process.env.SETTINGS_HIDDEN = HIDDEN_SETTINGS.join(',');
	// The grain cannot reach Rocket.Chat's statistics collector anyway.
	process.env.RC_DISABLE_STATISTICS_REPORTING = 'true';

	process.env.PORT = APP_PORT;
	// The browser reaches the grain on a random per-session host, which the server
	// never knows, so the client must build its URLs from the page's own origin.
	// A reserved, unresolvable name (RFC 6761) makes any code that still uses
	// ROOT_URL fail visibly, also when testing outside Sandstorm.
	process.env.ROOT_URL = process.env.ROOT_URL || 'http://grain.sandstorm.invalid';
	process.env.METEOR_SETTINGS = process.env.METEOR_SETTINGS || JSON.stringify({ public: { sandstorm: true } });
	process.env.DEPLOY_METHOD = 'sandstorm';
	process.env.DEPLOY_PLATFORM = 'sandstorm';
	process.env.SANDSTORM = process.env.SANDSTORM || '1';
	process.env.HOME = process.env.HOME || VAR;
	process.env.TMPDIR = process.env.TMPDIR || path.join(VAR, 'tmp');
	fs.mkdirSync(process.env.TMPDIR, { recursive: true });
}

async function main() {
	startPleaseWait();
	await startDatabase();
	configureRocketChat();
	log(`starting Rocket.Chat from ${BUNDLE_DIR} on port ${APP_PORT} (${DB_BACKEND})`);
	yieldPortToMeteor();
	// eslint-disable-next-line import-x/no-dynamic-require -- the bundle location is only known at runtime
	require(path.join(BUNDLE_DIR, 'main.js'));
}

main().catch((error) => fatal('startup failed', error));
