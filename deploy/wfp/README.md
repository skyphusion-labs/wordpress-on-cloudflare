# deploy/wfp: WordPress sites on Workers for Platforms

A reference deployment for one operator with a couple of sites on their own Workers for Platforms account (issue #35). Each site is a `b-dosql` WordPress (PHP and its SQLite database in one Durable Object) as a user Worker in a dispatch namespace. Every resource comes from this directory. Terraform makes the data plane. The Workers are uploaded from the Wrangler configs that `lib.sh` renders from the templates here.

The design is on issue #35 (the slice 1 comment): one origin per site, never a path prefix. The capability findings are in `docs/wfp.md`.

New to this? The day-one walkthrough for an operator is [docs/operator.md](../../docs/operator.md).

## What it makes

| | Per site `<name>` | Shared |
| --- | --- | --- |
| Workers | the user Worker `site-<name>` in the namespace; its dispatcher `wp-<name>` on `workers.dev` (phase A), or the one dispatcher `wp-dispatch` with a Custom Domain per site (phase B, #138) | the outbound Worker `wp-wfp-outbound` |
| Data | its Durable Object and SQLite (made with the script); the media bucket `wp-wfp-<name>-media` | the site map, KV `wp-wfp-sites` |
| Secrets | `WP_SALT`, `SPIKE_TOKEN` (script secrets), `ADMIN_PASSWORD` (Terraform output) | the operator's API token |
| Limits | `cpuMs` and `subRequests` in its site map entry | |
| Address | `https://wp-<name>.<subdomain>.workers.dev` (phase A), or `https://<name>.wfp-test.skyphusion.org` (phase B) | the dispatch namespace `wp-wfp` |

Every dispatcher copy is the same script and the same config, and only the name differs (`tests/render-test.sh`; `check.py` compares the deployed script hashes). A copy maps the request's own hostname through the site map:

- a host with no entry gets `404` with `x-wfp-error: no-site`;
- an entry whose script is not deployed gets `404` with `x-wfp-error: not-deployed`.

## Day one

```sh
export CLOUDFLARE_API_TOKEN=...   # the deploy token: see "The deploy token" below. No API Tokens permission (#273)
export ACCOUNT_ID=...             # your Cloudflare account id. No default: every tool stops with exit 2 without it
# The Skyphusion reference deploy sets ACCOUNT_ID (and WFP_ZONE_ID, WFP_SUBDOMAIN) with:  . deploy/wfp/reference.env
./deploy/wfp/up.sh                # SITES="one two" by default
./deploy/wfp/down.sh              # removes all of it; every step is checked against the API
```

`up.sh` (day one; afterwards `site add` and `site remove` change one site at a time):
1. builds `b-dosql` once (`spikes/b2-wordpress`);
2. applies `terraform/shared` (the namespace and the site map);
3. deploys the outbound Worker;
4. runs `site.sh up <name>` for each site;
5. makes the stale-entry probe `wp-probe`;
6. runs `check.py`, which writes `results/day1-<time>.json`.

`site.sh up <name>` keeps the order that the site map's caching needs (KV can take 60 s or more, and it caches "absent"):
1. the site's Terraform workspace (its bucket, its secrets, its map entry);
2. the user Worker;
3. the dispatcher, which is its hostname;
4. a wait, then the install.

Before the install, `site.sh up` waits for the site to answer from its own user Worker. A platform 404, or the dispatcher's `no-site` or `not-deployed`, means "not yet": on 2026-11-06 a new namespace script was "not deployed" for a moment after its upload. Before the workspace, `site.sh up` waits until the site map accepts a test write. A new KV namespace can refuse writes for a while: on 2026-11-06 it answered 404 code 10013 right after it was made.

`site.sh down` goes the other way: the hostname, the user Worker, then the bucket and the workspace.
- The user Worker counts as gone when the namespace list no longer has it. A deleted script's single GET can still answer 200, with an empty record.
- The bucket is emptied with a short-lived key that can reach only that bucket. The key is made with `-target` and depends on nothing, so a down never creates anything.

Options:
- `SITES`;
- `BUILD=0` (use the build that is there);
- `WFP_STATE=r2` (Terraform state in the R2 state bucket `wp-on-cf-tfstate`, with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`);
- `CHECK=0`;
- `SITE_WAIT` (seconds to wait for a new site, default 300).


## The deploy token

`CLOUDFLARE_API_TOKEN` is one account token. It needs no API Tokens permission (#273), so it can be made through the API.

**Measured 2026-11-14** (the #512 live proof on the throwaway pf512, main `48bdc2a`, wrangler 4.107.0, run by the lead): `site add` (146 s) and `site remove` (29 s) ran to the end with a token that had exactly these groups and no API Tokens permission: Account Settings Read, Vectorize Write, Workers AI Read, Workers KV Storage Write, Workers R2 Storage Write, Workers Scripts Write. So that set is enough for the site commands. It does not show that each group is needed; only Vectorize is measured as needed (below).

**For the site commands** (`site add`, `update`, `remove`, `import`, `restore`, `list`), on the account:

| Permission | Why (the code that needs it) | Status |
| --- | --- | --- |
| Workers Scripts Write | the user Worker in the dispatch namespace and the dispatcher (`wrangler deploy`, `/workers/dispatch/namespaces`, `/workers/scripts`), `/workers/subdomain`, and the script settings for the log redaction (`obs_settings.py`) | in the measured set |
| Workers KV Storage Write | the site map entry (`terraform/site`, `cloudflare_workers_kv`; `lib.sh entry_build` reads it) | in the measured set |
| Workers R2 Storage Write | the media bucket (`cloudflare_r2_bucket`), the snapshots, the recorded inputs and the rollback artifacts (S3 keys derived from this token, `snapshot.py`), and the parent of the temporary bucket credentials (`r2_temp.py`) | in the measured set |
| Vectorize (Read at least) | every `site add` and `site remove` reads the site's search index for its footprint (`lib.sh site_footprint`) | measured as NEEDED: with a key that had no Vectorize permission, the add stopped at once with `search unknown` (exit 2). Vectorize Write, in the measured set, includes Read |
| Vectorize Write | with `WP_VECTORIZE_SEARCH=1`, the per-site index is made and deleted (`ensure_search_index`, `remove_search_index`) | in the measured set; the search path itself was not run (search off) |
| Workers AI Read | with `WP_VECTORIZE_SEARCH=1`, the site's `AI` binding for the embeddings | in the measured set; not exercised (search off) |
| Account Settings Read | no call in deploy/wfp was traced to it (`tokens/verify` needs no permission) | in the measured set; not shown to be needed |

With `WFP_CUSTOM_DOMAIN=1` (phase B, CR gated), the site's Custom Domain also needs, on that zone: Workers Routes Edit and DNS Edit. Not measured.

**For `up.sh` and `down.sh` (the shared pieces, `terraform/shared`)**, in addition to the dispatch namespace and the site map namespace (Workers Scripts and Workers KV Storage, above), on the SaaS zone (`saas_zone_id`): Zone WAF Edit (the managed, custom and rate-limit rulesets, `waf.tf`), Workers Routes Edit and DNS Edit (`saas-home.tf`); with `access_enabled`, Access: Apps and Policies Edit (`access.tf`). These are named from the Terraform resources and are not measured with a scoped token.

## The bucket keys (#273)

Two steps need a key that reaches only one site's media bucket: `site down` and `site remove` empty the bucket before it is deleted, and `site import` with `CONTENT` puts the uploads in it. They use an R2 **temporary credential**, minted from the deploy token itself by `deploy/wfp/r2_temp.py` (`POST /accounts/{id}/r2/temp-access-credentials`, permission `object-read-write`). The R2 docs say such a credential "is bound to exactly one bucket" and "cannot exceed the permissions of its parent token".

- **The deploy token needs no API Tokens permission.** Before #273 the keys were Cloudflare account tokens, and Cloudflare refuses API Tokens edit on a token that was minted through the API (error 1001). So a deploy token made through the API could not run these steps. Measured 2026-11-14 with a token that has R2 Storage Write and no API Tokens permission: the mint succeeded; the credential could PUT, list, GET and DELETE in its bucket; another bucket answered 403 to a list and a PUT.
- **Nothing is made in the account or in the Terraform state.** The credential is written to a mode-600 temp file for the one step, and the file is removed after it, also on a failure.
- **It expires on its own: 3600 s for an empty, 21600 s for an import** (`R2_TEMP_TTL` sets it). It cannot be revoked alone, only by revoking the deploy token, so the TTL is also how long it keeps working after the step. Each mint logs the expiry: `expires <time> UTC or later` (the time before the request plus the TTL; the API answers no expiry).
- **A refusal mints a fresh one.** When R2 answers 401 or 403 in the middle of a run, `r2-empty.sh` and `media.sh` mint a new credential once (one at a time, under a lock) and go on, inside their usual retry window. Any other answer stops the run. Both scripts are resumable, so run the command again. The code R2 gives for an EXPIRED temporary credential was not measured.
- The session token goes to curl in its config on a pipe, as the key does, never in the arguments.

## Adding and removing a site

```sh
./deploy/wfp/site add three       # one command; refuses if any part of "three" exists already
./deploy/wfp/site remove two      # one command; refuses an unknown site; checks every part gone
./deploy/wfp/site list            # the sites (the Terraform workspaces)
```

`site add` touches only its own site's names, and it refuses before any change when the site exists in part or in full: its workspace, dispatcher, user Worker, map entry or bucket. Then it runs `site.sh up` and checks every part present.

`site remove` runs `site.sh down`, then checks that every part is gone and that the workspace is deleted.

`down.sh` removes every site that `site list` shows.

**Isolation proof (live):** `isolation.sh`, after `up.sh` with the sites `one` and `two`:
1. it seeds a known object in both buckets, then snapshots both sites (`snapshot.py`);
2. it runs `site add three` and snapshots `one` and `two` again;
3. it runs `site remove two` and snapshots `one` and `three` before and after.

Each untouched site must be unchanged: its dispatcher's etag and `modified_on`, its user Worker's hash and `modified_on`, its map entry, its bucket's keys and ETags, and its page title. A part that cannot be read fails the proof; it never counts as unchanged. The script etags are the same across sites (one dispatcher script; one `b-dosql` bundle), so `modified_on` is what tells one site's upload from another's. A re-upload of identical code keeps the etag and changes only `modified_on`, and both are compared. The snapshots read the buckets with S3 credentials derived from the API token, so they create nothing.

## Importing an existing site

```sh
SQLITE=store.sqlite CONTENT=wp-content.tar.gz ./deploy/wfp/site import <name>   # a source that is already driver-made SQLite
DUMP=site.sql CONTENT=wp-content.tar.gz ./deploy/wfp/site import <name>         # a MySQL dump (--hex-blob)
```

`site import` runs `deploy/import.sh` against one site that `site add` made. **It replaces the site's whole database.** Everything the import needs comes from the site's own workspace: its origin (`site_host`), its `SPIKE_TOKEN` and its media bucket. Nothing is read from `deploy/terraform`. With `CONTENT`, the uploads go into `wp-wfp-<name>-media` with a temporary R2 credential that can read and write objects in that bucket only (see "The bucket keys" below). `DRY_RUN=1` and `SKIP_MEDIA=1` make no credential.

The theme and the active plugins must be in the build (the import checks the local `spikes/b2-wordpress/build`), so build with the `IMPORT_*` line the import prints before `site add`, or `site update` afterwards. The import's rules, refusals and steps are in [`deploy/import/README.md`](../import/README.md).

Tests (offline): `site-cmd-test.sh` refuses `site import` with no source, for a site that does not exist and for a bad name, with no write to the account. `tf-test.sh` checks the key's graph. The caller-key path of `import.sh` (MEDIA_BUCKET, R2_ENDPOINT, R2_KEY_ID and R2_SECRET) has no offline test; it runs end to end only against a live site.

## Updating a site

```sh
./deploy/wfp/site update <name>     # one site, with a way back
./deploy/wfp/site update --all      # every site, one at a time, stopping at the first failure
./deploy/wfp/site restore <name>    # after a failed data restore (exit 3): restore the snapshot, clear the hold (#515)
./deploy/wfp/site schedule <name>   # the daily snapshot cron of an existing site (#533, "The scheduled snapshot")
```

Workers for Platforms has no gradual deployments for user Workers, and `b-dosql` keeps its data in the Durable Object and its code in the Worker bundle. So an update re-uploads the SAME script (`site-<name>`): the object and its data persist, the code swaps. `site update`:

1. reads the live build id and the config hash from the site map entry (the build id is the rollback target);
2. reads the site's recorded build inputs (#379, below) and refuses a build the live site cannot run (#377, below);
3. unless `NO_SNAPSHOT=1`, snapshots the object's SQLite to R2 under `_snapshots/` and reads it back to confirm it stored (a prefix the Worker never serves); it aborts if the snapshot cannot be verified, so a rollback always has a way back;
4. rebuilds from the current tree. It uploads the script when the build id differs, when the config hash differs, when the entry has no config hash, or when `FORCE_UPLOAD=1`. It then records the new build id and the config hash in the entry. When the build id and the config hash are both the same, it says `nothing to do` and it does not upload;
5. waits until `/_build` shows the new build (measured 2026-11-06: a re-upload flips it in about 1 s, with the object idle), then checks the site answers 200.

If the verify fails, it rolls back: it restores the data from the snapshot and re-deploys the code that was live. **A rollback drops any write made between the snapshot and the rollback**, and the command and this doc both say so.

**When the data restore fails (#515).** The restore sends the snapshot to `/_dbimport` in parts: `replace=1` for part 0, which drops every table, and `append=1` for the rest. If a part fails, the database holds only the parts before it. Measured on pf394a, 2026-11-14: a 502 on part 6 of 17 left a site with no admin user, posts or pages. So `snapshot.py dbrestore` now:

- tries a part again on a transient answer (429, 502, 503, 504, or no answer), after 2, 5 and 10 s (`DBIMPORT_RETRY_DELAYS`). Before it sends a part again (not part 0), it reads `/_dbcounts`. Each part is one transaction, so the part's tables hold either the counts expected before it or after it. After it means the failed try was applied, and the part is NOT sent again (a table with no primary key would get its rows twice). Before it means it is sent again; a table whose first rows are in that part counts 0 before it (the live pf512 run, 2026-11-14, found this case, see `docs/results.md`). Anything else, or no `/_dbcounts`, ends the pass, and the log names each of the part's tables with its live, before and after counts;
- starts the WHOLE restore again from part 0 when a pass fails on a transient answer, up to 3 passes (`DBRESTORE_ATTEMPTS`), 10 s apart (`DBRESTORE_RESTART_S`). A part the site refuses (a 400) stops at once: a new pass would get the same answer.

If the restore still fails, `site update`:
- exits **3**, not 1, so it cannot be read as an ordinary failed update (exit codes: 0 updated or nothing to do, 1 failed and rolled back, 2 refused, 3 DATA RESTORE FAILED);
- marks the site map entry, `data_hold = <snapshot key>`, and reads the mark back;
- prints the recovery: `deploy/wfp/site restore <name>`, and the same restore by hand (`snapshot.py dbrestore` with the token read from the workspace, so no secret is printed).

While the mark is set, `site update` REFUSES (exit 2) before it changes anything, so a partial database is never snapshotted as the new truth. `site_vars` passes the recorded mark to every apply, so no other command clears it by leaving it out. `site restore <name> [snapshot key]` runs the restore from the site's workspace, prints the row count, then clears the mark and reads that back. `update --all` returns the failed site's own exit code.

The rollback code comes from the site's own rollback artifact (#466). After a good `site update` or `site add`, the command stores what it deployed in the site's media bucket as `_build/artifact/<build id>.tar.gz`: from `build/`, only `build-id.js`, the files the Worker sources import (`site.zip`, `opcache.zip`, `opcache-boot-index.js`) and the static assets `build/public/`; also `vendor/` and the Worker sources at the app root (#507). The rest of `build/` (the unpacked WordPress tree, `build/cache`, the logs) is never uploaded, so it is not kept: on one plain build (OPcache not primed, so `opcache.zip` empty) the artifact is 39111424 bytes, against 115805080 bytes for all of `build/` (2026-11-14). It keeps the artifact of the new build and of the build before it, and deletes the others. Before the rebuild, an update fetches the artifact of the live build. If there is none, it uses `build/`, but only when `build/` holds this site's live build (#464: `build/` is the build this clone made last, which can be another site's). The command refuses an artifact that does not hold the build it is named for, and it checks again that the build is this site's live build right before the re-deploy. It never stores or uses an artifact of a `-dirty` build id. The re-deploy runs from the saved tree, placed in a private copy of the repo layout (`spikes/b2-wordpress`, `deploy/wr` and `deploy/tools`), with the new config and a copy of this tree's `node_modules` (pinned by the lock file). wrangler writes module paths relative to the directory it runs in, so from that layout the bundle and its modules are byte-equal to the original deploy's (`tests/rollback-slim-test.sh`). The config and `node_modules` are the current ones, not the old ones.

If there is no artifact and `build/` is not the live build (for example a site from before #466 whose clone last built another site), the data is still restored and the command says to deploy the old build by hand. A failed artifact write does not fail the update; the command prints a warning, and the next update has no code rollback.

The only interruption is the cold boot of the next request after the new code loads (about 1 s); the hostname always resolves. `/_evict` (an object reset via `ctx.abort()`) is a best-effort fast-path for a busy object that has not flipped; whether `abort()` resets the object on our compatibility date is unproven (the happy path flipped before it was needed).

### When an update uploads (#421)

`site update` records a config hash in the site map entry, next to the build id. The hash is the sha256 of the rendered user config (`render_user` in `lib.sh`) and of the sorted key names in the secrets JSON. A secret value is not part of the hash. The command does not print a secret value.

The command uploads for any of these reasons, and it prints the reason:

- the build id differs (`build changed`);
- the config hash differs (`config changed`);
- the entry has no config hash (`no recorded config hash`). A site recorded before this change has no hash. The next update uploads once and records the hash;
- `FORCE_UPLOAD=1` (`forced`). This is the explicit override.

When the build id and the config hash are the same, and `FORCE_UPLOAD` is not `1`, the command prints `nothing to do` and it does not upload.

A change only to the rendered config uploads on its own. Do not pass `FORCE_UPLOAD=1` for that change. This includes `PHP_INI`, `PHP_RECYCLE`, `HEADROOM_PROBE`, `OPCACHE_SPLIT`, `OPCACHE_REMOTE` (#563, never with `OPCACHE_SPLIT=1`; see `docs/opcache-remote-563.md`), `SITE_REMOTE` (#569, needs `OPCACHE_REMOTE=1`; see `docs/site-remote-569.md`), `TURNSTILE_*`, `OBSERVABILITY` and the mail variables. These values are still read from the environment of the run only. They are not recorded build inputs. An update that does not pass one of them renders the site without it, so the hash changes and the update uploads. Pass the value on every update of that site.

A change to a secret value, with the same key names, does not change the hash, so it does not upload. A new secret key does. To push a rotated secret value, run the update with `FORCE_UPLOAD=1`. `site.sh up` records the hash after it uploads the user Worker, so a site added after this change has a hash. Test: `tests/config-hash-test.sh`.

### The settings of a site (#558)

The per-site settings are read from the run's environment only: `PHP_INI`, `LAZY_CACHE_MB`, `LAZY_ARENA`, `LAZY_ARENA_MB`, `PHP_RECYCLE`, `CRON_INTERVAL_MS`, the Turnstile site key and switches, `MAIL_FROM`, `MAIL_FROM_NAME`, `PHP_LOCATION`, `WP_VECTORIZE_SEARCH` and `OPCACHE_SPLIT`. An update that did not export one dropped it. On 2026-11-14 ggc-test lost its `PHP_INI` opcache pin that way, and the update said only "config changed". Now:
- **Recorded.** A good `site add` and `site update` write the run's settings to the site's own bucket, `_build/settings.json` (private, like `_build/inputs.json`). A secret's value is never recorded, only that the site has `TURNSTILE_SECRET`.
- **Kept.** An update uses the recorded value of a setting the run does not set. A run that sets one replaces it, and the log says so.
- **Dropped only on purpose.** `DROP_SETTINGS=<names>` (spaces or commas) drops them. An unknown name is refused. An update without a recorded secret is refused, unless `DROP_SETTINGS` names it.
- **Checked against the live site.** Before any upload, the user Worker's LIVE bindings are read. An upload that would drop a setting or a secret the live script has is refused (exit 2, nothing uploaded), unless `DROP_SETTINGS` names it. This guards a site recorded before #558, and any miss of the record. A read that fails is a refusal too.
- **Not recorded:** `OBSERVABILITY`. Its logs record client IPs, so they stay on only when a run asks again.
- **Measurement flags are never recorded, by design:** `HEADROOM_PROBE` (`/_headroom` KILLS the isolate), `MEM_LEDGER` (it logs the memory ledger on every request) and `WFP_PHP_ENV` (a measurement build's allocator). Each is ON only for the run that exports it. The next update without it turns it OFF and logs one line ("... was on and is now OFF: measurement flags are never kept"). It is never refused: for these, going off by itself is the safe direction.
- **The store-move hold** `CRON_INTERVAL_MS` (#479) is kept like the rest. Clear it with `DROP_SETTINGS=CRON_INTERVAL_MS`.

### The build inputs of a site (#377, #379)

**WooCommerce is bundled only when the site runs it (#451).** `build_dosql` passes `WOO` with the same derived value as `WOO_ACTIVE`: 1 when `WOO_ACTIVE=1` or `woocommerce` is in `PLUGINS` or `IMPORT_PLUGINS`, else 0. A plain site's `site.zip` then has no `wp-content/plugins/woocommerce/` (measured 2026-11-13: 6.42 MiB, against 19.32 MiB with it). Both values come from the recorded inputs, so `-wooprimed` in the build id says whether WooCommerce is bundled. An outside `WOO` is ignored. Approach `a` builds through `deploy/deploy.sh`, which keeps WooCommerce bundled. Test: `tests/woo-active-test.sh`.

A site's code is built from inputs: `PLUGINS`, `THEMES`, `IMPORT_CONTENT` with `IMPORT_THEMES`, `IMPORT_PLUGINS` and `IMPORT_MU_PLUGINS`, `WOO_ACTIVE`, and the pin lists `SUITE` and `THEME_SUITE`. On 2026-11-12, an update that did not pass them shipped the live store ggc.sh without its plugins and mu-plugins for about 11 minutes. So:

- **Recorded.** After a good `site update` (and a `site add` with `BUILD=1`), the run's inputs are written to the site's own media bucket, `_build/inputs.json`. The content subset the build copies (the named themes, plugins and mu-plugins) is written as `_build/<content id>.tar.gz`. Both live outside `uploads/`, the only prefix the Worker serves, so they are private like `_snapshots/`. `site remove` empties the bucket, so they go with the site. The record holds values only, never a path on the operator's machine and never a secret.
- **Reused.** A `site update` that passes no input builds with the recorded ones and the stored tree. A run that passes different inputs is refused, and the differences are printed; `REPLACE_INPUTS=1` replaces them on purpose.
- **Refused.** Before any change, `site update` also refuses: a live site whose Store API answers 200 with a build that would not prime WooCommerce; a live content build (`-c<8 hex>` in its id) with a run that has no content input (`ALLOW_PLAIN_BUILD=1` overrides); and a dirty tree (`ALLOW_DIRTY=1` overrides), because a `-dirty` build cannot be rebuilt or read back.
- **Why it matters beyond code:** when WordPress loads an admin page while active plugins are missing from disk, it deactivates them in the database. A build without the site's plugins becomes a data change on the first admin page view, and restoring the code does not undo it.

**wordpress.org plugins and themes by slug (#457).** `PLUGINS="slug ..."` and `THEMES="slug ..."` put pinned wordpress.org plugins and themes in the build. Each slug must be in its pin list (`slug version sha256`): `tests/plugins/suite.txt` for plugins (`SUITE=<list>` for another), `tests/plugins/themes.txt` for themes (`THEME_SUITE=<list>`). `tests/plugins/fetch.sh` checks the SHA-256 of each zip and stops the build on a slug that is not pinned, a mismatch, a symbolic link, or a child theme whose parent is not in the build. The build does not activate a theme; activate it in Appearance > Themes. The bundle gate measures the result. Test: `tests/plugins/fetch-test.sh`.

The build id carries what was built: the sha, `-dirty`, `-c<8 hex>` (the content inputs) and `-wooprimed` (`WOO_ACTIVE=1`), so a different build of one sha is never skipped as "already at build" (`spikes/b2-wordpress/build-id.sh`). Tests: `tests/build-inputs-test.sh`, `tests/update-inputs-test.sh`, `spikes/b2-wordpress/tests/build-id-test.sh`.

`update --all` runs the sites in `site list` order, one at a time, and stops at the first failure: the failed site is rolled back and the sites after it are left on their old version, so a bad version never rolls across the estate.

### PHP settings for one site: PHP_INI (#394)

`PHP_INI` sets php.ini values for one site. It is a JSON object of name to value:

```sh
PHP_INI='{"opcache.memory_consumption":"48"}' deploy/wfp/site update <name>
```

- `render_user` (`lib.sh`) writes it to the site's `[vars]` as compact JSON with sorted keys. At each boot, `index.js` passes it to PHP after its own defaults, so it wins.
- It is read from the environment of the run ONLY, like `TURNSTILE_*`. It is NOT a recorded build input. An update that does not pass it renders the site without it, and the config hash changes, so the update uploads. Pass it on every update of that site. Do not pass `FORCE_UPLOAD=1` for a `PHP_INI` change on its own.
- The render fails on a value it cannot write safely. That is: not a JSON object, empty, more than 32 entries, a name outside `[A-Za-z0-9_.]` (1 to 64 characters), a value that is not a string or an integer, or a string with a quote, a backslash or a control character, or over 256 characters.
- The other config emitters (`deploy/provision`, the Worker path) do not read it. The golden case `php-ini` shows that.
- Tests: `deploy/wfp/tests/render-test.sh` (with it, without it, the refused shapes) and `deploy/tests/render-golden` (case `php-ini`).

### Plugins and themes come from the build: the code lock (#458)

Every site is code-locked: the generated `wp-config.php` sets `DISALLOW_FILE_MODS` and `DISALLOW_FILE_EDIT` (`spikes/b2-wordpress/site-lock.mjs`). wp-admin keeps the standard CMS work; installing, updating or removing core, a plugin or a theme is a code deploy (Conrad, 2026-11-13, on #422). Plugins > Add New, updates and the plugin and theme editors are not offered. Activating and deactivating a plugin, and switching themes, still work. The Plugins and Themes screens say, in one sentence, to add it to the site's build and deploy it (`php/code-lock-notice.php`).

- **Add a plugin or theme:** put it in the build (`PLUGINS`, or `IMPORT_CONTENT` with `IMPORT_PLUGINS` / `IMPORT_THEMES`) and run `deploy/wfp/site update <name>`.
- **No off switch for a deployed site:** `CODE_LOCK=off` exists only for a local or throwaway test instance (`wrangler dev --var CODE_LOCK:off`). No deploy tool renders it.
- **Approach `a`** generates its `wp-config.php` in the same `index.js`, so it is locked the same way.
- **Tests:** `spikes/b2-wordpress/tests/site-lock.test.mjs`, `spikes/b2-wordpress/tests/code-lock-e2e.sh` (local, with a `CODE_LOCK=off` control).

### Keeping the PHP runtime past 100 MiB: PHP_RECYCLE (#394)

`PHP_RECYCLE=off deploy/wfp/site update <name>` keeps the PHP runtime after a request whose WebAssembly memory passed 100 MiB. Without it, the next request boots a new runtime (`index.js`, `RECYCLE_WASM_BYTES`). A crashed runtime is still dropped.
- **What bounds memory then:** nothing in our code. The module's maximum is 2048 MiB, and with `USE_ZEND_ALLOC=0` PHP's `memory_limit` is not enforced by Zend's allocator. The hard stop is the isolate reset, about 188 MiB for WebAssembly alone and 144 MiB with the bundle (#411).
- **Use:** it is for measuring (experiment E1 on #394), and for a site whose admin pages keep recycling.
- **Not a recorded input:** read from the run's environment only, like `PHP_INI`. A same-build update uploads when the rendered value changes. `FORCE_UPLOAD=1` is the explicit override, not a requirement for this change. See "When an update uploads".
- **Tests:** `deploy/wfp/tests/render-test.sh`, golden case `php-recycle-off`.

### The headroom probe: HEADROOM_PROBE (#394). It KILLS the isolate.

`HEADROOM_PROBE=on deploy/wfp/site update <name>` turns on `GET /_headroom` (spike-gated, like every `/_` path). In the PHP object's isolate, after a real request, it allocates 1 MiB `ArrayBuffer`s and holds them until the isolate dies, streaming the count (`spikes/b2-wordpress/headroom.mjs`). Its first line is the memory ledger at that moment. 255 MiB (a bare isolate, the #394 floor probes) minus the reach, minus the ledger's `wasmMiB`, is what the runtime holds outside the WebAssembly heap.
- **It ends the isolate, by design.** Every request in that object at that moment dies with it, and the next one boots a cold PHP runtime.
- **A measurement-build flag only, like `MEM_LEDGER`:** set it only on a throwaway site, NEVER on a store anyone uses.
- **The provisioning paths never set it:** neither the reference path (`deploy/provision`) nor the one-click path (`deploy/oneclick`). `deploy/provision/tests/measurement-flags-test.mjs` checks both.
- **Off or unset:** `/_headroom` answers 404.
- **Not a recorded input:** read from the run's environment only, like `PHP_RECYCLE`.
- **Tests:** `spikes/b2-wordpress/tests/headroom.test.mjs`; the render checks in `deploy/wfp/tests/render-test.sh`.

## The scheduled snapshot (#533)

Every site takes a daily snapshot of its database into its own media bucket: in phase A through its own dispatcher copy, in phase B through a cron-only copy (below).

```sh
./deploy/wfp/site add <name>            # a new site gets the cron and its key at once
./deploy/wfp/site update <name>         # an EXISTING site, step 1: makes its key, uploads it to the user Worker
./deploy/wfp/site schedule <name>       # an existing site, step 2: the cron on its dispatcher copy, read back
SNAPSHOT_CRON=off ./deploy/wfp/site schedule <name>   # remove the cron
./deploy/wfp/site restore <name> auto/<stamp>.ndjson.gz   # restore one (it is gzipped; dbrestore unpacks it)
```

How it works:
- **The cron.** The site's dispatcher copy `wp-<name>` has a daily cron, `SNAPSHOT_CRON` (default `17 7 * * *`, UTC). Its `scheduled()` handler sends `POST /_dbsnapshot` to the site's user Worker through the plain namespace binding. A cron cannot be set on a user Worker in a dispatch namespace: the API has no route for it, and wrangler skips `[triggers]` there (measured on #533). A cron on the ordinary dispatcher Worker reaches the user Worker: measured live on #533, 2026-11-14.
- **The key.** `SNAPSHOT_TOKEN`, a `random_password` in the site's workspace. It is a secret on the user Worker and on that site's own dispatcher copy, and nowhere else. It is not `SPIKE_TOKEN`, and it opens only `/_dbsnapshot`. A visitor's `/_dbsnapshot` gets 404 from the dispatcher on every host, and the site checks the key again in the Worker and in the object.
- **The snapshot.** The object dumps its SQLite (the same dump as `/_dbexport`), gzips it, and writes `_snapshots/auto/<UTC yyyymmddThhmmssZ>.ndjson.gz` to its own bucket. Then it reads the size back. The site's data never passes through the dispatcher. During an import (`/_dbimport` hold) the call answers 409 and stores nothing. A raw dump over 128 MiB answers 413 and stores nothing.
- **A failed run** throws in `scheduled()`, so it shows as a failure in Cron Events. Every run logs one line, `@event snapshot {json}`, with no key in it. The freshness check reads the bucket, not this log. The wait is `SNAPSHOT_TIMEOUT_MS` (default 60000).
- **Order for an existing site.** `site update` first: it applies the workspace once to make the key (the same recorded build and hash), and the upload carries the key. `site schedule` refuses until the user Worker holds `SNAPSHOT_TOKEN`, because without it every cron run would be a 403.
- **A held site (`data_hold`, #515) still takes its snapshot.** The object does not know the hold, so a site whose last rollback restore failed snapshots its PARTIAL database every day. That snapshot is not a good restore point: restore from the key the hold names (`site restore <name>`). The freshness check's size rule will usually flag such a snapshot, because it is under half of the one before it.
- **Phase B (a Custom Domain on the shared `wp-dispatch`).** The site has no per-site dispatcher, so it gets a CRON-ONLY copy `wp-<name>`: the same script and bindings, with `workers_dev = false`, no preview URLs and no route, so no request ever reaches it. `site add` makes it, `site schedule` re-deploys it, and `site remove` deletes it and reads it back gone. After each deploy, `cron_copy_check` reads back that `workers.dev` and previews are off and that no Custom Domain names it. A phase B site made before this has no copy: run `site update`, then `site schedule`.
- **The account cron limit.** Every per-site copy, in either phase, is one Cron Trigger of the account. Workers Paid allows 250 per account (Workers limits page, read 2026-11-14), so this design reaches about 250 sites. Past that, one cron on the shared dispatcher that walks the site map is the next step (it needs a per-site key derived from one master, to keep one key per site).
- **The first run.** A new or changed cron can take up to 15 minutes to arm (Cloudflare documents up to 15; 517 s measured on #533). Do not judge a change by the next minute.
- **Retention (#540).** `terraform/site` expires `_snapshots/auto/` after 35 days (`snapshots-auto-35d`, beside the default multipart abort rule). fleet-chezmoi declares that shape for every `wp-wfp-*-media` bucket (fc#2654). A site gets the rule at its next workspace apply. The site name `auto` is refused, so no site's rollback snapshots (`_snapshots/<site>/`) can fall under the expiring prefix.

The freshness check of these snapshots: see "The freshness check of the scheduled snapshots (#533)" below.

## Phase B: a custom domain per site (#138)

Phase A gives each site its own origin by deploying the one dispatcher script once per site as `wp-<name>` on `workers.dev`. Phase B instead deploys the dispatcher once as `wp-dispatch` and gives each site a Workers Custom Domain `<name>.wfp-test.skyphusion.org`. The dispatcher code does not change: it already routes by the request's own hostname through the site map, so the site map key becomes the custom hostname.

It is off by default. `WFP_CUSTOM_DOMAIN=1` selects it; without the flag, `workers.dev` stays the only live target. `WFP_SUBDOMAIN` sets the test subdomain (default `wfp-test.skyphusion.org`), and `WFP_ZONE_ID` names the zone that holds it. There is no zone default: a Custom Domain with no zone fails at plan. The Skyphusion reference deploy sources `deploy/wfp/reference.env`, which sets `ACCOUNT_ID`, `WFP_ZONE_ID` and `WFP_SUBDOMAIN`; a self-hosted deploy sets its own.

- `up.sh` deploys `wp-dispatch` once, before any site, because a Custom Domain attaches to a service that must already exist.
- A new Custom Domain has no certificate until Cloudflare's Advanced Certificate pack is active, which can exceed 15 min, so the first phase B deploy waits longer: `site_wait_cap` is 1800 s in phase B (300 s in phase A), and `SITE_WAIT` overrides it. If the first deploy still times out while the certificate issues, re-run `up.sh` once it is active: the data plane persists and the install completes on the re-run.
- `site add` (through `site.sh up`) attaches the Custom Domain with Terraform (`cloudflare_workers_custom_domain`, in `terraform/site`), which creates the DNS record and the certificate. `var.hostname` is both this domain and the site map key, so the routed hostname and the key cannot drift.
- `site remove` detaches the Custom Domain before it deletes the map entry (the CR #138 remove order), then removes the rest.

**The live attach routes a zone, so it is governed by CR #138** (the CR #113 pattern: a zone-record snapshot before the first attach, one exact hostname per site, the reversal compared against the snapshot, never a wildcard). The attach is run by the lead as the CR #138 apply step, serialized against the other live work on `skyphusion.org`. This directory ships the code and the offline tests; nothing here routes a zone, and the matrix does not claim custom domains as measured until phase B is proven live.
## Bundle size gate

The Worker size limit is 64 MiB uncompressed. Nearly all of a b-dosql upload is four files: `build/site.zip`, `build/opcache.zip` and the PHP wasm with its loader. `lib.sh bundle_size_check` stops above `BUNDLE_MAX_MIB` (default 62 MiB) and names each file's size. `build_dosql` runs it after the OPcache build, and `site.sh up` and `site update` run it right before the upload, so an upload never starts without headroom. A missing file is an error. Measured sizes for a heavy store are in `docs/known-limitations.md`. Test: `tests/bundle-size-test.sh`.

**The OPcache follows the build inputs, never the builder's machine (#313).** `opcache.sh` primes from a fresh, empty local state on every run (`run.sh PERSIST_TO`), so a leftover `.wrangler/state` no longer decides what ships. WooCommerce pages are primed when `WOO_ACTIVE=1`, which `build_dosql` derives: an explicit `WOO_ACTIVE` (0 or 1) wins, else 1 when `woocommerce` is in `IMPORT_PLUGINS` or `PLUGINS`. A store whose site has WooCommerce active needs it: without the Woo scripts in the cache, the store compiles them inside the 128 MiB isolate and exceeds memory on every request (measured on ggc-test, 2026-11-12). `opcache-check.py` refuses a dump under 400 files, or under 500 WooCommerce files when `WOO_ACTIVE=1` (a primed store holds about 1500); `OPCACHE_MIN_FILES` and `OPCACHE_WOO_MIN` set the floors. A failed `opcache.sh` stops `build_dosql`, also under `site update --all`. Local priming needs `CLOUDFLARE_API_TOKEN` in the environment (the `browser` binding starts a remote proxy). Tests: `tests/woo-active-test.sh`, `spikes/b2-wordpress/tests/opcache-check-test.sh`.

## Bindings read back

After every upload, `bindings.py` reads each script's bindings back from the API (`up.sh` for every site, `site add` for its own site). It fails unless each one binds only its own resources:
- **A user Worker `site-<name>`** may bind its own bucket, its own Durable Object class, Images, its assets (an `ASSETS` binding only on an `OPCACHE_SPLIT=1` build; without it the asset router serves `build/public` before the Worker runs, #412), plain vars, and the secrets `WP_SALT`, `SPIKE_TOKEN`, `TURNSTILE_SECRET` (#340) and `SNAPSHOT_TOKEN` (#533).
- **A dispatcher `wp-<name>`** may bind the site map and the namespace, with its outbound going to `wp-wfp-outbound` only. A site's copy also binds its scheduled snapshot (#533), and only that: `SNAPSHOT_SCRIPT` naming its OWN `site-<name>`, `SNAPSHOT_TIMEOUT_MS` (a number), and the secret `SNAPSHOT_TOKEN`.
- `tests/bindings-render-test.py` runs the REAL rendered configs (`render_user`, `render_site_dispatcher`) and the secret names the deploy uploads through this audit, so a binding lib.sh renders and the audit does not know fails in CI, not on the first live `site add` (as on pf533, #533, 2026-11-14). Note that `site update` and `site schedule` do not run the audit; `up.sh` and `site add` do.

Any other binding fails, and so does a script whose bindings cannot be read. The output names the bindings and their types, never a value.

## Isolation, proven from site A's side (live)

`cross.sh`, after `up.sh` with sites `one` and `two`, proves that our own site A cannot reach site B's resources, using only what a customer's user Worker holds (its bindings, its secrets, `fetch()`). It uploads two attacker probes (`cross-probe/worker.js`): `site-crossa` with site one's bindings and secrets, `site-crossb` with site two's, each behind a dispatcher with a small `cpuMs` and `subRequests`. Then A (`crossa`) attempts to reach B (`two`/`crossb`), and `cross.py` decides the verdict:
- **R2:** A's `MEDIA` list has only A's keys; a `fetch()` to B's bucket returns no bytes.
- **Durable Object:** A's object is its own, not B's.
- **Secrets:** A's `WP_SALT` is its own, not B's; A sees no foreign secret name.
- **Limits:** `subRequests` was exact where measured, without an outbound Worker (not measured with one); `cpuMs` is enforced, inexact below about 2 s (`docs/wfp.md` item 4).

`CROSS_OUTBOUND=0` runs the probes with the outbound flag off (default on). A PASS is a public result. A result where A reaches B against the docs, or any platform isolation gap, goes to the lead only, is written to no artifact, and stops that line (`cross.py` marks it `platform`; `cross.sh` exits 3). A reach through a binding we gave A by mistake is our defect, fixed in the open. The binding readback (above) proves the static half: A's bindings name only A's resources. The method is on issue #35.

## The freshness check of the scheduled snapshots (#533)

`.github/workflows/snapshot-freshness.yml` runs daily at 10:17 UTC, 3 hours after the scheduled snapshot (07:17 UTC). It runs `python3 -I deploy/wfp/snapshot.py fresh` for the sites in `deploy/wfp/snapshot-sites`, and reads each site's `_snapshots/auto/` in its BUCKET. It never reads the dispatcher's log, so it does not share fate with the cron. A site is RED when:
- its `_snapshots/auto/` listing cannot be read;
- it has no `.ndjson.gz` snapshot;
- its newest snapshot is over 26 hours old (`FRESH_MAX_AGE_H`);
- it has a previous snapshot and the newest is under half of its size (`FRESH_MIN_RATIO`, 0.5). A site's FIRST snapshot has nothing to compare against, so this rule does not apply to it.

List a site in `snapshot-sites` only after its cron is live, so a red is a real miss. With no site listed, the check says so and exits 0. The workflow needs `PF_SNAPSHOT_FRESH_TOKEN`, an account token with R2 read only. snapshot.py derives its S3 key from that token. Without it, a run with sites to check is UNMEASURED and fails (exit 2), never green. A manual dispatch can name other sites (the `sites` input): that is how the check is seen going red once on a throwaway.

## Tests (offline)

```sh
node deploy/wfp/tests/dispatcher-test.mjs   # the dispatcher with a stand-in site map and namespace
deploy/wfp/tests/render-test.sh             # the rendered configs and the site names
deploy/wfp/tests/ns-state-test.sh           # "is this namespace script gone" (the empty-record case)
deploy/wfp/tests/kv-ready-test.sh           # the wait for a new site map to accept writes
deploy/wfp/tests/wait-site-test.sh          # the wait for a new site to answer from its own user Worker
deploy/wfp/tests/snapshot-test.sh           # the isolation snapshots and diff, and site_footprint
deploy/wfp/tests/site-cmd-test.sh           # site add and remove refuse, with no write, when they must
python3 deploy/wfp/tests/bindings-test.py   # the bindings read back: each script binds only its own resources
python3 -I deploy/wfp/tests/bindings-render-test.py   # the REAL rendered configs and secret names through the binding audit (#533, after the pf533 add)
python3 deploy/wfp/tests/cross-test.py      # the isolation verdict: a breach is never read as a pass
deploy/wfp/tests/probe-entry-test.sh        # the probe map entry and the CROSS_OUTBOUND option
deploy/wfp/tests/tf-test.sh                 # terraform validate, fmt, and no account token in the site graph (local: needs terraform)
python3 -I deploy/wfp/tests/fresh-test.py   # the freshness check (#533): red on a miss, not on a site's first snapshot
deploy/wfp/tests/r2-temp-test.sh            # the temporary R2 credential: the mint, one bucket only, a refresh on expiry (#273)
deploy/wfp/tests/custom-domain-test.sh      # phase B (#138): custom_host, site_host, the shared dispatcher, the Terraform wiring
deploy/wfp/tests/snapshot-wiring-test.sh    # the scheduled snapshot (#533): the site dispatcher render, both scripts' secrets, the deploy paths
deploy/wfp/tests/phase-b-cron-test.sh       # the phase B cron-only copy (#533): no route, no workers.dev, read back; add, remove and schedule wiring
```
