# Sandstorm API client

`index.mjs` talks Cap'n Proto RPC to `sandstorm-http-bridge` over the grain's `/tmp/sandstorm-api` socket. Rocket.Chat uses it for activity events and Powerbox grain sharing (`apps/meteor/server/sandstorm/`). The bridge has no HTTP route for either.

The client runs outside the Meteor bundle, so Rocket.Chat's dependencies are unchanged:
- `build-deps.sh` copies this directory to `/sandstorm/bridge` in the grain.
- `start.js` sets `SANDSTORM_BRIDGE_MODULE` to its path.
- The server loads it with Node's `require(esm)`.

Everything except `index.mjs` and this README is vendored from [WeKan](https://github.com/wekan/wekan) at commit `9e1d5f65bd9b4159a0eb0ea4b32243b86ef955f7`, all MIT-licensed:

| Path | From | What |
| --- | --- | --- |
| `capnp-es/` | `npm-packages/capnp-es/dist/` (runtime files only: `index.mjs`, `shared/capnp-es.{D8zdZmih,CFSf015t,BVG6upt7,BlZmb8ia}.mjs`, `capnp/{rpc,stream}.mjs`) and its `LICENSE` | WeKan's fork of [capnp-es](https://github.com/unjs/capnp-es) 0.0.16, a pure-JavaScript Cap'n Proto implementation. The fork completes the RPC layer the bridge relies on (Resolve, Release, tail calls). Its `README.md` and `patches/wekan.patch` in WeKan list every change. |
| `capnp/` | `imports/sandstorm/capnp/{sandstorm-http-bridge,grain,activity,identity,powerbox,util}.mjs` | Classes generated from Sandstorm's own schemas (sandstorm-io/sandstorm `a97cf3ee19d3bf2761cd597583ca5d998de425d8`) by WeKan's `releases/sandstorm-capnp-schemas.sh`. |

The only edit to the vendored files is in `capnp/*.mjs`, where imports of `@wekanteam/capnp-es` were rewritten to the relative paths of `capnp-es/`:

```sh
sed -i 's#"@wekanteam/capnp-es/capnp/stream"#"../capnp-es/capnp/stream.mjs"#; s#"@wekanteam/capnp-es"#"../capnp-es/index.mjs"#' capnp/*.mjs
```

To update, copy the same files from a newer WeKan commit and repeat the rewrite.

The connection code in `index.mjs` is adapted from WeKan's `imports/sandstorm/bridgeClient.mjs` (MIT).
