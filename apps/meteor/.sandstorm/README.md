# Rocket.Chat for Sandstorm

Packaging and launcher for running Rocket.Chat as a [Sandstorm](https://sandstorm.org) app.

## Layout

| File | Purpose |
| --- | --- |
| `sandstorm-pkgdef.capnp` | Package definition: app ID, metadata, permissions/roles, launch command |
| `build.sh` | Builds the Community bundle, assembles the deps tree, runs `spk dev` / `spk pack` |
| `foss/` | The Community (MIT-only) build: overlay stubs, stand-in packages, `verify.js` ([README](foss/README.md)) |
| `build-deps.sh` | Assembles `.build/deps`: Node, MongoDB 8.0, shared libraries, `/sys` and `/proc` stubs, launcher |
| `prune-server-modules.js` | Drops npm packages the server program can never load (Meteor copies client-only ones too) |
| `start.js` | Grain launcher (a grain has no shell): please-wait page, database, settings, `main.js` |
| `sandbox.sh` | Runs the built grain in a bubblewrap sandbox laid out like a real grain |
| `dev-bridge.js` | Local stand-in for `sandstorm-http-bridge` with fake identities |
| `smoke-test.mjs` | End-to-end checks against a running grain through `dev-bridge.js` |
| `docker-sandstorm.sh` | A throwaway development Sandstorm in Docker for `spk dev` / `spk pack` |
| `../server/sandstorm/` | Server-side integration (Sandstorm login), loaded when `SANDSTORM=1` |

At runtime the grain's filesystem is `.build/deps` overlaid with `.build/bundle`. Only `/var` is writable: the database lives in `/var/mongodb`, uploads in `/var/uploads`.

## How it works

- **Community build.** The package carries no Enterprise-licensed server code. That code may not be redistributed, and it would make every grain read-only: Rocket.Chat restricts unlicensed workspaces that cannot report to its cloud. `build.sh` builds from a copy with `apps/meteor/ee` removed the way upstream's `scripts/fossify.ts` does, plus MIT stubs; see [foss/README.md](foss/README.md).
- **Database.** `start.js` runs the bundled `mongod` as a single-node replica set (Rocket.Chat uses transactions) and points `MONGO_URL`/`MONGO_OPLOG_URL` at it. Rocket.Chat 8.x no longer needs change streams for realtime updates, which also makes an embedded FerretDB possible: `DB_BACKEND=ferretdb` is wired up but experimental.
- **Login.** Sandstorm is the only identity provider. The launcher turns on Rocket.Chat's iframe authentication and points it at `/.sandstorm-login`, which reads the `X-Sandstorm-*` headers the bridge sets, creates or updates the user (username from the Sandstorm handle) and returns a resume token. Users with the Sandstorm `admin` permission (the grain owner, or anyone shared as "administrator") get the Rocket.Chat `admin` role; it is re-synced on every login. Admins are not asked to "fix" the Site URL, since every Sandstorm session has its own host.
- **Settings.** Things the sandbox rules out are forced with `OVERWRITE_SETTING_*`. That covers cloud registration, statistics, the update checker, push, URL previews, password login and registration, the setup wizard, and GridFS storage (replaced by the filesystem). `Iframe_Restrict_Access` is forced off because Sandstorm frames the app. See `FORCED_SETTINGS` in `start.js`.
- **Grain quirks.**
  - **No `/sys`, minimal `/proc`.** A grain has no `/sys`, and its `/proc` holds only `cpuinfo`. mongod 8 aborts without the CPU range and memory size, so the package ships small stubs for those two files.
  - **Random hosts.** Every session reaches the grain on its own random host, so the client derives its DDP URL from the page's origin, never from `ROOT_URL`. `ROOT_URL` is deliberately unresolvable (`grain.sandstorm.invalid`), so anything that still uses it fails in local tests too.
  - **Header filtering.** Sandstorm's bridge drops non-whitelisted request headers, including Rocket.Chat's `X-User-Id` / `X-Auth-Token`. Inside a grain the client sends custom headers as `X-Sandstorm-App-*` and the server maps them back (`lib/sandstormHeaders.ts`).
  - **Plain HTTP.** Sandstorm servers are often plain HTTP, where browsers withhold secure-context APIs such as `crypto.randomUUID` (polyfilled in `client/meteor/overrides/randomUUID.ts`). End-to-end encryption needs HTTPS.

## Building

Requirements: Meteor (the version in `../.meteor/release`), yarn 4 via corepack, rsync, build tools for native npm modules (`g++ make python3`), bubblewrap for the isolated checks, and a Sandstorm install for `spk` (or Docker, see below).

```sh
./build.sh bundle          # Community bundle -> .build/bundle (slow the first time)
./build.sh deps            # node + mongod + libs + launcher -> .build/deps
./build.sh dev             # both, then `spk dev` on the local Sandstorm
./build.sh pack out.spk    # both, then `spk pack`
SKIP_BUNDLE=1 SKIP_DEPS=1 ./build.sh dev   # reuse what is built
```

Sandstorm refuses packages over 1 GiB uncompressed, so the build trims the bundle:
- the unused uWebSockets transport, nested compilers and type data, and other platforms' native binaries
- npm packages no server code path can load
- duplicate copies of workspace packages
- debug symbols in `node` and `mongod`

The result is about 800 MiB.

The package is signed with the app's key from your Sandstorm keyring. To pack a test build without the real key, set `APP_ID` to an ID from `spk keygen`. Publishing under the existing app ID is up to whoever holds that key.

## Testing

Without Sandstorm, in a sandbox laid out like a grain:

```sh
./sandbox.sh &             # launcher in bubblewrap, data in .build/var
node dev-bridge.js &       # http://localhost:9000 -> 127.0.0.1:8000, with Sandstorm headers
node smoke-test.mjs
```

In a browser, use `http://localhost:9000/?sandstorm_user=alice` (admin) and `http://127.0.0.1:9000/?sandstorm_user=bob` (member). The two hosts are different origins, so both users can be signed in at once. `?sandstorm_user=anonymous` shows a visitor without a Sandstorm account.

`dev-bridge.js` filters request headers the way Sandstorm does. `localhost` and `127.0.0.1` count as secure contexts in browsers, so use the machine's LAN address to also catch problems a plain-HTTP Sandstorm would show. Run with `GRAIN_HTTP_LOG=1` to log every request the grain receives.

On a real (development) Sandstorm in Docker:

```sh
./docker-sandstorm.sh up     # then open http://local.sandstorm.io:6080 and sign in as a dev user
./docker-sandstorm.sh dev    # the app shows up in Sandstorm while this runs
./docker-sandstorm.sh pack   # .build/rocketchat-test.spk, signed with a throwaway key
./docker-sandstorm.sh down
```

## Status

**Milestone 1 (Community grain on a bundled MongoDB) is done.** Tested on Sandstorm 308 (development install in Docker):
- a grain boots, and the owner is signed in automatically as admin
- a share link brings in other users as members; anonymous visitors are asked to sign in
- chat, history, presence and uploads work
- the packed `.spk` (about 185 MiB compressed, 820 MiB unpacked) installs and runs

A fresh grain uses about 200 MB of storage, mostly MongoDB's preallocated files.

Next:
- **Milestone 2:** the embedded FerretDB backend (`DB_BACKEND=ferretdb`), to cut per-grain memory and storage.
- **Milestone 3:** port the remaining pre-2019 integration (`git show df23847319^:<path>`):
  - Sandstorm activity events for new messages and mentions
  - Powerbox grain sharing and `grain://` link previews
  - `setPath` (keeping Sandstorm's URL bar in sync with the room)
  - Sandstorm profile pictures as avatars

Existing grains from the 2017 package (Rocket.Chat 0.53) cannot be upgraded in place. Rocket.Chat refuses to migrate data older than 4.x. Publishing under the existing app ID needs its signing key, which the maintainers hold.
