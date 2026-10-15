# Community (FOSS) build

The Sandstorm package contains only MIT-licensed server code.

## Why

Rocket.Chat's root `LICENSE` puts everything under `apps/meteor/ee/` and `ee/` under the Enterprise Edition license. That license forbids redistributing that code, and forbids using modified copies in production without a subscription. Those directories also enforce Rocket.Chat 7+'s air-gapped restriction: an unlicensed workspace that cannot report statistics to Rocket.Chat Cloud becomes read-only. A Sandstorm grain has no outbound network, so every grain would be read-only from first boot.

The EE license does not cover code compiled into client-side JavaScript, which stays MIT. So only the server program has to be free of it.

## How

`build.sh bundle` does the following:

1. Builds the workspace packages as usual.
2. Prepares `.build/foss-src`, a copy of `apps/meteor` with the Enterprise code removed the same way upstream's `scripts/fossify.ts` removes it: `apps/meteor/ee` is deleted and `startRocketChatFOSS.ts` replaces `startRocketChat.ts`. Everything else is linked from the repo.
3. Copies `overlay/` on top. Upstream's FOSS mode is incomplete in 8.x: a few MIT files still import from `apps/meteor/ee`. The overlay puts MIT stubs at exactly those paths, each marked `SANDSTORM-FOSS-STUB`.
4. Runs `meteor build` from that copy.
5. Removes every package from `ee/packages` that the server bundle copied, and installs the MIT stand-ins from `packages/` for the ones core still `require`s.
6. Runs `verify.js`, which fails the build if any server module from an `ee/` path is not a stub, or any Enterprise-named package is not a stand-in.

Nothing in the repo is modified; the copy lives under `.build/`.

## What the stubs do

| Replaces | MIT stand-in |
| --- | --- |
| `apps/meteor/ee/server` (barrel imported by `server/main.ts`) | No Apps-Engine. Registers the `ReadReceiptsArchive` dummy model, plus `licenses.info` / `licenses.maxActiveUsers` endpoints that report "no license, no limits" |
| `ee/server/presence.ts` (overlay) | Reports DDP connections, logins and logouts to the presence service |
| `ee/server/lib/omnichannel/Helper`, `hooks/messages/BeforeSaveCannedResponse`, `api/v1/middlewares/license` | No-ops (queue position, canned responses, license-gated endpoints are refused) |
| `ee/lib/misc/Utilities`, `determineFileType` | Small helpers used by the apps UI and Apps-Engine bridges |
| `@rocket.chat/license` | No license: no modules, no limits, never restricted |
| `@rocket.chat/presence` | A single-process presence service: online / away / busy / invisible, per connection |
| `@rocket.chat/omnichannel-services` | Services registered under the same names that do nothing |
| `@rocket.chat/federation-matrix`, `@rocket.chat/media-calls` | Inert; federation and voice calls are Enterprise features |

## What a Community build lacks

The Enterprise features: the Apps-Engine and marketplace, omnichannel queues/units/SLAs/canned responses, read receipts, engagement dashboard, auditing, LDAP/SAML/OAuth enterprise sync, device management, voice calls, Matrix federation. Most of them need outbound network access anyway, which a grain does not have.

When upgrading Rocket.Chat, rerun the build. `verify.js` catches new Enterprise modules reaching the server, and a failing `meteor build` usually means core grew a new import into `apps/meteor/ee` that needs a stub.
