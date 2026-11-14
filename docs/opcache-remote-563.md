# All OPcache files as remote packs: PHP pauses in open() (#563, #394 Gate 1)

Status: built behind a flag, default OFF. Written 2026-11-14 by rollins (seat rollins-sb1114d).
- Design: pagefeather#394 [issuecomment-6878206213](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6878206213).
  It supersedes the first, warm-only scope of 6877914398, which needed the split.
- Gate 0 (production): [issuecomment-6878010968](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6878010968).
- The ruling it follows: [issuecomment-6862048364](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6862048364).
  `OPCACHE_SPLIT` stays off. Item 3 allows an L1 variant that keeps the pack off the JS heap.

## What it does

With `OPCACHE_REMOTE=1` EVERY file of `build/opcache.zip` leaves the bundle. There is no split, no
boot pack, and nothing held across requests.

- **The build.** `file-trace.sh` traces the primed build. `opcache-remote.py` then writes the files
  into packs of about `REMOTE_PACK_KIB` (default 1024) deflated:
  - the packs are `build/public/_pf/<build-id>/oc-<n>.zip`;
  - the order is the cold-boot read order: the boot requests' first reads, then later requests',
    then the rest by path;
  - `opcache.zip` is left EMPTY, and `opcache-boot-index.js` is null;
  - `build/opcache-remote-index.js` gets a size per file, and a length plus SHA-256 per pack.
- **The boot.** `index.js` `boot()` mounts one MEMFS node per file, so `stat()` needs no bytes.
- **The loader.** `prepare.sh` PY5 makes `__syscall_openat` a JSPI `WebAssembly.Suspending` import,
  only when a `pagefeatherOpen` hook is set, and `___syscall_openat` asks the hook first.
  - A promise means PHP waits while the object fetches the file's pack (`remote-packs.mjs`).
  - Then the open runs as usual, and the node inflates from the held pack.
- **The held budget** (`REMOTE_HOLD_KIB`, default 4096, the lead's choice on the measured table below):
  - packs are evicted least recently used first, and the pack being opened is always kept;
  - a cold boot STREAMS through the packs with about 3.2 MiB held (measured). L1 held its
    14 MiB boot pack ([issuecomment-6861958043](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6861958043));
  - every pack is dropped at the end of the request (`endRequest()`, beside `evictLazy()`).

The wasm is unchanged. Under JSPI the loader picks the suspendable imports in JS, by name.

## Default OFF

- **Without `OPCACHE_REMOTE=1`:**
  - the index is `export default null;`;
  - `boot()` passes no hook, and the loader does not wrap `__syscall_openat` (tested).
- **`OPCACHE_REMOTE=1` and `OPCACHE_SPLIT=1` together fail the render.**
- **A remote build renders:**
  - the `ASSETS` binding and `run_worker_first = ["/_pf/*"]` (the packs hold the site's compiled
    PHP, #412);
  - the var `OPCACHE_REMOTE = "on"`, so the config hash changes with the flag (the build id does
    not change).
- **The runtime kill switch** is the var `OPCACHE_REMOTE=off`. No remote node is made, and the
  scripts compile from source.

## Never a half file; every failure is a compile

| case | what PHP sees | the page |
|---|---|---|
| the pack answers non-200 | `open()` fails with EIO | OPcache compiles from source: correct, more CPU |
| the pack length or SHA-256 differs from the index | the same | the same |
| `REMOTE_FETCH_CAP` reached in this request | the same | the same |
| a read of a file whose pack was evicted | `read()` fails with EIO | the same |
| no `ASSETS` binding | no remote node (`fallback:no-assets-binding`) | the same |

- The contents getter returns the whole verified file or throws; it has no third case.
- A pack that failed is not fetched again in that request; the next request tries again.

## The fetch budget

- **Each pack fetch is one subrequest.** Gate 0 measured that `ASSETS.fetch` counts against the
  subrequest limit.
- **Platform limits** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  "Last updated Nov 13, 2026"):
  - Workers Paid: "Subrequests per invocation: 10,000 (up to 10M)";
  - Workers Paid, Cloudflare services: "Subrequests to internal services: Matches configured
    limit (default 10,000)";
  - Free: 50, and 1,000 to internal services.
- **Measured** (opcache-build run 43603733149, head 6dd6838, local workerd in CI, a store build of
  2,128 files in 21 packs of about 1.1 MiB). After `/_install`, ONE runtime served four pages.
  Each cell is fetches / distinct packs (`rfN` / `rfPacks`). `rfFail` and `rfCapped` were 0
  throughout:

  | held budget | boot (home) | shop | login | REST | 4 pages | peak held |
  |---|---|---|---|---|---|---|
  | 2048 KiB | 36 / 18 | 32 / 6 | 3 / 3 | 15 / 6 | 86 | 1,118 KiB |
  | **4096 KiB (default)** | **20 / 18** | **9 / 6** | **3 / 3** | **7 / 6** | **39** | **3,270 KiB** |
  | 8192 KiB | 18 / 18 | 6 / 6 | 3 / 3 | 6 / 6 | 33 | 7,565 KiB |

  - A cold boot needs 18 of the 21 packs.
  - **Correction (written 2026-11-14, measured 2026-11-14; supersedes the "about 14 per cold boot"
    and "2 MiB, about 2 packs" of #394 issuecomment-6878206213):**
    - packs end just over 1 MiB, so 2 MiB held ONE pack and thrashed;
    - at 4 MiB a cold boot makes about **20** fetches.
  - The first, warm-only path-order shape read 38 fetches over 4 pages for 14 packs (run 43601222273).
- **The cap:** `REMOTE_FETCH_CAP` default **64** per request: 3x the measured 20 per cold boot, and
  0.64 % of the Paid limit. Past it, opens fail clean, long before the platform limit.
  - A Free site, or a site with a lower `[limits] subrequests` or WfP `subRequests`, must set the
    cap below its own limit minus its other subrequests.

## The instrument: `x-perf`

| field | meaning |
|---|---|
| `remote` (booting requests) | `packs <n> files <m> cap <c> holdKiB <h>`, `off`, `fallback:no-assets-binding`, `none` |
| `rfN` | pack fetches in this request (subrequests) |
| `rfKiB`, `rfMs` | their bytes and time |
| `rfFail` | fetches that failed (404, length, SHA-256): clean misses |
| `rfCapped` | opens refused by the cap: clean misses |
| `rfHeldKiB` | the high-water of held packs in this request, after eviction |

`rfHeldKiB` is not resident memory: a dropped pack is garbage until V8 collects it. `/_headroom`
measures that.

## Tests

- **`tests/opcache-remote.test.mjs`** (ci.yml, Node 24, the real loader and PHP).
  - The setup: a file cache of a script returning OLD, with the source changed to NEW. OLD can come
    only from the fetched pack, and NEW is the clean compile.
  - The cases: a good pack; a 404, a short pack, a SHA-256 mismatch and cap 0; a retry on the next
    request; a loader without the pattern edit, which must NOT give OLD; no hook means no wrapped
    open; and two packs under a 1-byte budget, which give OLD1OLD2 with one pack held at a time.
- **`tests/remote-packs.test.mjs`:** the LRU budget, a refetch after eviction, the kept current
  pack, nothing held across requests, the high-water, and a cap that counts refetches.
- **`tests/opcache-remote-pack-test.py`:** the cold-boot pack order, the empty `opcache.zip`, no boot
  pack, the SHA-256 index, stale packs removed, and bad traces refused.
- **`tests/remote-e2e.sh`** (opcache-build.yml, local workerd): e2e.sh and tests/woo.py three ways
  (remote, cap 0, off), `rfHeldKiB` bounded, and `/_pf/` never served.
- **`deploy/wfp/tests/render-test.sh`:** the flag's render rules, including the refusal with the split.

## The proof (to run; nothing is claimed yet)

**Run it only AFTER rollins-sb1114b's `dropRuntime()` fix merges (#394).** Today a dropped runtime
stays pinned at about 165 MiB (the lead, 2026-11-14), and that leak would swamp this A/B.

- **Expected gain:** all of `opcache.zip` leaves the module, about 21 MiB deflated on a store build
  (docs/design-394-bundle-out-of-memory.md 1.2), against today's live shape. ggc, ggc-test and
  pf394a are unsplit (the lead's read of their bindings, 2026-11-14). The isolate charge is not the
  byte count: the #394 floor probes charged 32 MiB for 40.3 MiB of zips. Measure it.

1. The lead deploys two throwaway b-dosql sites on the sample store, the same in everything else:
   (a) plain main and (b) main plus `OPCACHE_REMOTE=1`. Both have `HEADROOM_PROBE=on`.
2. **Headroom:** `/_headroom` (#559) after the same real request on each, 3x alternating.
3. **The 7-screen round** (`tests/load/data/admin-matrix-2026-11-14/tools/admin-round.py`) at +0,
   +20 and +60 min, as in docs/admin-memory-matrix.md, on each site. Read:
   - memory deaths and DO storage resets (GraphQL and Workers Logs);
   - `x-isolate-retry`;
   - `rfN`, `rfFail`, `rfCapped` and `rfHeldKiB` per request;
   - p50 and p95 per screen.
4. **Pass line:**
   - `rfFail` 0 and `rfCapped` 0;
   - fewer memory deaths on (b) than (a);
   - DO storage resets on (b) not worse than (a);
   - (b) p95 within 10 % of (a) on each screen.
5. If `rfN` on cold runtimes is high, regroup the packs by co-access before `site.zip` (#394 Gate 2).

Not wired: approach A (`deploy/deploy.sh`). WfP b-dosql only.
