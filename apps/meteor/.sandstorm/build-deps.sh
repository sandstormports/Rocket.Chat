#!/usr/bin/env bash
# Assemble .build/deps: everything the grain needs besides the Meteor bundle.
#
#   bin/node            Meteor's own Node (the version the bundle was built for)
#   bin/mongod          MongoDB 8.0 (Rocket.Chat 8.x requires >= 7.0)
#   bin/ferretdb        optional, when FERRETDB_URL is set (DB_BACKEND=ferretdb)
#   lib*, usr/lib*      the shared libraries those binaries and the bundle's native
#                       npm modules link against, plus the matching dynamic loader
#   sys/, proc/         stubs for files mongod reads (a grain has no /sys or /proc)
#   sandstorm/start.js  the grain launcher
#   sandstorm/bridge/   Cap'n Proto client for the Sandstorm API (activity events, Powerbox)
#
# Modeled on meteor-spk's gather-deps.sh and WeKan's sandstorm-src/build-deps.sh,
# but built from scratch instead of on top of meteor-spk 0.6.0: Rocket.Chat needs
# neither Mongo 3 nor niscu, and leaving out the old base also leaves out its
# ancient sandstorm-http-bridge (spk adds the host's current one).
#
# Run on the same distribution the bundle's native modules were installed on
# (Ubuntu 24.04 in CI). Usage: build-deps.sh <bundle-dir> <deps-dir>
set -euo pipefail

BUNDLE="$(readlink -f "$1")"
DEPS="$(readlink -m "$2")"
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="${CACHE:-$HERE/.build/cache}"

MONGO_VERSION="${MONGO_VERSION:-8.0.34}"
MONGO_TARGET="${MONGO_TARGET:-ubuntu2404}"
MONGO_SHA256="${MONGO_SHA256:-3e55cdcf7013fbc805d29d8195230df4b23c7688733ee15ad58ac6bc2a416611}"
FERRETDB_URL="${FERRETDB_URL:-}"

[ -f "$BUNDLE/main.js" ] || { echo "no Meteor bundle at $BUNDLE" >&2; exit 1; }

rm -rf "$DEPS"
mkdir -p "$DEPS/bin" "$DEPS/sandstorm" "$CACHE"

echo "==> node"
# The bundle records the Node it was built with; use Meteor's copy of exactly that.
NODE_VERSION="$(tr -d '[:space:]' < "$BUNDLE/.node_version.txt")"
NODE_SRC="${NODE_BIN:-$(meteor node -e 'process.stdout.write(process.execPath)')}"
[ "$("$NODE_SRC" --version)" = "$NODE_VERSION" ] || {
	echo "node at $NODE_SRC is $("$NODE_SRC" --version), bundle wants $NODE_VERSION (set NODE_BIN)" >&2
	exit 1
}
cp -L "$NODE_SRC" "$DEPS/bin/node"

echo "==> mongod $MONGO_VERSION ($MONGO_TARGET)"
MONGO_TGZ="$CACHE/mongodb-linux-x86_64-$MONGO_TARGET-$MONGO_VERSION.tgz"
if [ ! -f "$MONGO_TGZ" ]; then
	curl -fL --retry 5 -o "$MONGO_TGZ.partial" "https://fastdl.mongodb.org/linux/$(basename "$MONGO_TGZ")"
	mv "$MONGO_TGZ.partial" "$MONGO_TGZ"
fi
echo "$MONGO_SHA256  $MONGO_TGZ" | sha256sum -c -
tar -xzf "$MONGO_TGZ" -C "$DEPS/bin" --strip-components=2 --wildcards '*/bin/mongod'
tar -xzf "$MONGO_TGZ" -O --wildcards '*/LICENSE-Community.txt' > "$DEPS/bin/mongod.LICENSE"

if [ -n "$FERRETDB_URL" ]; then
	echo "==> ferretdb from $FERRETDB_URL"
	curl -fL --retry 5 -o "$DEPS/bin/ferretdb" "$FERRETDB_URL"
	chmod +x "$DEPS/bin/ferretdb"
fi

echo "==> shared libraries"
# Copy a library into the deps tree at the same path, recreating symlinks.
copy_lib() {
	local file="$1" dst
	# Libraries shipped inside the bundle (e.g. sharp's libvips) load via $ORIGIN.
	[[ "$file" == "$BUNDLE"/* ]] && return
	dst="$DEPS${file/#\/usr\/local/\/usr}"
	[ -e "$dst" ] && return
	mkdir -p "$(dirname "$dst")"
	if [ -h "$file" ]; then
		local target
		target="$(readlink -f "$file")"
		ln -sf "${target/#\/usr\/local/\/usr}" "$dst"
		copy_lib "$target"
	elif [ -f "$file" ]; then
		cp "$file" "$dst"
	fi
}

mapfile -t objects < <(
	echo "$DEPS/bin/node"
	echo "$DEPS/bin/mongod"
	find "$BUNDLE" -name '*.node' -type f
)
# ldd lists both "name => /path" and the loader as a bare "/path". It exits
# non-zero when any input is not dynamically linked, which is fine here.
{ ldd "${objects[@]}" 2>/dev/null || true; } | grep -o '[[:space:]]/[^ ]*' | sort -u | while read -r lib; do
	copy_lib "$lib"
done

# libc.so.6 and the dynamic loader share a private ABI and must come from the same
# glibc. Every binary's PT_INTERP is /lib64/ld-linux-x86-64.so.2, so make sure
# that exact path exists in the grain.
LOADER="$(readlink -f /lib64/ld-linux-x86-64.so.2)"
mkdir -p "$DEPS/lib64"
cp -fL --remove-destination "$LOADER" "$DEPS/lib64/ld-linux-x86-64.so.2"

echo "==> strip"
# Debug symbols are a third of these binaries; Sandstorm caps packages at 1 GiB.
strip "$DEPS/bin/node" "$DEPS/bin/mongod"
find "$DEPS" -name '*.so*' -type f -exec strip --strip-unneeded {} + 2>/dev/null || true

echo "==> /sys and /proc stubs"
# A grain has no /sys and its /proc holds only cpuinfo (bound in by the
# supervisor), but the package can ship files at those paths, as meteor-spk did.
#
# mongod 8's tcmalloc reads the possible-CPU range at startup and aborts without
# it (CHECK in NumPossibleCPUsNoCache). Over-declaring is harmless (per-CPU caches
# are reserved lazily); under-declaring is not, so cover any plausible host.
mkdir -p "$DEPS/sys/devices/system/cpu"
echo 0-1023 > "$DEPS/sys/devices/system/cpu/possible"
# mongod sizes tcmalloc's per-CPU caches from MemTotal and refuses to start when it
# reads 0 ("Cache size must be at least 1KB * number of cores"). Node reads it too
# (libuv), to size V8's default heap at a quarter of it.
mkdir -p "$DEPS/proc"
printf 'MemTotal:        4194304 kB\nMemFree:         2097152 kB\nMemAvailable:    2097152 kB\n' > "$DEPS/proc/meminfo"
# Mount point for the supervisor's (and sandbox.sh's) bind of the real cpuinfo;
# spk packs this path as an empty file regardless.
: > "$DEPS/proc/cpuinfo"

echo "==> launcher"
cp "$HERE/start.js" "$DEPS/sandstorm/start.js"
rm -rf "$DEPS/sandstorm/bridge"
cp -r "$HERE/bridge" "$DEPS/sandstorm/bridge"
rm "$DEPS/sandstorm/bridge/README.md"

echo "==> verify"
# Run node and mongod with only the grain's filesystem visible, so a library or
# file missing from deps fails here instead of in a grain.
if command -v bwrap >/dev/null; then
	"$HERE/sandbox.sh" /bin/node --version
	"$HERE/sandbox.sh" /bin/mongod --version | head -1
	"$HERE/sandbox.sh" /bin/node -e 'require("/programs/server/npm/node_modules/sharp"); console.log("native modules load")'
	"$HERE/sandbox.sh" /bin/node -e 'require("/sandstorm/bridge/index.mjs"); console.log("Sandstorm API client loads")'
else
	echo "    bwrap not installed; skipping the isolated check"
fi
du -sh "$DEPS"
