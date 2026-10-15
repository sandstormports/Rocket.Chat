#!/usr/bin/env bash
# A throwaway development Sandstorm in Docker, for testing the package without
# installing Sandstorm on the host.
#
#   docker-sandstorm.sh up       create the container, install Sandstorm (dev mode), start it
#   docker-sandstorm.sh start    start it again (e.g. after Docker restarted)
#   docker-sandstorm.sh dev      run `spk dev` for this app inside the container (Ctrl-C to stop)
#   docker-sandstorm.sh pack     `spk pack` .build/rocketchat-test.spk, signed with a test key
#   docker-sandstorm.sh shell    a shell in the container
#   docker-sandstorm.sh down     remove the container (and its grains)
#
# Build first (`build.sh bundle && build.sh deps`); this directory is mounted at
# the same path inside the container. Then open http://local.sandstorm.io:6080,
# sign in with a dev account, and the app appears while `dev` runs.
#
# Sandstorm needs namespaces, mounts and its own seccomp filter, so the container
# runs privileged.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${SANDSTORM_CONTAINER:-rocketchat-sandstorm-dev}"
PORT="${SANDSTORM_PORT:-6080}"
TEST_KEYRING=/root/.sandstorm-keyring

in_container() { docker exec -i "$NAME" "$@"; }

case "${1:-}" in
	up)
		docker run -d --name "$NAME" --privileged -p "$PORT:6080" -v "$HERE:$HERE" -w "$HERE" ubuntu:24.04 sleep infinity
		in_container bash -euc '
			apt-get update -qq
			DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl xz-utils ca-certificates >/dev/null
			curl -fsSL https://install.sandstorm.io -o /tmp/install.sh
			# -d: unattended development install (local.sandstorm.io, dev accounts allowed).
			REPORT=no bash /tmp/install.sh -d
			# Listen on the container interface so the published port reaches it.
			sed -i "s/^BIND_IP=.*/BIND_IP=0.0.0.0/" /opt/sandstorm/sandstorm.conf
			/opt/sandstorm/sandstorm restart
		'
		echo "Sandstorm: http://local.sandstorm.io:$PORT"
		;;
	start)
		docker start "$NAME" >/dev/null
		in_container /opt/sandstorm/sandstorm start
		echo "Sandstorm: http://local.sandstorm.io:$PORT"
		;;
	dev)
		docker exec -it "$NAME" bash -c "cd '$HERE' && SKIP_BUNDLE=1 SKIP_DEPS=1 PATH=/opt/sandstorm/latest/bin:\$PATH ./build.sh dev"
		;;
	pack)
		# spk signs with the app's private key; generate a test one inside the container.
		APP_ID="$(in_container bash -c "[ -s $TEST_KEYRING.id ] || /opt/sandstorm/latest/bin/spk keygen > $TEST_KEYRING.id; tail -1 $TEST_KEYRING.id" | tr -d '[:space:]')"
		in_container bash -c "cd '$HERE' && SKIP_BUNDLE=1 SKIP_DEPS=1 APP_ID=$APP_ID PATH=/opt/sandstorm/latest/bin:\$PATH ./build.sh pack .build/rocketchat-test.spk"
		;;
	shell) docker exec -it "$NAME" bash ;;
	down) docker rm -f "$NAME" ;;
	*)
		sed -n '2,16p' "$0" >&2
		exit 1
		;;
esac
