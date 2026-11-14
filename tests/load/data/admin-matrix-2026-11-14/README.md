# Admin-memory matrix raw data (2026-11-14)

The data behind [docs/admin-memory-matrix.md](../../../../docs/admin-memory-matrix.md). It holds names, numbers and statuses only: no credential, no cookie, no nonce, no site host, no IP address and no row data of any store.

| file | what | made by |
|---|---|---|
| `a-in-do-pfa-do-joan.csv` | A with PHP in a Durable Object, 210 requests (the 7-screen round, 10 rounds at +0, +20 and +60 min) | `tools/admin-round.py`, then `tools/to-csv.py` |
| `hostlesswp-hwp504.csv` | HostlessWP v0.1.1 (`739e8e7`), 210 requests, the same round, with the `x-hostlesswp` fields per request | the same |
| `b-dosql-arena-ab-pf394a.csv` | b-dosql, `LAZY_ARENA` off (abA1, abA2) and on (abB1, abB2), 405 requests, plus the failed first try of A1 (abA1-loginfail) | Rollins's `measure394.py pnrest` (#537, frozen copy sha256 `633dcb16c0f0`), then `tools/ab-to-csv.py` |
| `b-dosql-566fix-pf394a.csv` | b-dosql on the #566 fix (`c5af3c8d8229-wooprimed`), 210 requests, the 7-screen round at +0, +20 and +60 min, the cron held | `tools/admin-round.py`, then `tools/to-csv.py` |
| `b-dosql-566ctl-pf394a.csv` | the same round on the control, the build before #571 (`6ef17dda850b-wooprimed`), 210 requests | the same |
| `graphql/m4-pfa-m3-joan.json` | Cloudflare GraphQL, A with PHP in the Worker, 08:21 to 09:27Z | the lead's read: `workersInvocationsAdaptive`, filter `scriptName` and the window |
| `graphql/do-activation.json` | the A-in-DO WooCommerce activation, 09:37 to 09:39Z | `workersInvocationsAdaptive` and `durableObjectsInvocationsAdaptiveGroups`, the same filter |
| `graphql/do-plus0.json`, `do-plus20.json`, `do-plus60.json` | A with PHP in a DO, per window | the same two datasets |
| `graphql/hwp-plus0.json`, `hwp-plus20.json`, `hwp-plus60.json` | HostlessWP, per window | `workersInvocationsAdaptive` |
| `tools/` | the scripts that made and read these files | see below |

Each GraphQL file is the full API answer, with the query (`_query`, the account id removed), a label and the time it was read (`_read_at`). `cpuTime` in them is in microseconds. `tools/gql-totals.py <dir>` totals each file by dataset and status.

**No CSV for A with PHP in the Worker (#479 M4).** Its per-request files were deleted at that target's teardown. Its numbers in the matrix are the ones summarised at the time (#479 issuecomment-6875203570), plus `graphql/m4-pfa-m3-joan.json`.

## CSV columns

- `a-in-do-pfa-do-joan.csv` and `hostlesswp-hwp504.csv`:
  - `run`, `file` (the window: `*-plus0`, `*-plus20`, `*-plus60`), `t_utc`, `round`, `screen`, `method`, `status` (`SKIP-no-form` is a profile save not sent, because its form GET died);
  - `ms`, `x_isolate_retry`, `x_write_loss`, `x_isolate_reset`, `wasm1_mib` (`x-perf`, b-dosql only), `saved_and_read_back` (profile save: 1 if the marker read back);
  - `hwp_*` (from `x-hostlesswp`: `cold`, `phpMs`, `queries`, `dbMs`, `wasmMB`, `served`, `fetches`), and `err_len` (the body length of a 5xx).
  - the two `b-dosql-566*` CSVs add two last columns: `x_runtime_recycled` (`memory` when this request left the wasm heap over the recycle line, so its runtime was dropped after it; `spikes/b2-wordpress/index.js`) and `boot` (1 when the request booted PHP). The older CSVs end at `err_len`.
- `b-dosql-arena-ab-pf394a.csv`:
  - `arm`, `arena`, `t_utc`, `phase`, `label` (`post-new`, `rest-page`, `login`), `method`, `status`, `ms`, `boot`;
  - `x_isolate_reset`, `x_write_loss`, `wasm0_mib`, `wasm1_mib`, `inflates`, `reinflates`, `rest_readback_state` (`found` or `absent`), `rest_readback_ms`.

## Tools

- `tools/admin-round.py`: the 7-screen round. Environment:
  - `B` (the site), `ADMIN_USER`, `ADMIN_PASSWORD`;
  - `ROUNDS` (10), `ALL_ON=1` (every round with nothing switched off);
  - `SPIKE_TOKEN` only for our own sites, which turns on `x-perf`;
  - optional `SCREENS` (a comma list) and `SWITCH` (an `x-mem-off` value for alternate rounds, with `ALL_ON` unset).
  It needs `tests/plugins/gate2.py` for the login and REST helpers. It writes one JSON line per request.
- `tools/to-csv.py <out.csv> <label> <round.jsonl>...` and `tools/ab-to-csv.py <out.csv> <arm.jsonl>...`: the CSVs above.
- `tools/pooled.py <round.csv>...`: p50 and p95 per screen (nearest-rank, answered requests only).
- `tools/gql-totals.py <dir>`: totals of the GraphQL files.
