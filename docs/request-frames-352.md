# The request frame: an isolate reset rolls a request back (#352)

Status: built behind a flag, default OFF (`REQUEST_FRAMES=on`). Written 2026-11-14 by rollins (seat
rollins-sb1114d).
- Design: #352 [issuecomment-6881076430](https://github.com/skyphusion-labs/pagefeather/issues/352#issuecomment-6881076430),
  with the lead's rulings.
- Code: `spikes/b2-wordpress/undo-log.mjs`; tests: `tests/undo-log.test.mjs`, `tests/frame-probe.test.mjs`
  and `tests/frames-e2e.sh`.

## The problem

On b-dosql, when the PHP object's isolate is reset in the middle of a request, the statements before the
reset are durable and the rest are lost (#350; fdprobe1112h: `pf1112_reset_a` kept, `pf1112_reset_b`
lost). The fix-build admin round had 46 of 47 deaths with `x-write-loss` 1 or 3: half-saved requests.

## The frame

- **Lazy (ruling (i)).** Each PHP request in the object is ARMED. The frame OPENS with the request's
  first statement that CHANGES a row, whatever the method. `index.js` `sqlStatement` runs every PHP
  statement through `undoLog.statement()`.
  - `mayWrite` is conservative: everything may write except a plain `SELECT` or `EXPLAIN` and the
    statements that change no covered row: any `PRAGMA` (a setter too), `VACUUM`, `ANALYZE`, `REINDEX`.
    CI at `105776b` showed a `PRAGMA` setter opening the frame of 10 of 10 public GETs.
  - For a statement that may write, the open, the statement and its first undo row run in ONE
    `storage.transactionSync`. If the statement left no undo row and reported no row written (an
    `UPDATE` or `DELETE` that matched nothing, an `INSERT OR IGNORE` that conflicted), the transaction
    is rolled back: the open is never committed (`x-perf` `frame.noop`). What PHP sees is identical to
    frames off (`changes` 0, no new insert id, no error). An undo row decides, not the reported count
    alone, so a counter that under-reports cannot drop a frame that covers a real change.
  - A `PRAGMA` never runs inside that transaction: SQLite ignores `PRAGMA foreign_keys` in one, so a
    setter would silently not take effect (a unit test pins this; it was red before the fix).
  - A request that never changes a row pays nothing. `post-new.php`, which inserts an auto-draft on a
    GET, is covered.
- **The miss guard.** A statement that writes rows (`cursor.rowsWritten`) while armed with no frame open
  is a counted, logged `frame-miss`, never silent.
- **Kept.** When PHP finishes, a fatal included (ruling (ii): autocommit semantics). The frame hides OUR
  platform's failure, an isolate reset, not WordPress's.
- **Rolled back.** Only by `recover()` in the next isolate. `_wp_undo_state.active` is stored, so an
  isolate that died with it set is undone first.
  - That happens in the `PhpRuntime` constructor (`blockConcurrencyWhile`), before any request, alarm,
    `/_dbexport` or snapshot reads the database.
- **PHP's own transactions** inside a frame are savepoints of it. A PHP `ROLLBACK` undoes only its part,
  and the frame stays open with `active` still 1 (a mutant that missed this survived, so it has its
  own test).

## What a rollback cannot undo: commit points

A COMMIT POINT closes the frame KEPT just before an effect an outside party may see. The next write
opens a new frame. **A rollback never erases a row an outside party may already know about.**

| effect | under a frame |
|---|---|
| outbound HTTP that is not GET, HEAD or OPTIONS (a payment, a webhook) | a commit point (`http`) |
| R2 delete, R2 copy (rename, staged upload: may replace bytes) | a commit point (`r2-delete`, `r2-copy`) |
| DDL (CREATE, ALTER, DROP, RENAME, TRUNCATE) | a commit point (`ddl`), MySQL's implicit commit |
| R2 put | NOT a commit point (ruling (iv)): an orphan on a rollback, logged as `frame-r2-put`; the sweep is #573, not built |
| mail | already held to the end of the request (#368): a reset sends nothing |
| object cache, in-isolate | dies with the isolate |
| object cache, KV L2 (`OBJECT_CACHE_L2=on`) | sets are DEFERRED until the frame is kept, so a rolled-back request leaves no KV value built from vanished rows; deletes go at once |

**Row ids** (tested in `tests/undo-log.test.mjs`): WordPress tables use `INTEGER PRIMARY KEY` without
AUTOINCREMENT, so a ROLLED-BACK insert's id IS reused by the next insert.
- **Could anything outside the frame hold that id first?** No, by the commit-point rule.
- Every channel out of the request is one of three kinds:
  - held until the request ends (mail);
  - deferred until the frame is kept (KV L2);
  - a commit point (outbound non-GET HTTP, R2 delete and copy).
- An id taken before a commit point is KEPT and never reused; the test shows the next insert after a
  commit point gets a new id.
- One residual: an outbound GET carries an id in its URL and is not a commit point. A GET must not change
  remote state by HTTP's contract. If a plugin breaks that contract, its effect survives the rollback.

## What the client sees (ruling (iii))

- On a write-loss failure, the front Worker asks the object's NEW isolate `/_frame?id=<request id>`. It
  is one subrequest, on that path only. `/_frame` is refused to clients (404).
- Only `rolled-back` with 0 commit points PROVES nothing was kept. The client then gets a 500 with
  `x-write-loss: rolled-back`, `x-write-undone: <rows>`, and "The request did not complete. Nothing was
  saved. You can try again." JSON for REST and Store API clients.
- Anything else (unknown, open, kept, or rolled back after a commit point) gets today's "some changes may
  have been saved; check before you try again".
- **Double posts:**
  - WordPress nonces are not stored, so a retry is valid and applies once;
  - the block editor does not retry by itself, and autosave is an upsert;
  - a Woo checkout with no payment POST places one order on retry.

## The instrument

`x-perf` `frame`, with frames on: `opened` (a write armed it), `kept`, `points` and `miss`, per request.
`/_frame?id=` answers `{ req, state: open | kept | rolled-back, points, kinds, undone, t }` for the last
32 requests.

## Cost

Measured by `tests/frames-e2e.sh` in opcache-build (local workerd, the priming store), frame on against
off: 10 REST post saves, 10 `post-new.php` GETs and 10 public GETs, `x-perf` `dbMs` and `dbN`, and
`x-db-rows` written. The numbers are in the PR and in #352.

## Not in this

- Cron ticks are not framed: Action Scheduler hands each email off inside its action (#362), so each
  action is a commit point. That is phase 2.
- Approach A (`deploy/deploy.sh`, MySQL) is not covered.
