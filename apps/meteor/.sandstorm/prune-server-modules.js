// Removes npm packages the server program can never load.
//
// Meteor copies every dependency of the app into the server bundle, including the
// many that only the client uses (they are compiled into the client program
// separately). A package is kept when the compiled server code names it in a
// require()/module.link()/import()/module.dynamicImport(), or when a kept package depends on it
// (dependencies, optionalDependencies, peerDependencies), transitively. Only
// top-level packages in npm/node_modules are removed; nested copies go with
// their parent.
//
// Usage: node prune-server-modules.js <bundle-dir> [--dry-run]
const fs = require('fs');
const path = require('path');

const [bundle, flag] = process.argv.slice(2);
const dryRun = flag === '--dry-run';
const server = path.join(path.resolve(bundle), 'programs/server');
const npm = path.join(server, 'npm/node_modules');

const packageName = (specifier) => {
	if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('meteor/')) {
		return undefined;
	}
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

// 1. Names the compiled server code loads.
const SPECIFIER = /(?:require|module\.link|import|dynamicImport|resolve)\(\s*["']([^"'\n]+)["']/g;
const roots = new Set();
const scan = (file) => {
	for (const match of fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
		const name = packageName(match[1]);
		if (name) {
			roots.add(name);
		}
	}
};
const scanDir = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			scanDir(full);
		} else if (entry.name.endsWith('.js')) {
			scan(full);
		}
	}
};
scanDir(path.join(server, 'app'));
scanDir(path.join(server, 'packages'));
// The launcher and Meteor's boot code load these directly.
['mongodb', 'source-map-support', 'fibers'].forEach((name) => roots.add(name));

// 2. Close over package.json dependencies, resolving from where each package sits.
const manifest = (dir) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	} catch {
		return undefined;
	}
};
const resolveFrom = (fromDir, name) => {
	for (let dir = fromDir; dir.startsWith(npm) || dir === npm; dir = path.dirname(dir)) {
		const candidate = path.join(dir, 'node_modules', name);
		if (fs.existsSync(path.join(candidate, 'package.json'))) {
			return candidate;
		}
		if (dir === npm) {
			break;
		}
	}
	const top = path.join(npm, name);
	return fs.existsSync(top) ? top : undefined;
};

const keep = new Set();
const queue = [...roots].map((name) => resolveFrom(npm, name)).filter(Boolean);
while (queue.length) {
	const dir = queue.pop();
	if (keep.has(dir)) {
		continue;
	}
	keep.add(dir);
	const pkg = manifest(dir) || {};
	for (const deps of [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
		for (const name of Object.keys(deps || {})) {
			const resolved = resolveFrom(dir, name);
			if (resolved) {
				queue.push(resolved);
			}
		}
	}
}

// 3. Remove unreachable top-level packages.
const size = (dir) => {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += size(full);
		} else if (entry.isFile()) {
			total += fs.statSync(full).size;
		}
	}
	return total;
};
const topLevel = fs
	.readdirSync(npm)
	.flatMap((name) =>
		name.startsWith('@') ? fs.readdirSync(path.join(npm, name)).map((sub) => path.join(npm, name, sub)) : [path.join(npm, name)],
	);
let freed = 0;
const removed = [];
for (const dir of topLevel) {
	// Meteor's own packages (npm/node_modules/meteor/*) are not npm packages.
	if (path.basename(dir) === 'meteor' || keep.has(dir) || !manifest(dir)) {
		continue;
	}
	freed += size(dir);
	removed.push(path.relative(npm, dir));
	if (!dryRun) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
console.log(
	`${dryRun ? 'would remove' : 'removed'} ${removed.length} server npm packages the server never loads (${(freed / 1048576).toFixed(0)} MB); kept ${keep.size}`,
);
if (process.env.PRUNE_VERBOSE) {
	console.log(removed.join('\n'));
}
