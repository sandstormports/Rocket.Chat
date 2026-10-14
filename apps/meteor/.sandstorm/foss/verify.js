// Checks that a Community (FOSS) bundle carries no Enterprise-licensed server code:
//
//   1. every module compiled into the server program from an ee/ directory is one
//      of the MIT stubs in foss/overlay (they are marked SANDSTORM-FOSS-STUB);
//   2. every npm package named after a package in the repo's ee/packages is the
//      MIT stand-in from foss/packages, wherever it sits in node_modules.
//
// Client code is not checked: the EE license puts anything compiled into
// client-side JavaScript under MIT.
//
// Usage: node verify.js <bundle-dir> <repo-dir>
const fs = require('fs');
const path = require('path');

const [bundle, repo] = process.argv.slice(2).map((p) => path.resolve(p));
const overlay = path.join(__dirname, 'overlay/apps/meteor');
const problems = [];

// 1. Server app modules, from the source map Meteor writes next to app.js.
const map = JSON.parse(fs.readFileSync(path.join(bundle, 'programs/server/app/app.js.map'), 'utf8'));
const eeSources = map.sources.map((source) => source.replace(/^meteor:\/\/[^/]*app\//, '')).filter((source) => /^ee\//.test(source));
for (const source of eeSources) {
	const stub = path.join(overlay, source);
	if (!fs.existsSync(stub) || !fs.readFileSync(stub, 'utf8').includes('SANDSTORM-FOSS-STUB')) {
		problems.push(`server module from Enterprise code: ${source}`);
	}
}

// 2. npm packages.
const eePackages = new Set(
	fs
		.readdirSync(path.join(repo, 'ee/packages'))
		.map((dir) => path.join(repo, 'ee/packages', dir, 'package.json'))
		.filter((file) => fs.existsSync(file))
		.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).name),
);

let checkedPackages = 0;
const walk = (dir) => {
	const manifest = path.join(dir, 'package.json');
	if (fs.existsSync(manifest)) {
		let name;
		try {
			({ name } = JSON.parse(fs.readFileSync(manifest, 'utf8')));
		} catch {
			name = undefined;
		}
		if (eePackages.has(name)) {
			checkedPackages++;
			const entry = path.join(dir, 'index.js');
			if (!fs.existsSync(entry) || !fs.readFileSync(entry, 'utf8').includes('SANDSTORM-FOSS-STUB')) {
				problems.push(`Enterprise package in bundle: ${path.relative(bundle, dir)}`);
			}
		}
	}
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			walk(path.join(dir, entry.name));
		}
	}
};
walk(path.join(bundle, 'programs/server'));

// Core requires every stand-in (that is why it exists), so each must be in the bundle.
for (const stub of fs.readdirSync(path.join(__dirname, 'packages'))) {
	if (!fs.existsSync(path.join(bundle, 'programs/server/npm/node_modules/@rocket.chat', stub, 'package.json'))) {
		problems.push(`MIT stand-in missing from bundle: @rocket.chat/${stub}`);
	}
}

if (problems.length) {
	console.error(`FOSS check failed:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}
console.log(
	`FOSS check passed: ${eeSources.length} ee/ server modules are MIT stubs, ${checkedPackages} EE-named packages are MIT stand-ins`,
);
