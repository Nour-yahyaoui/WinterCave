# The actix server

`crates/wintercave-server` is WinterCave's local server, built on
[actix-web](https://actix.rs). It does the same two jobs as `server/` (the
TypeScript server): serve the built web shell out of `dist/`, and expose a file
API confined to a root directory.

Both servers are in the repository on purpose. `server/` is dependency-free
TypeScript and needs nothing but Node; this one is Rust and needs a toolchain.
The **contract is identical** — same routes, same JSON, same error codes — so the
web shell cannot tell which one answered, and either can be used.

```
crates/wintercave-server/src/
  main.rs           binary: parse flags, bind, print the port, serve
  config.rs         flags and environment (same flags as server/index.ts)
  api.rs            routing, JSON bodies, CORS, the static default service
  files.rs          the only module that touches the disk; atomic writes
  paths.rs          "inside the root or rejected" path rules
  static_files.rs   dist hosting, content types, ETag/304, SPA fallback
  error.rs          one error type: status + code + message
crates/wintercave-server/tests/api.rs   integration tests against a temp workspace
scripts/actix-smoke.mjs                 live HTTP smoke test against the real binary
```

## The API, unchanged

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health` | server name, version, workspace root, limits |
| `GET /api/files?path=` | read a UTF-8 text file |
| `PUT /api/files?path=` | replace an existing file (`{"text": "..."}`) |
| `POST /api/files?path=` | create a file, making parent directories |
| `DELETE /api/files?path=` | remove a file |
| `GET /api/tree?path=` | list a directory, folders first |

Error bodies are `{"error": {"code": "...", "message": "..."}}` with the same
codes as the TypeScript server: `bad_path`, `not_found`, `is_a_directory`,
`read_only`, `too_large`, `binary`, `bad_body`, `bad_json`,
`method_not_allowed`, `unknown_endpoint`, `io_error`.

The guarantees carry over:

- **Confinement.** `..`, absolute paths, drive letters and NUL bytes are rejected
  before the filesystem is touched; symlinked parents are resolved and checked.
- **Atomic writes.** The new text goes to a temp file beside the target, is
  flushed with `sync_all`, then renamed over it, and the directory is synced. A
  crash leaves the old file or the new one, never a half-written buffer.
- **Static hosting.** ETag and `304` revalidation, `immutable` caching for
  hashed assets, `no-cache` for `index.html`, SPA fallback for extension-less
  deep links, and `404` for a missing asset.

## Running it

```bash
# once, if you do not have Rust: https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

npm install
npm run build                        # produces dist/ (the app the server hosts)
cargo run -p wintercave-server -- --port 4173 --root . --dist dist
# or
npm run serve:rust -- --port 4173     # same thing; --dist defaults to "dist"
```

Flags are the ones `server/index.ts` already documents:

```
-p, --port <n>      port (default 4173, 0 picks a free port)
    --host <addr>   bind address (default 0.0.0.0)
    --root <dir>    directory the file API may read/write (default .)
    --dist <dir>    built app to serve (default dist)
    --no-dist       API only
    --read-only     refuse writes
    --max-bytes <n> largest file accepted, in bytes
-h, --help
```

`PORT`, `HOST`, `WINTERCAVE_ROOT` and `WINTERCAVE_DIST` work as defaults, exactly
like the TypeScript server. The server prints the address it bound, which is how
the smoke test finds an ephemeral port.

## What proves it works

```bash
cargo test -p wintercave-server    # 14 unit + 18 integration tests
cargo build -p wintercave-server
npm run smoke:rust                 # 43 assertions over real HTTP
cargo fmt -p wintercave-server -- --check
```

The integration tests drive a real actix service against a real temporary
workspace and assert the JSON contract, the status codes, the confinement
rules, ETag/304, read-only mode and that no temp file survives a write. The smoke
test then starts the compiled binary on an ephemeral port and repeats the
important parts over a socket, including that `/api/health` reports the same
version as `package.json`.

CI runs all of it in the `actix` job.

## Limits, stated plainly

- **HTTP only, no auth.** It binds `0.0.0.0` by default like the TypeScript
  server. On a shared machine, pass `--host 127.0.0.1`.
- **Disk access blocks the worker thread.** Handlers are async, but `std::fs`
  calls are not; for a local single-user server that is the right trade, for
  anything busier it is not.
- **No request log.** The TypeScript server prints one line per request; this one
  prints startup information only.
- **The app is not embedded.** `dist/` has to exist (`npm run build`), the binary
  does not carry the bundle.
- **No WebAssembly build here.** The editor engine stays a separate crate
  (`crates/wintercave-wasm`, built with `npm run wasm:build`); this server only
  serves the files.
- **Linux CI only.** The code is portable (the Unix-only bits are `#[cfg]`-gated)
  but only Linux is exercised.
