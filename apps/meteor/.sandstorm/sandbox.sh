#!/usr/bin/env bash
# Run the built grain locally in a bubblewrap sandbox laid out like a Sandstorm
# grain (see src/sandstorm/supervisor.c++ and spk.c++ in the Sandstorm repo):
#
#   /                  read-only: .build/deps overlaid with .build/bundle
#   /dev, /tmp         small tmpfs
#   /var               the grain's storage (here: $GRAIN_VAR_DIR)
#   /proc/cpuinfo      the only thing under /proc (no /proc/self, no /sys)
#
# The network is shared with the host, so dev-bridge.js can reach the grain on
# 127.0.0.1:8000. Unlike Sandstorm there is no seccomp filter or user namespace
# remapping, so a clean run here is necessary but not sufficient.
#
#   sandbox.sh                 run the launcher (like the pkgdef's command)
#   sandbox.sh CMD [ARGS...]   run CMD inside the grain filesystem instead
#
# Env: GRAIN_VAR_DIR (default .build/var), DB_BACKEND (default mongod),
# GRAIN_HTTP_LOG=1 to log requests (see start.js).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPS="$HERE/.build/deps"
BUNDLE="$HERE/.build/bundle"
VAR="$(readlink -m "${GRAIN_VAR_DIR:-$HERE/.build/var}")"

[ -x "$DEPS/bin/node" ] && [ -f "$BUNDLE/main.js" ] || { echo "run build.sh bundle and build.sh deps first" >&2; exit 1; }
mkdir -p "$VAR"

args=(--tmpfs /)
shopt -s dotglob
for entry in "$DEPS"/* "$BUNDLE"/*; do
	args+=(--ro-bind "$entry" "/$(basename "$entry")")
done
args+=(
	--dev /dev
	--tmpfs /tmp
	--bind "$VAR" /var
	--ro-bind /proc/cpuinfo /proc/cpuinfo
	--remount-ro /
	--unshare-pid
	--die-with-parent
	--chdir /
	--clearenv
	# The environment from sandstorm-pkgdef.capnp, plus what the bridge adds.
	--setenv PATH /usr/local/bin:/usr/bin:/bin
	--setenv HOME /var
	--setenv SANDSTORM 1
	--setenv NODE_ENV production
	--setenv DB_BACKEND "${DB_BACKEND:-mongod}"
	--setenv GRAIN_HTTP_LOG "${GRAIN_HTTP_LOG:-}"
)

if [ $# -gt 0 ]; then
	exec bwrap "${args[@]}" "$@"
fi
exec bwrap "${args[@]}" /bin/node /sandstorm/start.js
