# site.zip as remote packs: PHP pauses in open() (#569, #394 Gate 2)

Status: built behind a flag, default OFF. Written 2026-11-14 by rollins (seat rollins-sb1114d).
- Design: #394 [issuecomment-6879005325](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6879005325),
  approved with one retry added.
- Measured before the build: [issuecomment-6879197224](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6879197224).
- It builds on `docs/opcache-remote-563.md`: the same `prepare.sh` PY5 hook, `remote-packs.mjs`,
  SHA-256 per pack, and `x-perf` counters.

## What it does

With `SITE_REMOTE=1`, which needs `OPCACHE_REMOTE=1` (the render refuses it alone), `site.zip`
leaves the bundle too.

- **The build.** `site-remote.py`, run after `opcache-remote.py` on the same trace, writes into
  `build/public/_pf/<build-id>/`:
  - **`site-hot.zip`:** the files read by at least half of the traced warm requests. Measured: 46
    files, 34.8 KiB deflated;
  - **`st-<n>.zip`:** every other file, in packs of about `SITE_PACK_KIB` (512) in cold-boot read
    order;
  - **`build/site.zip`** is left EMPTY;
  - **`build/site-remote-index.js`** gets a pack and size per file (pack -1 is hot), every directory
    (the empty ones too), and the length and SHA-256 of each pack.
- **The boot.** `boot()` mounts every directory and one node per file. `stat()` needs no bytes.
- **The hot pack** is fetched once per runtime and held for the runtime's life: a fixed cost of
  about 35 KiB of pack bytes per runtime (measured). The other packs are held under `SITE_HOLD_KIB`
  (2048) with LRU, and dropped at the end of each request.
- **There is NO runtime off switch** (the lead accepted it: the bytes are not in the bundle). The
  rollback path is explicit:
  - **`site update` without `SITE_REMOTE`** (with `DROP_SETTINGS=SITE_REMOTE`, because the setting is
    recorded, #558) rebuilds with `site.zip` back in the bundle;
  - a bad remote build that went live is covered by **#466's rollback artifact**. `site update` stores
    each deployed build and re-deploys the live one when an update fails.
- **A remote build with no `ASSETS` binding is refused at DEPLOY time.** `remote_assets_check`
  (`deploy/wfp/remote_assets_check.py`) runs before every user-script upload: `site add`, `site
  update` and the rollback re-deploy.
  - It refuses a build whose site or OPcache index is non-null when the config lacks `binding =
    "ASSETS"` or `run_worker_first` with `/_pf/*`. Without the binding a site build has no files;
    without `/_pf/` first the packs (PHP source and compiled PHP) would be public, #412.
  - It also refuses a build and config that disagree on `SITE_REMOTE`.
  - Tested: `deploy/wfp/tests/remote-assets-test.sh`.
  - Boot still fails loudly too (`siteRemote` `fail:no-assets-binding`).

## Never a half file

- **A pack is used only if** its length and SHA-256 match.
- **A remote site file is PINNED from its fetch to its close** (`attachLazyContents` `tag.pin`:
  `'open'` for a non-`.php`, which is pinned by the open; `'read'` for a `.php`, pinned by the read
  hook through `node.pagefeatherPin`). The pin inflates it at once, while its pack is held. No evict
  drops a pinned file's bytes, and a pinned file never lives in the inflate arena.
  - So after a successful `open()` every read succeeds; the only failure point is `open()`.
  - Measured without the pin: `stream_get_contents(): Read of 8192 bytes failed with errno=29 I/O
    error`, and a short file. With the pin, every byte, the arena on too (`tests/site-remote.test.mjs`).
- **A revisit of an evicted, closed file** goes back through `open()`: it is a refetch, never a
  failure. It costs 1 subrequest and about 512 KiB. `rsN - rsPacks` counts these refetches.

## Failure is an honest 500, so: one retry, and the hard cap

- **A site file that cannot be fetched fails with EIO.** A non-`.php` fails its `open()`, so
  `file_get_contents` returns false. A `.php` fails its first read, with no byte delivered: `include`
  returns false, and `require` is a fatal error and a 500.
- **One retry:** a failed site-pack fetch (non-200, length, SHA-256) is tried again ONCE in the same
  request, after `SITE_RETRY_MS` (50). Then it fails. The retry is counted (`rsRetry`), and it takes
  budget like any fetch.
- **The budget is shared, per request:**
  - OPcache opens stop at the SOFT cap, `REMOTE_FETCH_CAP` (64): past it they compile, which is free;
  - site opens go on to the HARD cap, `SITE_FETCH_CAP` (96): 0.96 % of the Workers Paid 10,000.
- **Measured** (simulated, then scaled for the measured undercount): a cold admin request is about 44
  fetches in all, OPcache about 42 and site 2. **This was measured on the PRIMING store** (e2e.sh
  and tests/woo.py data) in CI, not the 2,609-product sample store; the proof re-measures it there.

## The hybrid: a .php at its first READ, every other file at its OPEN

- **The first build** fetched every site file at OPEN. On workerd (opcache-build run 43608158287) a
  cold boot made 88 site fetches over 14 packs, and tests/woo.py's checkout passed the hard cap of
  96, a 500.
- **The cause** (step 3, re-measured with opens and reads apart, #394 issuecomment-6879862441):
  OPcache opens a `.php` source it then serves from its cache without reading it.
  - Over 55 traced requests there were 42,056 opens, 4,335 reads and 37,721 opened-never-read files.
  - **All 37,721 were `.php`; 0 were other files.**
- **The rule**, proven on production workerd in Gate 0b (#394 issuecomment-6879785529, 9 of 9 cases x3):
  - **a `.php` is fetched at its FIRST READ** (`prepare.sh` PY6: `js_fd_read`, already Suspending
    in the stock pattern, plus `fd_read` and `_mmap_js`; this wasm has no `fd_pread`), and pinned
    from that read to its close;
  - **every other site file is fetched at its OPEN** (PY5), and pinned from the open.
- **Why not a read for everything:** a failed READ makes `@file_get_contents` return `""` (Gate 0b), not
  `false`. A failed OPEN keeps `false`. Non-`.php` files that are opened are always read (step 3), so
  fetching them at open costs nothing.
- **Measured fetch cost** (simulated): 2 site fetches per cold admin request, 0 or 1 warm. Hot set:
  46 files, 30.1 KiB.
- **Open with no read costs 0 fetches**, and the OPcache source-resolve path fetches the source 0 times
  (Gate 0b: 1 with the open hook).

## `file_exists` storms only stat

- `file_exists`, `is_file`, `is_dir` and `filesize` reach the stat syscalls (`FS.stat` / `FS.lstat`).
  MEMFS `getattr` reads `node.usedBytes`, which our nodes answer from the index.
- `is_readable` reaches `faccessat`, a lookup only.
- The hook is only in `__syscall_openat`. Opening a directory, or a file the index does not hold, is
  no fetch.
- Tested: 40,000 stat-family calls plus `scandir` make 0 fetches.

## Guards

- **The boot self-check.** Gate 0b's red control read files as EMPTY, with no error. So a SITE_REMOTE
  boot reads one known remote `.php` through PHP: `site-remote.py` records `selfcheck` as [the
  smallest hot `.php`, its size, its SHA-256]. Anything else fails the boot, loudly (`siteRemote`
  `fail:selfcheck`).
- **The export guard** (`tests/phpwasm-exports.test.mjs`). A read inside an export outside the
  loader's `exportPattern` throws `SuspendError` (Gate 0b). php-wasm calls 3 promising exports and
  12 setters today; a bump that calls any other export goes red.
- **Our own reads** (`tests/our-file-reads.test.mjs`). Every direct file read in our mu-plugins and in
  index.js is listed with why it never reads a remote site `.php`, where `""` would mean a failed read.
  A new one goes red until it is reviewed. A JS-side read of an unfetched remote file throws.

## The instrument: `x-perf`

| field | meaning |
|---|---|
| `siteRemote` (booting requests) | `packs <n> hotKiB <h> files <m> cap <c> holdKiB <k>`, or `fail:no-assets-binding` |
| `rsN` | site pack fetches in this request (subrequests; a retry counts) |
| `rsKiB`, `rsMs` | their bytes and time |
| `rsFail` | site fetches that failed after the retry |
| `rsRetry` | retries made |
| `rsCapped` | site opens refused by the hard cap |
| `rsPacks` | distinct site packs fetched: `rsN - rsPacks` is the refetch count |
| `rsHeldKiB` | the high-water of held site packs, the hot pack not included |

`rf*` keeps its #565 meaning: OPcache only.

## Tests

- **`tests/site-remote.test.mjs`** (Node 24, the real loader with PY5 and PY6, PHP, `attachLazyContents`
  and `createSiteHooks`):
  - the hybrid;
  - open with no read is 0 fetches;
  - the OPcache source-resolve path is 0 fetches;
  - one retry for each kind;
  - a failed `.php` (include false, require fatal) and a failed data file (false, never `""`);
  - the pin for both kinds, with the arena on too;
  - the no-pin control, built by REMOVING the pin count from the real code;
  - the read control;
  - a JS-side read throws;
  - the boot self-check both ways.
- **`tests/remote-packs.test.mjs`:** the shared soft/hard budget, the retry, a retry that needs
  budget, the hot pack outside the LRU, and the `rs` prefix.
- **`tests/site-remote-pack-test.py`:** the hot pack, cold-boot order, an empty `site.zip`, the
  directories, the OPcache packs left untouched, and refusals.
- **`tests/remote-e2e.sh` with `REMOTE_E2E_SITE=1`** (opcache-build): pages, admin, editor and the
  store, served only from packs, three ways.
- **`deploy/wfp/tests/render-test.sh`:** `SITE_REMOTE` and its rule.

## The proof (to run; nothing is claimed yet)

Run it only AFTER rollins-sb1114b's `dropRuntime()` fix merges.

1. On the sample store: (a) main plus `OPCACHE_REMOTE=1`, and (b) that plus `SITE_REMOTE=1`. Both
   have `HEADROOM_PROBE=on`.
   - Read the WARM `rsN` per screen. Only the hot pack (about 35 KiB) is held across requests (the
     lead's decision). If warm site fetches prove costly, holding the first 512 KiB pack across
     requests too is a follow-up decision, made with these numbers.
2. Run `/_headroom` 3x alternating, then the 7-screen round at +0, +20 and +60 min.
3. **Pass line:**
   - **0 failed responses over the full round** (no 5xx from a site fetch);
   - `rsFail` 0, `rsCapped` 0 and `rfCapped` 0;
   - a clean read of `rsRetry` (every retry named, with its cause, from the `remote` log lines);
   - fewer memory deaths on (b);
   - DO storage resets not worse;
   - p95 within 10 %.

Not wired: approach A (`deploy/deploy.sh`).
