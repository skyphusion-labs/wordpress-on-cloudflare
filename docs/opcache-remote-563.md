# OPcache warm files as remote packs: PHP pauses in open() (#563, #394 Gate 1)

Status: built behind a flag, default OFF. Written 2026-11-14 by rollins (seat rollins-sb1114d).
Design: pagefeather#394 [issuecomment-6877914398](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6877914398).
Gate 0 (production): [issuecomment-6878010968](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6878010968).

## What it does

After L1 (`OPCACHE_SPLIT=1`), the OPcache BOOT files are static assets, but the WARM files are
still `build/opcache.zip`, a data module held for the life of the isolate.
With `OPCACHE_REMOTE=1` they leave the bundle too:

- `opcache-split.py --remote` writes them as packs, `build/public/_pf/<build-id>/warm-<n>.zip`,
  each about `REMOTE_PACK_KIB` (default 512) deflated, in path order. `build/opcache.zip` is left
  EMPTY. `build/opcache-remote-index.js` gets the index: per file, its pack and size; per pack, its
  length and SHA-256.
- `index.js` `boot()` mounts one MEMFS node per warm file, so `stat()` needs no bytes.
- `prepare.sh` patches the loader (PY5): `__syscall_openat` becomes a JSPI `WebAssembly.Suspending`
  import, and `___syscall_openat` asks the `pagefeatherOpen` hook first. A promise from the hook
  means PHP waits while the object fetches the file's pack (`remote-packs.mjs`). Then the open runs
  as usual and the node inflates from the held pack.
- Held packs live for one request: `endRequest()` runs next to `evictLazy()`.

The wasm is unchanged. Under JSPI the loader picks the suspendable imports in JS, by name.

## Default OFF

- Without `OPCACHE_REMOTE=1` the build writes `export default null;` as the index, `boot()` passes
  no hook, and the loader does not wrap `__syscall_openat` at all (tested: `opcache-remote.test.mjs`,
  "default OFF").
- `OPCACHE_REMOTE=1` needs `OPCACHE_SPLIT=1` (the trace, the `ASSETS` binding, `/_pf/` first).
  The render fails without it.
- The render writes the var `OPCACHE_REMOTE = "on"`, so the config hash changes with the flag
  (the build id does not), and `site update` uploads.
- The runtime kill switch is the var `OPCACHE_REMOTE=off`. No remote node is made, so the warm
  scripts compile from source.

## Fail clean

| case | what PHP sees | the page |
|---|---|---|
| the pack answers non-200 | `open()` fails with EIO | OPcache compiles from source: correct, more CPU |
| the pack length differs from the index | the same | the same |
| the SHA-256 differs from the index | the same | the same |
| `REMOTE_FETCH_CAP` reached in this request | the same | the same |
| no `ASSETS` binding | no remote node (logged `fallback:no-assets-binding`) | the same |

- A pack is never used unless its length AND SHA-256 match. So no half file and no other build's
  bytes. A SHA-256 of the whole pack is used in place of per-file CRC-32: one check per fetch, and
  it covers truncation.
- A pack that failed is not fetched again in that request; the next request tries again.

## Subrequests

Gate 0 measured that `ASSETS.fetch` counts against the subrequest limit. Each pack fetch is one
subrequest:
- `REMOTE_FETCH_CAP` (default 32, from 0 to 1000) is the most a request may fetch;
- the boot request also fetches the L1 boot chunks (`l1` in `x-perf`), which are not in the cap;
- on WfP, a site map `subRequests` value, if set, must stay above the cap plus the request's other
  subrequests.

## The instrument: `x-perf`

| field | meaning |
|---|---|
| `remote` (booting requests) | `packs <n> files <m> cap <c>`, `off`, `fallback:no-assets-binding`, `none` |
| `rfN` | pack fetches in this request (subrequests) |
| `rfKiB`, `rfMs` | their bytes and time |
| `rfFail` | fetches that failed (404, length, SHA-256): clean misses |
| `rfCapped` | opens refused by the cap: clean misses |

## Tests

- `spikes/b2-wordpress/tests/opcache-remote.test.mjs` (ci.yml, Node 24, the real loader and PHP).
  It uses a file cache of a script returning OLD, with the source changed to NEW. OLD can come only
  from the fetched pack, and NEW is the clean compile. The cases: a good pack gives OLD; a 404, a
  short pack, a SHA-256 mismatch and cap 0 each give NEW; a retry on the next request gives OLD; a
  loader without the pattern edit does NOT give OLD; and no hook means no wrapped open. Red on the
  loader from main (7 of 8 fail; the guard case passes on both).
- `tests/opcache-split-test.py`: `--remote` packs, index, SHA-256, the empty `opcache.zip`.
- `tests/remote-e2e.sh` (opcache-build.yml, local workerd): e2e.sh and tests/woo.py three ways
  (remote, cap 0, off), and `/_pf/` never served.
- `deploy/wfp/tests/render-test.sh`: the flag's render rules.

## The proof (to run; nothing is claimed yet)

The expected gain is the bytes of the warm module: the size of `build/opcache.zip` on a split build.
The M0 re-trace put it at 6.4 MiB deflated (`opcache-split.py` docstring). Compared with an UNSPLIT
build, L1 plus this takes all of `opcache.zip` out (about 21 MiB, docs/design-394-bundle-out-of-memory.md
1.2). The isolate charge is not the byte count: the #394 floor probes charged 32 MiB for 40.3 MiB
of zips. Measure it; never assume it.

1. The lead deploys two throwaway b-dosql sites on the sample store, the same in everything else:
   (a) `OPCACHE_SPLIT=1`, (b) `OPCACHE_SPLIT=1 OPCACHE_REMOTE=1`. Both have `HEADROOM_PROBE=on`.
2. **Headroom:** `/_headroom` (#559) after the same real request on each, 3x alternating. The gain
   is (b) minus (a).
3. **The 7-screen round** (`tests/load/data/admin-matrix-2026-11-14/tools/admin-round.py`), the
   windows of docs/admin-memory-matrix.md (+0, +20, +60 min), on each site. Read:
   - memory deaths from GraphQL (`workersInvocationsAdaptive` and the DO dataset, `exceededMemory`);
   - the retried GETs (`x-isolate-retry`);
   - per request `rfN`, `rfFail`, `rfCapped`;
   - page time p50 and p95 per screen.
4. **Pass line:** `rfFail` 0 and `rfCapped` 0 on every request, `rfN` at most the cap, (b)
   memory deaths below (a), and (b) p95 within 10 % of (a) on each screen.
5. If `rfN` on cold runtimes is high, regroup the packs by co-access from the trace before
   `site.zip` (#394 Gate 2).

Not wired: approach A (`deploy/deploy.sh`, PHP in the Worker). WfP b-dosql only.
