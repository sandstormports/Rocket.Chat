#!/usr/bin/env bash
# Build the Rocket.Chat Sandstorm package.
#
#   build.sh bundle        build the Meteor bundle into .build/bundle
#   build.sh deps          assemble .build/deps (node, mongod, libs, launcher)
#   build.sh dev           bundle + deps, then `spk dev` against a local Sandstorm
#   build.sh pack OUT.spk  bundle + deps, then `spk pack`
#
# Set SKIP_BUNDLE=1 / SKIP_DEPS=1 to reuse an existing .build/bundle / .build/deps
# with dev/pack.
# Set APP_ID to package under another app ID than the pkgdef's, e.g. one from
# `spk keygen` for test builds when you do not hold the real app's signing key.
#
# The package is a Community (FOSS) build: no Enterprise-licensed server code
# from apps/meteor/ee or ee/ goes in. See foss/README.md.
#
# The bundle steps mirror upstream CI (.github/actions/meteor-build) and the
# Docker image (apps/meteor/.docker/Dockerfile.debian). Needs Meteor, yarn 4
# (corepack), g++/make/python3 for native modules, and for dev/pack a Sandstorm
# install that provides `spk`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BUILD="$HERE/.build"
YARN="${YARN:-corepack yarn}"

build_bundle() {
	echo "==> workspace packages"
	cd "$REPO"
	$YARN install
	$YARN build

	prepare_foss_source

	echo "==> meteor build"
	cd "$FOSS_SRC/apps/meteor"
	rm -rf "$BUILD/bundle"
	meteor build --server-only --directory "$BUILD"

	echo "==> server npm dependencies"
	cd "$BUILD/bundle/programs/server"
	meteor npm install --omit=dev
	(cd npm/node_modules/isolated-vm && meteor npm install --omit=dev)

	echo "==> trim"
	# Same removals as upstream CI and the Docker image: other platforms' swc
	# binaries, compilers, type definitions and source maps nothing reads at runtime.
	for dir in \
		meteor/babel-compiler/node_modules/@meteorjs/swc-core/.swc/node_modules/@swc/core-darwin-arm64 \
		meteor/babel-compiler/node_modules/@meteorjs/swc-core/.swc/node_modules/@swc/core-linux-x64-musl \
		meteor/babel-compiler/node_modules/@meteorjs/swc-core/.swc/node_modules/@swc/core-linux-arm64-musl \
		meteor/babel-compiler/node_modules/typescript \
		@rocket.chat/i18n/src \
		typescript; do
		rm -rf "npm/node_modules/$dir"
	done
	find "$BUILD/bundle" -type f -name '*.d.ts' -delete
	find npm/node_modules -type f -name '*.map' -delete
	find "$BUILD/bundle/programs/web.browser" -type f -name '*.map' -delete

	finish_bundle
}

# Steps after the npm install, also runnable alone on an existing bundle (`build.sh trim`).
finish_bundle() {
	cd "$BUILD/bundle/programs/server"
	# Sandstorm refuses packages over 1 GiB uncompressed, so trim further:
	# - Meteor's optional uWebSockets.js transport; the grain uses SockJS (the default);
	# - compilers and type data nested in workspace packages' own node_modules
	#   (not caniuse-lite: Meteor's boot loads @babel/preset-env, which needs it);
	# - native prebuilds for other platforms (grains are linux-x64, glibc).
	rm -rf npm/node_modules/meteor/ddp-server/node_modules/uWebSockets.js
	find npm/node_modules -type d \( -path '*/node_modules/typescript' -o -path '*/node_modules/@types' \) -prune -exec rm -rf {} +
	find npm/node_modules -type d -path '*/prebuilds/*' -prune ! -name 'linux-x64*' -exec rm -rf {} +

	replace_ee_packages
	node "$HERE/prune-server-modules.js" "$BUILD/bundle"
	dedupe_workspace_packages
	node "$HERE/foss/verify.js" "$BUILD/bundle" "$REPO"
	du -sh "$BUILD/bundle"
}

# Workspace packages that depend on each other get their own nested copies of the
# same build (e.g. @rocket.chat/apps carries all of @rocket.chat/apps-engine).
# Replace identical nested copies with links to the top-level one.
dedupe_workspace_packages() {
	echo "==> dedupe workspace packages"
	local npm="$BUILD/bundle/programs/server/npm/node_modules" nested name top
	while IFS= read -r nested; do
		name="@rocket.chat/$(basename "$nested")"
		top="$npm/$name"
		[ -d "$top" ] && [ ! -L "$top" ] || continue
		if diff -rq "$nested" "$top" >/dev/null 2>&1; then
			rm -rf "$nested"
			ln -s "$(realpath -m --relative-to="$(dirname "$nested")" "$top")" "$nested"
		fi
	done < <(find "$npm" -mindepth 4 -type d -path '*/node_modules/@rocket.chat/*' -prune)
}

# A copy of apps/meteor with the Enterprise code removed the way upstream's
# scripts/fossify.ts does it (delete apps/meteor/ee, use startRocketChatFOSS.ts),
# plus MIT stubs at the ee/ paths core still imports (foss/overlay). Everything
# else (node_modules, workspace packages) is linked from the repo.
FOSS_SRC="$BUILD/foss-src"
prepare_foss_source() {
	echo "==> FOSS source"
	mkdir -p "$FOSS_SRC/apps/meteor"
	for entry in "$REPO"/* "$REPO"/.[!.]*; do
		[ -e "$entry" ] || continue
		case "$(basename "$entry")" in apps | .git) continue ;; esac
		ln -sfn "$entry" "$FOSS_SRC/$(basename "$entry")"
	done
	rsync -a --delete \
		--exclude=/node_modules --exclude=/.meteor/local --exclude=/.sandstorm --exclude=/ee --exclude=/tests \
		"$REPO/apps/meteor/" "$FOSS_SRC/apps/meteor/"
	cp "$REPO/apps/meteor/startRocketChatFOSS.ts" "$FOSS_SRC/apps/meteor/startRocketChat.ts"
	rsync -a "$HERE/foss/overlay/apps/meteor/" "$FOSS_SRC/apps/meteor/"
	ln -sfn "$REPO/apps/meteor/node_modules" "$FOSS_SRC/apps/meteor/node_modules"
	# Start from the repo's Meteor build cache the first time; it is kept afterwards.
	if [ ! -d "$FOSS_SRC/apps/meteor/.meteor/local" ] && [ -d "$REPO/apps/meteor/.meteor/local" ]; then
		cp -a "$REPO/apps/meteor/.meteor/local" "$FOSS_SRC/apps/meteor/.meteor/local"
	fi
}

# The server bundle copies every workspace package the app depends on. Drop the
# Enterprise ones (everything under ee/packages) and put the MIT stand-ins from
# foss/packages in place of those core code still requires.
replace_ee_packages() {
	echo "==> replace Enterprise packages"
	local manifest name stub target main
	for manifest in "$REPO"/ee/packages/*/package.json; do
		name="$(node -p "require('$manifest').name")"
		find "$BUILD/bundle/programs/server" -type d -path "*/node_modules/$name" -prune -exec rm -rf {} +
		stub="$HERE/foss/packages/${name#@rocket.chat/}"
		[ -d "$stub" ] || continue
		target="$BUILD/bundle/programs/server/npm/node_modules/$name"
		cp -r "$stub" "$target"
		# Meteor bakes each package's resolved entry file into the server program,
		# so the stand-in must answer at the original package's "main" path too.
		main="$(node -p "require('$manifest').main || 'index.js'")"
		main="${main#./}"
		if [ "$main" != index.js ]; then
			mkdir -p "$(dirname "$target/$main")"
			local rel
			rel="$(realpath -m --relative-to="$(dirname "$target/$main")" "$target/index.js")"
			[[ "$rel" == .* ]] || rel="./$rel"
			echo "module.exports = require('$rel');" > "$target/$main"
			node -e "const f='$target/package.json',p=require(f);p.main='./$main';require('fs').writeFileSync(f,JSON.stringify(p,null,'\\t')+'\\n')"
		fi
	done
}

build_deps() {
	bash "$HERE/build-deps.sh" "$BUILD/bundle" "$BUILD/deps"
}

prepare() {
	[ "${SKIP_BUNDLE:-}" = 1 ] && [ -f "$BUILD/bundle/main.js" ] || build_bundle
	[ "${SKIP_DEPS:-}" = 1 ] && [ -x "$BUILD/deps/bin/node" ] || build_deps
	cd "$HERE"
	PKGDEF=sandstorm-pkgdef.capnp
	if [ -n "${APP_ID:-}" ]; then
		# Kept next to the original so its relative `embed` paths still resolve.
		PKGDEF=sandstorm-pkgdef.local.capnp
		# The embedded PGP signature vouches for the real app ID only, so a test build
		# under another ID leaves out the author verification.
		sed -e "s/^\(\s*id = \)\"[a-z0-9]*\"/\1\"$APP_ID\"/" -e '/pgpSignature = embed/d' -e '/pgpKeyring = embed/d' \
			sandstorm-pkgdef.capnp > "$PKGDEF"
		grep -q "\"$APP_ID\"" "$PKGDEF" || { echo "could not set APP_ID in $PKGDEF" >&2; exit 1; }
	fi
}

case "${1:-}" in
	bundle) build_bundle ;;
	# Internal: redo the trimming, Enterprise package swap and checks on an existing bundle.
	trim) finish_bundle ;;
	deps) build_deps ;;
	dev)
		prepare
		spk dev -p "$PKGDEF:pkgdef"
		;;
	pack)
		[ -n "${2:-}" ] || { echo "usage: $0 pack OUT.spk" >&2; exit 1; }
		OUT="$(readlink -m "$2")"
		prepare
		spk pack -p "$PKGDEF:pkgdef" "$OUT"
		ls -la "$OUT"
		;;
	*)
		sed -n '2,13p' "$0" >&2
		exit 1
		;;
esac
