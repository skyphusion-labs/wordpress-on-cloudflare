# shellcheck shell=bash
# Shared by deploy/wfp/up.sh, down.sh and the tests (issue #35). Sourced, not run.
#
# Names (docs/wfp.md and the #35 slice 1 design):
#   the dispatch namespace          wp-wfp
#   the site map (KV)               wp-wfp-sites: hostname -> {"script", "cpuMs", "subRequests", "outbound", "build", "config_hash"}
#   the outbound Worker             wp-wfp-outbound
#   a site's user Worker            site-<name>, in the namespace (b-dosql)
#   a site's dispatcher (phase A)   wp-<name>, a normal Worker on workers.dev; ONE script and
#                                   ONE config template for every site, only the name differs
#   a site's media bucket           wp-wfp-<name>-media
#   the stale-entry probe           wp-probe, a dispatcher copy whose entry names a script
#                                   that does not exist (it must answer 404)
# Physical paths (pwd -P), so a clone under a symlinked path deploys from the same path a rollback
# mirror uses: a symlink in the config path changes the bundle esbuild writes (#507).
WFP=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(cd "$WFP/../.." && pwd -P)
# The pinned Wrangler. A test points WR at a stub.
WR=${WR:-$ROOT/deploy/wr}
# A test sets APP to a stand-in tree. A deploy leaves it unset.
APP=${APP:-$ROOT/spikes/b2-wordpress}
GEN="$WFP/gen"
NAMESPACE=${NAMESPACE:-wp-wfp}
# The account has NO default: a deploy that forgot it would otherwise send its
# API calls and its Terraform plan to someone else's account id. Each entry point
# calls need_account. The reference deploy sources deploy/wfp/reference.env.
ACCOUNT_ID=${ACCOUNT_ID:-}
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
need_account() {
  [ -n "$ACCOUNT_ID" ] || { echo "set ACCOUNT_ID to the Cloudflare account id to deploy into (the reference deploy sources deploy/wfp/reference.env)" >&2; exit 2; }
  export TF_VAR_account_id=$ACCOUNT_ID
  if [ -n "${WFP_ZONE_ID:-}" ]; then export TF_VAR_zone_id=$WFP_ZONE_ID; fi
}
API=${WFP_API:-https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID}

# A site name: lower case, digits and hyphens, 1 to 30 characters, no hyphen at
# either end (wp-wfp-<name>-media must stay a valid bucket name).
#
# A site's dispatcher is wp-<name>, so a name must not make the name of a SHARED
# Worker: wp-probe, wp-dispatch (the phase B dispatcher), wp-cacheprobe,
# wp-cacheprobe-direct, and wp-wfp-outbound (any wfp- name, which also keeps
# wp-wfp-<x> free for the project's own scripts and buckets). Without this,
# `site remove dispatch` would see a dispatcher and delete the shared one.
# tests/render-test.sh checks every shared Worker name in this tree is refused.
SHARED_WORKER_SITE_NAMES="probe dispatch cacheprobe cacheprobe-direct"
# #533/#540: "auto" is reserved too. A site's hand-taken snapshots (the update rollback) go to
# _snapshots/<site>/, and _snapshots/auto/ is where the scheduled snapshots go and expire after
# 35 days (terraform/site, snapshots-auto-35d). A site named auto would have its rollback
# snapshots expired, and mixed with the scheduled ones.
RESERVED_SITE_NAMES="auto"
valid_site() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$ ]] || return 1
  case "$1" in wfp-*) return 1 ;; esac
  local n
  for n in $SHARED_WORKER_SITE_NAMES $RESERVED_SITE_NAMES; do [ "$1" != "$n" ] || return 1; done
}
user_script() { echo "site-$1"; }
dispatcher_name() { echo "wp-$1"; }
media_bucket() { echo "wp-wfp-$1-media"; }
# Semantic site search (#330, the vectorize-search descriptor of deploy/provision): the per-site
# Vectorize index, the same name and preset as wp-site-config.mjs searchIndexName and
# SEARCH_EMBED_PRESET, so the skyphusion-ai plugin finds the same index on either path.
search_index() { echo "wp-wfp-$1-search"; }
SEARCH_EMBED_PRESET="@cf/baai/bge-large-en-v1.5"
search_on() { [ -n "${WP_VECTORIZE_SEARCH:-}" ] && [ "${WP_VECTORIZE_SEARCH}" != off ]; }

# Phase B (#138, CR gated): the one shared dispatcher, and a site's hostname
# when it has a Custom Domain. WFP_SUBDOMAIN is the test subdomain CR #138
# routes; WFP_CUSTOM_DOMAIN=1 selects phase B. The default is phase A
# (workers.dev), so these change nothing until the flag is set.
SHARED_DISPATCHER=${SHARED_DISPATCHER:-wp-dispatch}
WFP_SUBDOMAIN=${WFP_SUBDOMAIN:-wfp-test.skyphusion.org}
custom_host() { echo "$1.$WFP_SUBDOMAIN"; }

# A site's routed hostname and its site map key, decided in ONE place so the
# key and the route can never drift. Phase A: the per-site workers.dev
# dispatcher wp-<name>. Phase B: the site's Custom Domain <name>.<subdomain>.
site_host() { # site_host <site> <workers.dev subdomain>
  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then custom_host "$1"; else echo "$(dispatcher_name "$1").$2.workers.dev"; fi
}

# The shared dispatcher config (phase B): the same ONE template as phase A,
# rendered with the fixed name wp-dispatch (it routes by request hostname, so
# nothing per-site). render_shared_dispatcher <kv namespace id>.
render_shared_dispatcher() { sed -e "s/@SITE@/dispatch/g" -e "s/@NAMESPACE@/$NAMESPACE/g" -e "s/@KV_ID@/$1/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/dispatcher/wrangler.template.toml"; }

# The "build" field of a site's map entry (issue #35 slice 5): the rollback
# target for "site update". Uses kv_build.py, not an inline literal in a pipe.
# The number of rows in the object's SQLite (issue #35 slice 5), via
# /_dbexport: used to show data survived an update or a rollback.
row_count() { # row_count <origin> <token>
  curl -s -m 120 -K <(printf 'header = "x-spike-token: %s"\n' "$2") "$1/_dbexport" 2>/dev/null | grep -c . || true
}
entry_build() { # entry_build <site>
  api GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$1")" | python3 "$WFP/kv_build.py"
}
# The "config_hash" field, recorded next to "build" (#421). Empty when the entry
# has none (a site recorded before that change). Same read as entry_build.
entry_config_hash() { # entry_config_hash <site>
  api GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$1")" | python3 "$WFP/kv_build.py" config_hash
}
# The "data_hold" field (#515): the snapshot key when a rollback's data restore failed and the
# database is partial; "" otherwise. site update refuses while it is set.
entry_data_hold() { # entry_data_hold <site>
  api GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$1")" | python3 "$WFP/kv_build.py" data_hold
}
# The recovery for a held site (#515), printed by a failed restore and by a refused update. No
# secret: the token is read from the workspace when the command runs.
print_restore_help() { # print_restore_help <site> <origin> <bucket> <snapshot key>
  echo "  restore it:  deploy/wfp/site restore $1            (restores $3/_snapshots/$4, then clears the hold)" >&2
  echo "  or by hand:  python3 -I deploy/wfp/snapshot.py dbrestore $2 \"\$(cd deploy/wfp/terraform/site && terraform workspace select $1 >/dev/null && terraform output -raw spike_token)\" $3 $4" >&2
  echo "               (then clear the hold: deploy/wfp/site restore $1, or an apply with -var data_hold=)" >&2
}
# sha256 of the rendered user config and the sorted secret key names (#421).
# config_hash <rendered file> <secrets json>
# Prints 64 hex characters. A secret value is not hashed and is not printed.
config_hash() {
  PYTHONDONTWRITEBYTECODE=1 python3 -I "$WFP/config_hash.py" "$1" "$2"
}
# Why site update uploads (#421). One line, reasons separated by ", ", or empty
# when there is nothing to do. An empty live hash is "no recorded config hash"
# (upload once). A different hash is "config changed". A different build is
# "build changed". FORCE_UPLOAD=1 adds "forced".
# update_upload_reasons <new build> <live build> <new hash> <live hash>
update_upload_reasons() {
  local new=$1 live=$2 nh=$3 lh=$4 out=""
  if [ "$new" != "$live" ]; then out="build changed"; fi
  if [ -z "$lh" ]; then
    out="${out:+$out, }no recorded config hash"
  elif [ "$nh" != "$lh" ]; then
    out="${out:+$out, }config changed"
  fi
  if [ "${FORCE_UPLOAD:-0}" = 1 ]; then
    out="${out:+$out, }forced"
  fi
  printf '%s\n' "$out"
}
# The site map key (= hostname) of <site>: the recorded one when site_vars has
# read this site's workspace (REC_SITE), else the computed one.
site_key() { # site_key <site>
  if [ "${REC_SITE:-}" = "$1" ] && [ -n "${REC_HOST:-}" ]; then echo "$REC_HOST"; else site_host "$1" "$SUB"; fi
}
compat_date() { sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1; }

# The dispatcher config for one site, from the ONE template: only @SITE@
# differs between sites (the test in tests/render-test.sh checks it).
render_dispatcher() { # render_dispatcher <site> <kv namespace id>
  sed -e "s/@SITE@/$1/g" -e "s/@NAMESPACE@/$NAMESPACE/g" -e "s/@KV_ID@/$2/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/dispatcher/wrangler.template.toml"
}
# The scheduled snapshot (#533, design A', phase A). A SITE's dispatcher copy is the one template
# (render_dispatcher) plus a [vars] block naming its one user Worker and a daily cron; its
# scheduled() handler calls POST /_dbsnapshot on that site with SNAPSHOT_TOKEN, and the site dumps
# its database into its own bucket (_snapshots/auto/). Only site.sh up and "site schedule" render it;
# the stale-entry probe and the attacker probes keep the plain template (no cron).
#   SNAPSHOT_CRON        five cron fields, UTC (default "17 7 * * *", 07:17 UTC daily), or "off": an
#                        empty list, which removes the cron at the next deploy. A new or changed cron
#                        can take up to 15 minutes to arm (Cloudflare docs; 517 s measured on #533).
#   SNAPSHOT_TIMEOUT_MS  the wait for the site's answer, 1 to 840000 (default 60000).
# Both are read from the run's environment only, like PHP_INI.
snapshot_cron() {
  local c=${SNAPSHOT_CRON:-17 7 * * *}
  [ "$c" = off ] && return 0
  [[ "$c" =~ ^[0-9*/,-]+( [0-9*/,-]+){4}$ ]] || { echo "SNAPSHOT_CRON must be five cron fields or off, not ${c}" >&2; return 1; }
  printf '%s\n' "$c"
}
snapshot_timeout_ms() {
  local t=${SNAPSHOT_TIMEOUT_MS:-60000}
  if ! [[ "$t" =~ ^[1-9][0-9]{0,5}$ ]] || [ "$t" -gt 840000 ]; then echo "SNAPSHOT_TIMEOUT_MS must be an integer from 1 to 840000, not ${t}" >&2; return 1; fi
  printf '%s\n' "$t"
}
# Phase B (#533, option A): a site on a Custom Domain is served by the shared wp-dispatch, so it has
# no per-site dispatcher to carry the cron. "cron-only" renders the SAME copy wp-<site> with
# workers_dev = false (preview_urls is false in the template) and no route: it binds what a phase A
# copy binds and passes the same audit, but no request ever reaches it, so it is never a front
# door. Each per-site copy, either phase, is one cron of the account's limit (250 on Workers Paid).
render_site_dispatcher() { # render_site_dispatcher <site> <kv namespace id> [cron-only]
  local cron t
  case "${3:-}" in "" | cron-only) ;; *) echo "render_site_dispatcher: the mode is cron-only or nothing, not ${3}" >&2; return 1 ;; esac
  cron=$(snapshot_cron) || return 1
  t=$(snapshot_timeout_ms) || return 1
  if [ "${3:-}" = cron-only ]; then
    local r; r=$(render_dispatcher "$1" "$2") || return 1
    printf '%s\n' "$r" | grep -qx 'workers_dev = true' || { echo "render_site_dispatcher: the template has no workers_dev = true line to turn off" >&2; return 1; }
    printf '%s\n' "$r" | sed 's/^workers_dev = true$/# Phase B cron-only copy (#533): no workers.dev and no route; it only runs the cron.\nworkers_dev = false/'
  else
    render_dispatcher "$1" "$2"
  fi
  printf '\n# The scheduled snapshot of this one site (#533, lib.sh render_site_dispatcher).\n[vars]\nSNAPSHOT_SCRIPT = "%s"\nSNAPSHOT_TIMEOUT_MS = "%s"\n\n[triggers]\ncrons = [%s]\n' \
    "$(user_script "$1")" "$t" "${cron:+\"$cron\"}"
}
# The cron-only copy (phase B, #533) must stay unreachable: after a deploy its workers.dev and
# preview URLs read back OFF, and no Custom Domain names it. Exit 1 on either, or when either read
# fails (an unread setting is never "off"). cron_copy_check <script>
cron_copy_check() {
  local sub dom
  sub=$(api GET "/workers/scripts/$1/subdomain") || return 1
  [ "${sub##*$'\n'}" = 200 ] || { echo "cron-only copy $1: its workers.dev setting cannot be read (HTTP ${sub##*$'\n'})" >&2; return 1; }
  printf '%s' "${sub%$'\n'*}" | python3 -I -c 'import json, sys
r = json.load(sys.stdin).get("result") or {}
sys.exit(0 if r.get("enabled") is False and r.get("previews_enabled") is not True else 1)' || { echo "cron-only copy $1: workers.dev or its preview URLs are ON" >&2; return 1; }
  dom=$(api GET "/workers/domains") || return 1
  [ "${dom##*$'\n'}" = 200 ] || { echo "cron-only copy $1: the Custom Domain list cannot be read (HTTP ${dom##*$'\n'})" >&2; return 1; }
  printf '%s' "${dom%$'\n'*}" | python3 -I -c 'import json, sys
r = json.load(sys.stdin).get("result")
sys.exit(0 if isinstance(r, list) and not any(isinstance(d, dict) and d.get("service") == sys.argv[1] for d in r) else 1)' "$1" || { echo "cron-only copy $1: a Custom Domain names it" >&2; return 1; }
}
# The --secrets-file JSON of a site's dispatcher copy (#533): its own SNAPSHOT_TOKEN only, from the
# site workspace (tfr site output -json on stdin). Fails when the workspace has none yet.
dispatcher_secrets_json() { # dispatcher_secrets_json <out file>
  python3 -I -c 'import json, os, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
if not o.get("snapshot_token"):
    sys.exit("the site workspace has no snapshot_token (apply it first)")
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"SNAPSHOT_TOKEN": o["snapshot_token"]}, f)' "$1"
}
# The secret NAMES a namespace script holds (one per line), from the API; never a value.
ns_secret_names() { # ns_secret_names <script>
  api GET "/workers/dispatch/namespaces/$NAMESPACE/scripts/$1/secrets" | sed '$d' | python3 -I -c 'import json, sys
try:
    r = json.load(sys.stdin).get("result")
except ValueError:
    sys.exit(1)
if not isinstance(r, list):
    sys.exit(1)
for x in r:
    if isinstance(x, dict) and x.get("name"):
        print(x["name"])'
}
# The Workers Cache probe (CACHE_PROBE=1): render_cacheprobe <name> <true|false>.
# workers_dev false is the namespace copy, which has no workers.dev name.
render_cacheprobe() {
  local wd=$2
  sed -e "s/@NAME@/$1/g" -e "s/@WORKERS_DEV@/$wd/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/cache-probe/wrangler.template.toml" \
    | { if [ "$wd" = false ]; then grep -v '^workers_dev'; else cat; fi; }
}
# The site map entry for an attacker probe: script, limits, and the outbound
# flag. CROSS_OUTBOUND=0 writes it false (an option to run the probes without
# the outbound Worker); unset or any other value writes true, unchanged.
probe_entry() { # probe_entry <script> <cpuMs> <subRequests>
  printf '{"script": "%s", "cpuMs": %s, "subRequests": %s, "outbound": %s}' \
    "$1" "$2" "$3" "$([ "${CROSS_OUTBOUND:-1}" = 0 ] && echo false || echo true)"
}

# The attacker probe (slice 4): render_cross <name> <bucket>.
render_cross() {
  sed -e "s/@NAME@/$1/g" -e "s/@BUCKET@/$2/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/cross-probe/wrangler.template.toml"
}

wrangler_deploy() { # wrangler_deploy <dir> <logfile> <wrangler deploy args...>
  local dir=$1 log=$2; shift 2
  local i rc=0
  for i in $(seq 1 "${WRANGLER_RETRIES:-3}"); do
    if (cd "$dir" && "$WR" deploy "$@") > "$log" 2>&1; then return 0; else rc=$?; fi
    [ "$i" -lt "${WRANGLER_RETRIES:-3}" ] || break
    echo "  wrangler deploy ($*) failed (attempt $i of ${WRANGLER_RETRIES:-3}); retrying in ${WRANGLER_RETRY_S:-5}s (a re-deploy is idempotent)" >&2
    sleep "${WRANGLER_RETRY_S:-5}"
  done
  return "$rc"
}
render_outbound() {
  sed -e "s/@COMPAT@/$(compat_date)/g" "$WFP/outbound/wrangler.template.toml"
}

# The user Worker config: deploy/deploy.sh's b-dosql config, as a namespace
# script (no workers.dev name), with its own origin and media bucket.
# Turnstile (#340, the feature is #250/#308): opt-in. TURNSTILE_SITEKEY (public) goes in [vars];
# TURNSTILE_SECRET goes ONLY in the secrets JSON (site_secrets_json), read from the environment of
# the run. The site key must match the shape turnstile.mjs sanitizeSiteKey accepts, or render fails:
# it is written into the TOML. A site with neither stays as it was.
turnstile_vars() {
  [ -n "${TURNSTILE_SITEKEY:-}" ] || return 0
  [[ "$TURNSTILE_SITEKEY" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "TURNSTILE_SITEKEY is not a Turnstile site key ([A-Za-z0-9_-], 1 to 64, as turnstile.mjs sanitizeSiteKey)" >&2; return 1; }
  echo "TURNSTILE_SITEKEY = \"$TURNSTILE_SITEKEY\""
  local f v
  for f in TURNSTILE_WOO TURNSTILE_LOGIN TURNSTILE_COMMENTS; do
    v=${!f:-}
    case "$v" in "") ;; off) echo "$f = \"off\"" ;; *) echo "$f must be off or unset, not $v" >&2; return 1 ;; esac
  done
}
# The --secrets-file JSON of a user Worker: WP_SALT, SPIKE_TOKEN and (#533) SNAPSHOT_TOKEN from the
# site workspace (tfr site output -json on stdin), plus TURNSTILE_SECRET when the run's environment has it (#340).
# Values go from stdin and the environment to the file only, never to argv or stdout.
site_secrets_json() { # site_secrets_json <out file>  (stdin: tfr site output -json)
  python3 -I -c 'import json, os, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
s = {"WP_SALT": o["wp_salt"], "SPIKE_TOKEN": o["spike_token"]}
# #533: the key of the scheduled snapshot, once the workspace has it (a site recorded before #533
# gets it at its next update, which applies the workspace first).
if o.get("snapshot_token"):
    s["SNAPSHOT_TOKEN"] = o["snapshot_token"]
if os.environ.get("TURNSTILE_SECRET"):
    s["TURNSTILE_SECRET"] = os.environ["TURNSTILE_SECRET"]
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(s, f)' "$1"
}
# PHP_INI (#394): optional php.ini overrides for ONE site, a JSON object of name to value, e.g.
#   PHP_INI='{"opcache.memory_consumption":"48"}' deploy/wfp/site update <name>
# index.js passes it to PHP at every boot (setPhpIniEntries, after its own defaults, so it wins).
# It goes into [vars] as compact JSON with sorted keys. Refused (the render fails): not a JSON
# object, empty, more than 32 entries, a name outside [A-Za-z0-9_.] (1 to 64), a value that is not a
# string or an integer, or a string with a quote, a backslash or a control character (the TOML is a
# literal string) or over 256 characters. Like TURNSTILE_*, it is read from the run's environment
# only: an update that does not pass it renders the site WITHOUT it.
php_ini_var() {
  [ -n "${PHP_INI:-}" ] || return 0
  PHP_INI="$PHP_INI" python3 -I -c 'import json, os, re, sys
def bad(m):
    print("PHP_INI: " + m, file=sys.stderr); sys.exit(1)
try:
    o = json.loads(os.environ["PHP_INI"])
except ValueError:
    bad("not JSON")
if not isinstance(o, dict) or not o: bad("must be a non-empty JSON object")
if len(o) > 32: bad("more than 32 entries")
for k, v in o.items():
    if not re.fullmatch(r"[A-Za-z0-9_.]{1,64}", k): bad("bad name %r" % k)
    if isinstance(v, bool) or not isinstance(v, (str, int)): bad("the value of %s must be a string or an integer" % k)
    if isinstance(v, str) and (len(v) > 256 or re.search(r"[\x00-\x1f\x7f\x27\x22\\]", v)): bad("bad value for %s" % k)
print("PHP_INI = %s" % chr(39) + json.dumps(o, separators=(",", ":"), sort_keys=True) + chr(39))'
}
# LAZY_CACHE_MB (#394, #218): the cap, in MiB, on the inflated copies of bundle files a request keeps
# (index.js LAZY_CACHE_BYTES, default 2 since #394, was 8). At the failing post-new INSERT the cache sat at its 8 MiB cap
# (op48led, 2026-11-13). A smaller cap trades re-inflation (CPU) for isolate memory. An integer from
# 1 to 64. Read from the run's environment only, like PHP_INI. Unset renders nothing (index.js keeps its default, 2).
lazy_cache_var() {
  local v=${LAZY_CACHE_MB:-}
  [ -n "$v" ] || return 0
  if ! [[ "$v" =~ ^[0-9]{1,2}$ ]] || [ "$v" -lt 1 ] || [ "$v" -gt 64 ]; then
    echo "LAZY_CACHE_MB must be an integer from 1 to 64, not ${v}" >&2; return 1
  fi
  echo "LAZY_CACHE_MB = \"$((10#$v))\""
}
# LAZY_ARENA (#394 step 2): "on" inflates bundle files into ONE reused arena per isolate instead of a
# new buffer per file (index.js, inflate-arena.mjs); off or unset keeps today's path. LAZY_ARENA_MB sizes
# the arena (an integer 1 to 64; unset: the LAZY_CACHE_MB size). Read from the run's environment only.
lazy_arena_var() {
  case "${LAZY_ARENA:-}" in
    "") ;;
    on|off) echo "LAZY_ARENA = \"${LAZY_ARENA}\"" ;;
    *) echo "LAZY_ARENA must be on, off or unset, not ${LAZY_ARENA}" >&2; return 1 ;;
  esac
  local v=${LAZY_ARENA_MB:-}
  [ -n "$v" ] || return 0
  if ! [[ "$v" =~ ^[0-9]{1,2}$ ]] || [ "$v" -lt 1 ] || [ "$v" -gt 64 ]; then
    echo "LAZY_ARENA_MB must be an integer from 1 to 64, not ${v}" >&2; return 1
  fi
  echo "LAZY_ARENA_MB = \"$((10#$v))\""
}
# HEADROOM_PROBE (#394): "on" enables the spike-gated GET /_headroom, which allocates in the PHP object's
# isolate until it dies (spikes/b2-wordpress/headroom.mjs). A measurement for THROWAWAY sites only: it ends
# the isolate. Off or unset: /_headroom answers 404. Read from the run's environment only.
headroom_var() {
  case "${HEADROOM_PROBE:-}" in
    "") ;;
    on|off) echo "HEADROOM_PROBE = \"${HEADROOM_PROBE}\"" ;;
    *) echo "HEADROOM_PROBE must be on, off or unset, not ${HEADROOM_PROBE}" >&2; return 1 ;;
  esac
}
# PHP_RECYCLE (#394, experiment E1): "off" turns off the runtime recycle for MEMORY, so the PHP
# runtime is kept after a request whose WebAssembly memory passed RECYCLE_WASM_BYTES (100 MiB,
# index.js). A crashed runtime is still dropped (index.js: crashed || ...). With it off, nothing in
# our code bounds the WASM high-water: the module's own maximum is 2048 MiB, and with
# USE_ZEND_ALLOC=0 PHP's memory_limit is not enforced by Zend's allocator. The hard stop is the
# isolate reset, measured at about 188 MiB for WASM alone and 144 MiB with the bundle (#411).
# Read from the run's environment only, like PHP_INI. Unset keeps the recycle.
php_recycle_var() {
  case "${PHP_RECYCLE:-}" in
    "") ;;
    off) echo 'PHP_RECYCLE = "off"' ;;
    *) echo "PHP_RECYCLE must be off or unset, not ${PHP_RECYCLE}" >&2; return 1 ;;
  esac
}
# CRON_INTERVAL_MS (#479): how often the object's alarm runs the WordPress cron leg (index.js,
# default 60000). A store move holds the cron by rendering a long interval for its window: in #479 M2
# an idle store's Action Scheduler kept writing wp_actionscheduler_logs during an export, so the
# copy could not be proved complete. An integer from 60000 (one minute, the default) to 86400000
# (one day). Read from the run's environment only, like PHP_INI. Unset renders nothing.
cron_interval_var() {
  local v=${CRON_INTERVAL_MS:-}
  [ -n "$v" ] || return 0
  if ! [[ "$v" =~ ^[0-9]{5,8}$ ]] || [ "$((10#$v))" -lt 60000 ] || [ "$((10#$v))" -gt 86400000 ]; then
    echo "CRON_INTERVAL_MS must be an integer from 60000 to 86400000, not ${v}" >&2; return 1
  fi
  echo "CRON_INTERVAL_MS = \"$((10#$v))\""
}
# MEM_LEDGER (#394, mem-ledger.mjs): "on" logs the isolate memory ledger on every request and at
# every cron leg start; "off" or unset leaves it to operator requests (x-mem-ledger: 1). Read from
# the run's environment only, like PHP_INI. Unset renders nothing (byte for byte as before).
mem_ledger_var() {
  case "${MEM_LEDGER:-}" in
    "") ;;
    on|off) echo "MEM_LEDGER = \"${MEM_LEDGER}\"" ;;
    *) echo "MEM_LEDGER must be on, off or unset, not ${MEM_LEDGER}" >&2; return 1 ;;
  esac
}
# #394 L1 (OPCACHE_SPLIT=1): the object fetches the OPcache boot packs through an ASSETS binding,
# and /_pf/ must reach the Worker first (which refuses it), or the asset router would serve the
# site's compiled PHP to anyone (#412). Nothing is added when the build is not split.
# #563: an OPCACHE_REMOTE=1 build needs the same binding and /_pf/ first: its packs hold ALL of the
# site's compiled PHP. opcache_remote_var refuses the two flags together.
opcache_split_assets() {
  case "${OPCACHE_SPLIT:-0}" in
    0) [ "${OPCACHE_REMOTE:-0}" = 1 ] && printf '\nbinding = "ASSETS"\nrun_worker_first = ["/_pf/*"]'; true ;;
    1) printf '\nbinding = "ASSETS"\nrun_worker_first = ["/_pf/*"]' ;;
    *) echo "OPCACHE_SPLIT must be 0 or 1, not ${OPCACHE_SPLIT}" >&2; return 1 ;;
  esac
}
# #563 (#394 Gate 1, OPCACHE_REMOTE=1): ALL OPcache files leave the bundle, as packs under /_pf/ that
# PHP fetches while it pauses in open() (opcache-remote.py, remote-packs.mjs). NO split: the
# 2026-11-13 ruling keeps OPCACHE_SPLIT off (#394 issuecomment-6862048364), so the two flags
# together fail. The var is rendered so that the config hash changes with the flag: the build id
# does not, and an update would otherwise upload nothing.
opcache_remote_var() {
  case "${OPCACHE_REMOTE:-0}" in
    0) ;;
    1) [ "${OPCACHE_SPLIT:-0}" = 1 ] && { echo "OPCACHE_REMOTE=1 and OPCACHE_SPLIT=1 together: pick one (#563 has no split)" >&2; return 1; }
       echo 'OPCACHE_REMOTE = "on"' ;;
    *) echo "OPCACHE_REMOTE must be 0 or 1, not ${OPCACHE_REMOTE}" >&2; return 1 ;;
  esac
}
# #569 (#394 Gate 2, SITE_REMOTE=1): site.zip leaves the bundle too, as packs PHP fetches while it
# pauses in open() (site-remote.py, remote-packs.mjs). Only on top of OPCACHE_REMOTE=1: the same hook,
# request budget, ASSETS binding and /_pf/ first. The var makes the config hash change with the flag.
# remote_assets_check <rendered config> [app dir] (#569): refuse (exit 2) an upload of a remote build
# (OPCACHE_REMOTE or SITE_REMOTE) whose config lacks the ASSETS binding or /_pf/ first, or whose
# config and build disagree on SITE_REMOTE. Called before every user-script upload of a site build.
remote_assets_check() {
  python3 -I "$WFP/remote_assets_check.py" "$1" "${2:-$APP}"
}
# The remote tuning knobs (#563, #569), each rendered only when set, only with its flag, and only in the
# range index.js accepts (intEnv): REMOTE_FETCH_CAP (the soft cap, 0 to 1000), REMOTE_HOLD_KIB (0 to
# 65536) need OPCACHE_REMOTE=1; SITE_FETCH_CAP (the hard cap, 0 to 1000), SITE_HOLD_KIB (0 to 65536),
# SITE_RETRY_MS (0 to 5000) need SITE_REMOTE=1. Recorded settings (#558): a Free site keeps a lower cap.
remote_tuning_vars() {
  local name max flag v out=""
  for spec in REMOTE_FETCH_CAP:1000:OPCACHE_REMOTE REMOTE_HOLD_KIB:65536:OPCACHE_REMOTE SITE_FETCH_CAP:1000:SITE_REMOTE SITE_HOLD_KIB:65536:SITE_REMOTE SITE_RETRY_MS:5000:SITE_REMOTE; do
    IFS=: read -r name max flag <<< "$spec"
    v=${!name:-}
    [ -n "$v" ] || continue
    if ! [[ "$v" =~ ^[0-9]{1,5}$ ]] || [ "$((10#$v))" -gt "$max" ]; then echo "$name must be an integer from 0 to $max, not $v" >&2; return 1; fi
    [ "${!flag:-0}" = 1 ] || { echo "$name needs $flag=1" >&2; return 1; }
    out=${out:+$out$'\n'}"$name = \"$((10#$v))\""
  done
  [ -z "$out" ] || printf '%s\n' "$out"
}
site_remote_var() {
  case "${SITE_REMOTE:-0}" in
    0) ;;
    1) [ "${OPCACHE_REMOTE:-0}" = 1 ] || { echo "SITE_REMOTE=1 needs OPCACHE_REMOTE=1" >&2; return 1; }
       echo 'SITE_REMOTE = "on"' ;;
    *) echo "SITE_REMOTE must be 0 or 1, not ${SITE_REMOTE}" >&2; return 1 ;;
  esac
}
render_user() { # render_user <site> <origin>
  local s=$1 origin=$2 mail_binding mail_vars http_allow ts_vars php_env
  # WFP_PHP_ENV (#434): a measurement build may set USE_ZEND_ALLOC=1 so memory_get_usage reads
  # Zend's own numbers. JSON only, no single quote (it sits in a TOML literal string).
  php_env=${WFP_PHP_ENV:-'{"USE_ZEND_ALLOC":"0"}'}
  case $php_env in *"'"*|*$'\n'*) echo "WFP_PHP_ENV must not hold a single quote or a newline" >&2; return 1 ;; esac
  mail_binding=$(SITE_ORIGIN="$origin" MAIL_FROM="${MAIL_FROM:-}" node "$APP/mail-from.mjs" --binding) || return 1
  mail_vars=$(SITE_ORIGIN="$origin" MAIL_FROM="${MAIL_FROM:-}" MAIL_FROM_NAME="${MAIL_FROM_NAME:-}" node "$APP/mail-from.mjs" --vars) || return 1
  http_allow=$(node "$APP/http-allow.mjs") || return 1
  ts_vars=$(turnstile_vars) || return 1
  # PHP_INI (#394) joins the Turnstile lines, so a site without it renders byte for byte as before.
  local split_assets; split_assets=$(opcache_split_assets) || return 1
  local php_ini; php_ini=$(php_ini_var) || return 1
  [ -z "$php_ini" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$php_ini
  local lazy_cache; lazy_cache=$(lazy_cache_var) || return 1
  [ -z "$lazy_cache" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$lazy_cache
  local lazy_arena; lazy_arena=$(lazy_arena_var) || return 1
  [ -z "$lazy_arena" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$lazy_arena
  local headroom; headroom=$(headroom_var) || return 1
  [ -z "$headroom" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$headroom
  local php_recycle; php_recycle=$(php_recycle_var) || return 1
  [ -z "$php_recycle" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$php_recycle
  local mem_ledger; mem_ledger=$(mem_ledger_var) || return 1
  [ -z "$mem_ledger" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$mem_ledger
  local cron_interval; cron_interval=$(cron_interval_var) || return 1
  [ -z "$cron_interval" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$cron_interval
  local oc_remote; oc_remote=$(opcache_remote_var) || return 1
  [ -z "$oc_remote" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$oc_remote
  local site_remote; site_remote=$(site_remote_var) || return 1
  [ -z "$site_remote" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$site_remote
  local rtune; rtune=$(remote_tuning_vars) || return 1
  [ -z "$rtune" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$rtune
  cat <<TOML
# Generated by deploy/wfp for site $s (b-dosql in namespace $NAMESPACE). Do not edit.
name = "$(user_script "$s")"
main = "index.js"
compatibility_date = "$(compat_date)"
compatibility_flags = ["nodejs_compat"]
rules = [{ type = "Data", globs = ["**/*.zip"], fallthrough = false }]
$mail_binding
[assets]
directory = "build/public"$split_assets
[cache]
enabled = true
[exports.default]
type = "worker"
[exports.default.cache]
enabled = false
[exports.Pages]
type = "worker"
[exports.Pages.cache]
enabled = true
[vars]
PHP_ENV = '$php_env'
SITE_ORIGIN = "$origin"
$mail_vars
HTTP_ALLOW_HOSTS = "$http_allow"
$ts_vars
PHP_IN_DO = "on"
PHP_LOCATION = "${PHP_LOCATION:-enam}"
PHP_DO_POOL = "1"
DB_IN_DO = "on"
[images]
binding = "IMAGES"
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "$(media_bucket "$s")"
[[durable_objects.bindings]]
name = "PHP_RUNTIME"
class_name = "PhpRuntime"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["PhpRuntime"]
TOML
  # Workers Logs for this one site (#291: wrangler tail cannot follow a namespace script). Privacy
  # first (the live store, 2026-11-13): the default invocation logs record each request's client IP,
  # full URL and user agent. So:
  #   OBSERVABILITY=1     events only: our own structured lines and uncaught exceptions, NO request
  #                       metadata (invocation_logs = false). For a diagnosis on a live site.
  #   OBSERVABILITY=full  the invocation logs too. For a throwaway only.
  #   unset or 0          an EXPLICIT enabled = false: without the block a re-upload left a site's
  #                       logging as it was, so "off" did not turn it off.
  case "${OBSERVABILITY:-0}" in
    0) printf '\n[observability]\nenabled = false\n' ;;
    1) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false\n' ;;
    full) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true\n' ;;
    *) echo "OBSERVABILITY must be 0, 1 (events only) or full (a throwaway only), not ${OBSERVABILITY}" >&2; return 1 ;;
  esac
  # WP_VECTORIZE_SEARCH (default off, metered): the token-free AI and SEARCH_INDEX bindings the
  # skyphusion-ai plugin reaches through the index.js op bridge (#330, #332). The index must exist
  # before the deploy; site.sh up makes it (ensure_search_index).
  if search_on; then printf '\n[ai]\nbinding = "AI"\n[[vectorize]]\nbinding = "SEARCH_INDEX"\nindex_name = "%s"\n' "$(search_index "$s")"; fi
}
# The site's search index, as Vectorize answers it (#338): present (200); gone (404, or 410 with
# error 3005 "vectorize.index.deleted", which is how v2 answers a DELETED index, measured on
# fdprobe1112e 2026-11-12); otherwise "unknown <code>", never read as gone.
search_index_state() { # search_index_state <site>
  local out code
  out=$(api GET "/vectorize/v2/indexes/$(search_index "$1")"); code=${out##*$'\n'}
  case "$code" in
    200) echo present ;;
    404) echo gone ;;
    410) if printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
try: d = json.load(sys.stdin)
except ValueError: sys.exit(1)
sys.exit(0 if any(isinstance(e, dict) and e.get("code") == 3005 for e in (d.get("errors") or [])) else 1)'; then echo gone; else echo "unknown 410"; fi ;;
    *) echo "unknown $code" ;;
  esac
}
# The site's search index (#330): make it when absent (idempotent: an existing one is kept), with
# the bge-large preset (1024 dimensions, cosine). Exit 1 when it cannot be made or read back.
ensure_search_index() { # ensure_search_index <site>
  local n c st; n=$(search_index "$1")
  st=$(search_index_state "$1")
  case "$st" in present) echo "  search index $n exists"; return 0 ;; gone) ;; *) echo "search index $n: $st; stopping" >&2; return 1 ;; esac
  c=$(api_code POST "/vectorize/v2/indexes" -H 'content-type: application/json' --data "{\"name\":\"$n\",\"config\":{\"preset\":\"$SEARCH_EMBED_PRESET\"}}")
  case "$c" in 200|201) ;; *) echo "search index $n: create answered $c; stopping" >&2; return 1 ;; esac
  st=$(search_index_state "$1")
  [ "$st" = present ] || { echo "search index $n: not readable after the create ($st)" >&2; return 1; }
  echo "  search index $n made ($SEARCH_EMBED_PRESET)"
}
# Remove the site's search index when it has one, whatever WP_VECTORIZE_SEARCH says now (a site
# added with it on and removed with it off must not leave its index). Then it must read 404.
remove_search_index() { # remove_search_index <site>
  local n st; n=$(search_index "$1")
  st=$(search_index_state "$1")
  case "$st" in gone) echo "  search index $n: none"; return 0 ;; present) ;; *) echo "search index $n: $st; stopping" >&2; return 1 ;; esac
  api DELETE "/vectorize/v2/indexes/$n" > /dev/null || true
  st=$(search_index_state "$1")
  case "$st" in gone) echo "  search index $n is gone (404, or 410 vectorize.index.deleted)" ;; *) echo "  search index $n is NOT gone ($st): stopping" >&2; return 1 ;; esac
}

# WOO_ACTIVE for the OPcache priming (#313), from the build inputs only: an explicit WOO_ACTIVE
# (0 or 1) wins; else 1 when woocommerce is in the site plugin set (IMPORT_PLUGINS or PLUGINS),
# else 0. Never from the local dev state.
woo_active_for_build() {
  case "${WOO_ACTIVE:-}" in 0|1) echo "$WOO_ACTIVE"; return 0 ;; "") ;; *) echo "WOO_ACTIVE must be 0 or 1, not $WOO_ACTIVE" >&2; return 2 ;; esac
  case " ${IMPORT_PLUGINS:-} ${PLUGINS:-} " in *" woocommerce "*) echo 1 ;; *) echo 0 ;; esac
}
# A site update must not ship a build the live site cannot run (#377). On 2026-11-12 a plain
# `site update ggc-test` (no content inputs, no WOO_ACTIVE) replaced the store's build with stock
# WordPress and an OPcache without WooCommerce (615 files, not 2131): every request answered 503
# "The site restarted". Two refusals, before any snapshot, build or upload:
#   - the live Store API answers 200 (WooCommerce is active) and this build would not prime it;
#     an answer that is neither 200 nor 404 needs an explicit WOO_ACTIVE (it cannot tell);
#   - the live build id ends in a content id (-c<8 hex>, build.sh: made with PLUGINS, THEMES or
#     IMPORT_CONTENT) and this run has no content input. ALLOW_PLAIN_BUILD=1 replaces them on
#     purpose. A build id set by hand (BUILD_ID_OVERRIDE) carries no content id; the Store API
#     refusal still holds there.
# update_inputs_check <live build id> <Store API code> <woo 0|1> <content inputs 0|1>
update_inputs_check() {
  local live=$1 code=$2 woo=$3 content=$4
  case "$code" in
    200) [ "$woo" = 1 ] || { echo "WooCommerce is active on the live site (Store API 200), but this build would not prime it (WOO_ACTIVE=$woo): the OPcache would ship without WooCommerce and the store would run out of memory on every request (#313). Pass the site's content inputs (IMPORT_PLUGINS with woocommerce) or WOO_ACTIVE=1." >&2; return 2; } ;;
    404) ;;
    *) [ -n "${WOO_ACTIVE:-}" ] || { echo "the Store API check answered $code, neither 200 nor 404, so it cannot tell whether WooCommerce is active: set WOO_ACTIVE=0 or 1" >&2; return 2; } ;;
  esac
  if [[ "$live" =~ -c[0-9a-f]{8}(-wooprimed)?$ ]] && [ "$content" = 0 ] && [ "${ALLOW_PLAIN_BUILD:-0}" != 1 ]; then
    echo "the live build $live was made with content inputs (PLUGINS, THEMES or IMPORT_CONTENT), and this run has none: it would ship stock WordPress without the site's theme, plugins and mu-plugins. Pass the same content inputs, or ALLOW_PLAIN_BUILD=1 to drop them on purpose." >&2
    return 2
  fi
}
# A site update builds from this tree. A dirty tree makes a -dirty build that nobody can rebuild or
# read back: ggc's live build a0889bfcf082-dirty (2026-11-12) left no record of what it held, so its
# content inputs could not be checked before the update replaced it (#377). Refused unless
# ALLOW_DIRTY=1. tree_clean_check [git dir]
tree_clean_check() {
  local d=${1:-$ROOT} st
  st=$(git -C "$d" status --porcelain 2>/dev/null) || { echo "cannot read the git status of $d" >&2; return 2; }
  [ -z "$st" ] || [ "${ALLOW_DIRTY:-0}" = 1 ] || { echo "the tree $d has uncommitted changes, so the build would be -dirty (not reproducible). Commit or stash them, or ALLOW_DIRTY=1 on purpose:" >&2; echo "$st" | head -10 >&2; return 2; }
}
# 1 when this run has a content input (the rule content-id.py uses), else 0.
content_inputs_set() { if [ -n "${PLUGINS:-}${THEMES:-}${IMPORT_CONTENT:-}" ]; then echo 1; else echo 0; fi; }
# The HTTP code of the site's Store API index (200: WooCommerce active, 404: not), 000 on no answer.
store_api_code() { curl -s -o /dev/null -m 60 -w '%{http_code}' "$1/?rest_route=/wc/store/v1" 2>/dev/null || true; }
# The recorded build inputs of a site (#379, build_inputs.py): _build/inputs.json and the content
# tree _build/<content id>.tar.gz in the site's own media bucket (private outside uploads/).
# use_recorded_inputs <bucket> <work dir>, called by update_one, which declares the inputs
# (PLUGINS, THEMES, IMPORT_THEMES, IMPORT_PLUGINS, IMPORT_MU_PLUGINS, WOO_ACTIVE, IMPORT_CONTENT,
# SUITE, THEME_SUITE) local -x,
# so a recorded value set here stays inside that one update (update --all runs many).
#   no record:                    nothing changes; this run's inputs are recorded after the update
#   a record, a run with no input: the recorded inputs are set and the content tree is fetched
#   a record, different inputs:    refused (2) unless REPLACE_INPUTS=1; the differences are printed
# Sets REC_TREE to the recorded tree key when this run uses it, else "".
use_recorded_inputs() {
  local b=$1 w=$2 rec="$2/inputs.json" rc=0
  REC_TREE=""
  python3 -I "$WFP/build_inputs.py" get "$b" "$rec" || rc=$?
  case "$rc" in
    0) ;;
    3) echo "  no recorded build inputs yet (a site from before #379): this run's inputs are recorded after the update"; return 0 ;;
    *) echo "cannot read the recorded build inputs of $b; refused" >&2; return 2 ;;
  esac
  if [ "$(content_inputs_set)" = 0 ] && [ -z "${WOO_ACTIVE:-}" ]; then
    local tree; tree=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("tree", ""))' "$rec")
    if [ -n "$tree" ]; then
      [[ "$tree" =~ ^_build/c[0-9a-f]{8}\.tar\.gz$ ]] || { echo "the recorded content tree key is not _build/c<8 hex>.tar.gz: $tree; refused" >&2; return 2; }
      python3 -I "$WFP/build_inputs.py" tree-get "$b" "$tree" "$w" > /dev/null || { echo "cannot fetch the recorded content tree $b/$tree; refused" >&2; return 2; }
      REC_TREE=$tree
    fi
    eval "$(python3 -I "$WFP/build_inputs.py" exports "$rec" "$w/wp-content")"
    echo "  using the recorded build inputs: WOO_ACTIVE=${WOO_ACTIVE:-} PLUGINS='${PLUGINS:-}' THEMES='${THEMES:-}' SUITE='${SUITE:-}' THEME_SUITE='${THEME_SUITE:-}' IMPORT_THEMES='${IMPORT_THEMES:-}' IMPORT_PLUGINS='${IMPORT_PLUGINS:-}' IMPORT_MU_PLUGINS='${IMPORT_MU_PLUGINS:-}' tree ${tree:-none}"
    return 0
  fi
  rc=0; python3 -I "$WFP/build_inputs.py" compare "$rec" > "$w/diff" || rc=$?
  case "$rc" in
    0) echo "  this run's inputs equal the recorded ones" ;;
    4) if [ "${REPLACE_INPUTS:-0}" = 1 ]; then echo "  REPLACE_INPUTS=1: the recorded inputs are replaced:"; cat "$w/diff"
       else echo "this run's build inputs differ from the recorded ones; refused (REPLACE_INPUTS=1 replaces them on purpose):" >&2; cat "$w/diff" >&2; return 2; fi ;;
    *) echo "cannot compare with the recorded build inputs; refused" >&2; return 2 ;;
  esac
}
# The per-site settings (#558, site_settings.py): render_user reads PHP_INI, LAZY_CACHE_MB and the
# rest from the run's environment only, so an update that did not export one DROPPED it (ggc-test
# lost its PHP_INI pin on 2026-11-14). A good add or update records them in the site's bucket
# (_build/settings.json); an update keeps them unless the run sets a new value or DROP_SETTINGS
# names them. SITE_SETTINGS is the list; the caller declares them local -x.
SITE_SETTINGS="PHP_INI LAZY_CACHE_MB LAZY_ARENA LAZY_ARENA_MB PHP_RECYCLE CRON_INTERVAL_MS TURNSTILE_SITEKEY TURNSTILE_WOO TURNSTILE_LOGIN TURNSTILE_COMMENTS MAIL_FROM MAIL_FROM_NAME PHP_LOCATION WP_VECTORIZE_SEARCH OPCACHE_SPLIT OPCACHE_REMOTE SITE_REMOTE REMOTE_FETCH_CAP REMOTE_HOLD_KIB SITE_FETCH_CAP SITE_HOLD_KIB SITE_RETRY_MS"
# The measurement flags (HEADROOM_PROBE MEM_LEDGER WFP_PHP_ENV, site_settings.py MEASUREMENT) are
# never recorded: ON only for the run that exports them; the next update without one turns it off.
# A setting render_user reads that is not in this list is DROPPED by an update that does not export
# it: config-hash-test.sh derives the env names render_user's helpers read and fails on a new one.
# keep_settings <bucket> <work dir>: merge the recorded settings into this run's environment. Sets
# SETTINGS_RECORDED (1 or 0). Exit 0 merged or none recorded, 2 refused (unreadable, a missing
# secret, a bad DROP_SETTINGS).
keep_settings() {
  local b=$1 rec="$2/settings.json" rc=0 m
  SETTINGS_RECORDED=0
  python3 -I "$WFP/site_settings.py" get "$b" "$rec" || rc=$?
  case "$rc" in
    0) ;;
    3) echo "  no recorded settings yet (a site from before #558): the live bindings are checked before the upload"; return 0 ;;
    *) echo "cannot read the recorded settings of $b; refused" >&2; return 2 ;;
  esac
  SETTINGS_RECORDED=1
  m=$(python3 -I "$WFP/site_settings.py" merge "$rec") || { echo "the recorded settings of $b cannot be kept; refused" >&2; return 2; }
  eval "$m"
}
# settings_dropcheck <user script> <rendered config> <secrets json> <work dir>: refuse (exit 2) an
# upload that would drop a setting or a secret the LIVE script has, unless DROP_SETTINGS names it.
settings_dropcheck() {
  local out
  out=$(api GET "/workers/dispatch/namespaces/$NAMESPACE/scripts/$1/bindings")
  [ "${out##*$'\n'}" = 200 ] || { echo "the live bindings of $1 cannot be read (HTTP ${out##*$'\n'}), so a dropped setting cannot be ruled out; refused" >&2; return 2; }
  printf '%s' "${out%$'\n'*}" > "$4/live-bindings.json"
  python3 -I "$WFP/site_settings.py" dropcheck "$2" "$4/live-bindings.json" "$3" || return 2
}
# record_settings <bucket> <work dir>: after a good add or update, record this run's settings.
record_settings() {
  python3 -I "$WFP/site_settings.py" env-json > "$2/settings-rec.json" || return 1
  python3 -I "$WFP/site_settings.py" put "$1" "$2/settings-rec.json" || return 1
  echo "  settings recorded in $1/_build/settings.json ($(python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); print(" ".join(sorted(d["settings"])) or "none", "| secrets:", " ".join(d["secrets"]) or "none")' "$2/settings-rec.json"))"
}
# record_build_inputs <bucket> <build id> <work dir>: after a good upload, record this run's inputs.
# The content tree is packed from IMPORT_CONTENT and stored under its content id, unless this run
# used that same recorded tree (REC_TREE).
record_build_inputs() {
  local b=$1 id=$2 w=$3 cid key=""
  # The same two trees build-id.sh hashes, so the recorded content id equals the build id's.
  cid=$(cd "$APP" && python3 -I content-id.py build/wordpress/wp-content build/public/wp-content) || return 1
  if [ -n "${IMPORT_CONTENT:-}" ] && [ -n "$cid" ]; then
    key="_build/$cid.tar.gz"
    if [ "${REC_TREE:-}" != "$key" ]; then
      python3 -I "$WFP/build_inputs.py" pack "$IMPORT_CONTENT" "$w/tree.tar.gz" || return 1
      python3 -I "$WFP/build_inputs.py" tree-put "$b" "$key" "$w/tree.tar.gz" || return 1
    fi
  fi
  python3 -I "$WFP/build_inputs.py" env-json "$cid" "$key" "$id" > "$w/record.json" || return 1
  python3 -I "$WFP/build_inputs.py" put "$b" "$w/record.json" || return 1
  echo "  build inputs recorded in $b/_build/inputs.json (content ${cid:-none}, tree ${key:-none})"
}
# Build b-dosql (spikes/b2-wordpress), as deploy/deploy.sh does: PHP
# WebAssembly, WordPress, the precompiled OPcache (local wrangler dev).
build_dosql() {
  log "build b-dosql (spikes/b2-wordpress)"
  local woo; woo=$(woo_active_for_build) || return 2
  echo "OPcache priming: WOO_ACTIVE=$woo (explicit, or woocommerce in IMPORT_PLUGINS/PLUGINS)"
  ( cd "$APP"
    [ -d node_modules ] || npm ci --silent
    # Every build regenerates the loader (#394, #446): prepare.sh rebuilds vendor/ from the pinned
    # package and applies every patch. Running it only when vendor/php_8_3.js was missing kept an
    # old loader in a tree that had built before, so a new loader patch never reached a deploy
    # (measured on pf394a, 2026-11-13: the heap patch build showed the stock 111 and 133 MiB stairs).
    # No pipe: a pipe takes tail's status and would hide a failed patch assert, shipping the old loader.
    ./prepare.sh || { echo "prepare.sh failed: the loader was not rebuilt"; exit 1; }
    # WOO_ACTIVE reaches build.sh too, so the build id says whether it is primed (#377).
    # WOO follows it (#451): WooCommerce is in the bundle only when the site runs it. A plain site
    # (no WOO_ACTIVE=1, no woocommerce in PLUGINS or IMPORT_PLUGINS) builds without its 11 MiB of
    # site.zip, which #411 measured costs isolate memory too. Both come from the recorded inputs,
    # so -wooprimed in the build id says whether WooCommerce is bundled, and a later update without
    # new inputs rebuilds the same way. A store keeps it: update_inputs_check refuses a build
    # without WooCommerce for a site whose Store API answers (#377). Approach a builds through
    # deploy/deploy.sh, which leaves WOO at build.sh's default (bundled): a Hyperdrive store keeps it.
    # No pipe (#464): a pipe takes tail's status, so a failed build.sh went on to opcache.sh with a
    # half-built tree. The log is outside build/, which build.sh rewrites.
    local blog; blog=$(mktemp)
    WOO=$woo WOO_ACTIVE=$woo ./build.sh > "$blog" || { echo "build.sh failed:"; tail -25 "$blog"; rm -f "$blog"; exit 1; }
    tail -1 "$blog"; rm -f "$blog"
    WOO_ACTIVE=$woo DEV_ENV=dosql-local ./opcache.sh > build/opcache.log 2>&1 || { echo "opcache.sh failed:"; tail -25 build/opcache.log; exit 1; }
    tail -1 build/opcache.log
    # #394 L1 (OPCACHE_SPLIT=1): trace which OPcache files a WARM request reads on the primed build,
    # then keep only those as the module; the rest become static assets fetched when a runtime boots.
    # #563 (OPCACHE_REMOTE=1): the same trace, then EVERY OPcache file to packs in cold-boot read order.
    opcache_remote_var > /dev/null || exit 1
    site_remote_var > /dev/null || exit 1
    if [ "${OPCACHE_SPLIT:-0}" = 1 ] || [ "${OPCACHE_REMOTE:-0}" = 1 ]; then
      WOO_ACTIVE=$woo DEV_ENV=dosql-local ./file-trace.sh > build/file-trace.log 2>&1 || { echo "file-trace.sh failed:"; tail -15 build/file-trace.log; exit 1; }
    fi
    if [ "${OPCACHE_SPLIT:-0}" = 1 ]; then
      python3 -I opcache-split.py build/opcache.zip build/file-trace.json build/build-id.js || exit 1
    fi
    if [ "${OPCACHE_REMOTE:-0}" = 1 ]; then
      python3 -I opcache-remote.py build/opcache.zip build/file-trace.json build/build-id.js || exit 1
    fi
    # #569: after opcache-remote.py (it clears _pf/<id>/; site-remote.py adds st-*.zip and site-hot.zip).
    if [ "${SITE_REMOTE:-0}" = 1 ]; then
      python3 -I site-remote.py build/site.zip build/file-trace.json build/build-id.js || exit 1
    fi ) || return 1
  # The subshell status is checked (#313): under "site update --all" (if "$fn") set -e is off, and
  # a failed opcache.sh used to fall through to the size check with the EMPTY opcache.zip that
  # build.sh starts, and that bundle was uploaded.
  bundle_size_check
}
# The rollback artifact of one site update (#464). save_live_build <live build id> <dest dir> copies
# $APP/build to <dest>/build only when build/ IS the live build of the site being updated: its
# build-id.js equals the build id the site map records for that site. build/ is whatever this clone
# built LAST, which can be another site (a run that updates several sites from one clone) or an
# older build. Saving that one made a failed update re-deploy ANOTHER site's code over this site.
# A -dirty id does not name its content (two dirty trees share it), so it is never trusted.
# Returns 1 with the reason on stdout when there is no artifact; the update then rolls back the
# data only and says to deploy the old build by hand.
save_live_build() {
  local live=$1 dest=$2 have=""
  [ -f "$APP/build/build-id.js" ] && have=$(sed -n 's/export default "\(.*\)";/\1/p' "$APP/build/build-id.js")
  if [ -z "$live" ] || [ "$live" = unknown ]; then echo "the site map records no live build"; return 1; fi
  case "$live" in *-dirty*) echo "the live build $live is from a dirty tree, so its id does not name its code"; return 1 ;; esac
  if [ "$have" != "$live" ]; then echo "build/ holds ${have:-no build}, not this site's live build $live"; return 1; fi
  cp -a "$APP/build" "$dest/build" || { echo "the copy of build/ failed"; return 1; }
  echo "$live"
}
# rollback_build_ok <saved build id> <live build id>: 0 only when both are set and equal (#464).
# Checked again right before the rollback re-deploy, so no path re-deploys a build that is not
# this site's live one.
rollback_build_ok() { [ -n "$1" ] && [ "$1" != unknown ] && [ "$1" = "$2" ]; }
# The rollback tree of one site update (#466): the code that was live, in <dest dir>, with its own
# build/, vendor/ and Worker sources. save_rollback_tree <bucket> <live build id> <dest dir> takes
# the site's own artifact _build/artifact/<live id>.tar.gz first (rollback_artifact.py, which
# refuses an artifact that does not hold that build), else build/ when it IS the live build
# (save_live_build), with this tree's vendor/ and sources. Prints the live id on stdout, the
# source on stderr. Returns 1 with the reason on stdout when there is neither; the update then
# rolls back the data only, as before.
save_rollback_tree() {
  local b=$1 live=$2 dest=$3 rc=0 why f
  if [ -n "$live" ] && [ "$live" != unknown ]; then
    mkdir -p "$dest/art"
    python3 -I "$WFP/rollback_artifact.py" get "$b" "$live" "$dest/art" >&2 || rc=$?
    if [ "$rc" = 0 ]; then
      mv "$dest/art"/* "$dest/" && rmdir "$dest/art" || { echo "the fetched artifact did not move into place"; return 1; }
      echo "  the rollback code is the site's own artifact $b/_build/artifact/$live.tar.gz" >&2
      echo "$live"; return 0
    fi
    rm -rf "$dest/art"
    [ "$rc" = 3 ] && echo "  no rollback artifact of $live in $b yet" >&2
  fi
  why=$(save_live_build "$live" "$dest") || { echo "$why; and no usable artifact of it in $b"; return 1; }
  cp -a "$APP/vendor" "$dest/vendor" || { echo "the copy of vendor/ failed"; return 1; }
  for f in "$APP"/*.js "$APP"/*.mjs "$APP/package.json" "$APP/package-lock.json"; do
    [ -f "$f" ] && { cp -p "$f" "$dest/" || { echo "the copy of $f failed"; return 1; }; }
  done
  echo "  the rollback code is build/ (this clone built the live build last) with this tree's vendor/ and sources" >&2
  echo "$live"
}
# rollback_deploy_dir <saved dir>: build a mirror of the repo layout in a new private temp dir and
# move the saved rollback tree into it at the app's own path (<mirror>/spikes/b2-wordpress), with a
# copy of $APP/node_modules and, when WR is this repo's deploy/wr, a copy of deploy/wr and
# deploy/tools (#507). Prints "<mirror>TAB<app dir>TAB<wrangler>"; the caller removes <mirror>.
# Why: wrangler bundles with module paths relative to the directory it runs in (deploy/tools and
# node_modules both show up in the bundle), and esbuild names an anonymous default export of
# index.js after its directory. From a temp dir elsewhere the bundle came out with other strings in
# it. In the mirror, every relative path and name is the original's, so the bundle and its modules
# are byte-equal to the original deploy's (rollback-slim-test.sh). Copies, not hard links: nothing
# a rollback runs can write through into the real trees.
rollback_deploy_dir() {
  local saved=$1 rb rel app wr=$WR
  case "$APP" in "$ROOT"/*) rel=${APP#"$ROOT"/} ;; *) rel=$(basename "$APP") ;; esac
  rb=$(mktemp -d) || return 1; chmod 700 "$rb"
  rb=$(cd "$rb" && pwd -P) || return 1   # physical, as ROOT is: see the note at WFP=
  app="$rb/$rel"; mkdir -p "$app"
  if ! mv "$saved"/* "$app"/; then rm -rf "$rb"; return 1; fi
  if [ -d "$APP/node_modules" ]; then
    python3 -I -c 'import shutil, sys; shutil.copytree(sys.argv[1], sys.argv[2], symlinks=True)' "$APP/node_modules" "$app/node_modules" || { echo "  the copy of node_modules failed" >&2; rm -rf "$rb"; return 1; }
  fi
  if [ "$WR" = "$ROOT/deploy/wr" ] && [ -x "$ROOT/deploy/tools/node_modules/.bin/wrangler" ]; then
    mkdir -p "$rb/deploy"; cp -p "$ROOT/deploy/wr" "$rb/deploy/wr"
    python3 -I -c 'import shutil, sys; shutil.copytree(sys.argv[1], sys.argv[2], symlinks=True)' "$ROOT/deploy/tools" "$rb/deploy/tools" || { echo "  the copy of deploy/tools failed" >&2; rm -rf "$rb"; return 1; }
    wr="$rb/deploy/wr"
  fi
  printf '%s\t%s\t%s\n' "$rb" "$app" "$wr"
}
# write_rollback_artifact <bucket> <build id> [previous build id]: after a good update or add, store
# what was deployed ($APP: build/, vendor/, sources) as _build/artifact/<id>.tar.gz, then prune
# every artifact but this one and the previous build (#466). It never fails the caller's result:
# without an artifact, the next update has no code rollback (data only), which is safe.
write_rollback_artifact() {
  local b=$1 id=$2 prev=${3:-} w
  w=$(mktemp -d); chmod 700 "$w"
  if python3 -I "$WFP/rollback_artifact.py" pack "$APP" "$id" "$w/a.tar.gz" && python3 -I "$WFP/rollback_artifact.py" put "$b" "$id" "$w/a.tar.gz"; then
    python3 -I "$WFP/rollback_artifact.py" prune "$b" "$id" "$prev" || echo "  WARNING: the old rollback artifacts in $b were not all pruned" >&2
  else
    echo "  WARNING: no rollback artifact of $id was stored in $b: if the NEXT update fails, its code is not rolled back (the data is)" >&2
  fi
  rm -rf "$w"
  return 0
}
# The Worker size limit is 64 MiB uncompressed (docs/plan-limits.md; measured:
# 72 MB refused). Four files make almost all of a b-dosql upload: build/site.zip
# (WordPress and the site's plugins), build/opcache.zip, and the PHP wasm with
# its loader. A store with WooCommerce and Rank Math measured 61.46 MiB of
# them (2026-11-11, skyphusion-labs/ggc#101): about 2.5 MiB from the limit, so
# one plugin bump could stop its next upload. Stop BEFORE an upload above
# BUNDLE_MAX_MIB (default 62), and say which file is how big. A missing file is
# an error, never a small bundle.
bundle_size_check() { # bundle_size_check [app dir]
  python3 - "${1:-$APP}" "${BUNDLE_MAX_MIB:-62}" <<'PY'
import os, sys
app, cap = sys.argv[1], float(sys.argv[2])
parts = ["build/site.zip", "build/opcache.zip", "vendor/php_8_3.wasm", "vendor/php_8_3.js"]
missing = [p for p in parts if not os.path.isfile(os.path.join(app, p))]
if missing:
    sys.exit("bundle size: missing " + ", ".join(missing) + " (build first)")
sizes = {p: os.path.getsize(os.path.join(app, p)) for p in parts}
mib = sum(sizes.values()) / 1048576
detail = ", ".join("%s %.2f MiB" % (os.path.basename(p), s / 1048576) for p, s in sizes.items())
if mib > cap:
    sys.exit("bundle size: %.2f MiB is over the %.0f MiB gate (Worker limit 64 MiB): %s" % (mib, cap, detail))
print("bundle size: %.2f MiB of the %.0f MiB gate (%s)" % (mib, cap, detail))
PY
}

# API calls: the token goes to curl in a config on a pipe, never in argv.
api() { # api <method> <path> [curl args...]: prints the body, then a line with the HTTP code
  local m=$1 p=$2; shift 2
  curl -s -m 60 -X "$m" -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") -w '\n%{http_code}' "$API$p" "$@"
}
api_code() { api "$@" | tail -1; }
# A script in the namespace: present, gone or unknown. The HTTP status of the
# single GET is NOT enough: after a DELETE it can answer 200 with success true
# and a record whose script id is null (a ghost, seen live 2026-11-06 on
# site-one), while the namespace list no longer has it and a second DELETE
# answers 10007 "This Worker does not exist". So: gone when the list does not
# have it AND the single GET is 404 or a ghost; present when either has it;
# unknown when the list cannot be read.
ns_script_state() { # ns_script_state <script>
  local t; t=$(mktemp -d)
  api GET "/workers/dispatch/namespaces/$NAMESPACE/scripts?per_page=1000" > "$t/list"
  api GET "/workers/dispatch/namespaces/$NAMESPACE/scripts/$1" > "$t/one"
  python3 - "$1" "$t/list" "$t/one" <<'PY'
import json, sys
name = sys.argv[1]
def read(p):
    lines = open(p).read().rsplit("\n", 1)
    body, code = (lines[0], lines[1].strip()) if len(lines) == 2 else ("", lines[0].strip())
    try:
        return code, json.loads(body)
    except ValueError:
        return code, None
lc, l = read(sys.argv[2]); oc, o = read(sys.argv[3])
if lc != "200" or not isinstance(l, dict) or not isinstance(l.get("result"), list):
    print("unknown"); sys.exit()
def ids(x):
    return {x.get("id"), (x.get("script") or {}).get("id")} if isinstance(x, dict) else set()
in_list = any(name in ids(x) for x in l["result"])
if oc == "404":
    one = "absent"
elif oc == "200" and isinstance(o, dict) and isinstance(o.get("result"), dict):
    one = "present" if name in ids(o["result"]) else "ghost"
else:
    one = "unknown"
if in_list or one == "present":
    print("present")
elif one in ("absent", "ghost"):
    print("gone")
else:
    print("unknown")
PY
  rm -rf "$t"
}
# A NEW KV namespace can refuse writes for a while: on 2026-11-06 the entry
# PUT right after the shared apply answered 404 10013 "namespace not found",
# while a GET of the namespace already answered (the second day one). So
# before a site writes its entry: a test write, retried on 404 or 5xx for
# KV_READY_S (180) s, then the test key deleted. Any other answer fails at once.
kv_wait_writable() { # kv_wait_writable <namespace id>
  local t0=$SECONDS c
  while :; do
    c=$(api_code PUT "/storage/kv/namespaces/$1/values/wfp-ready-probe" -H 'content-type: text/plain' --data 1) || c=000
    if [ "$c" = 200 ]; then
      c=$(api_code DELETE "/storage/kv/namespaces/$1/values/wfp-ready-probe") || c=000
      [ "$c" = 200 ] || { echo "site map: the test key was written but its DELETE answered HTTP $c" >&2; return 1; }
      echo "  site map writable after $((SECONDS - t0)) s"
      return 0
    fi
    case "$c" in
      404|5??|000) ;;
      *) echo "site map $1: a test write answered HTTP $c" >&2; return 1 ;;
    esac
    [ $((SECONDS - t0)) -lt "${KV_READY_S:-180}" ] || { echo "site map $1 still refuses writes after ${KV_READY_S:-180} s (HTTP $c)" >&2; return 1; }
    sleep "${KV_READY_STEP:-5}"
  done
}
# Wait for a new site to answer from its OWN user Worker, not from the
# platform or the dispatcher (the #92 trap: any answer is not "ready").
# Seen 2026-11-06 (the third day one): site two's first answer was a 404, and
# one second later the dispatcher answered "not deployed" (x-wfp-error
# not-deployed: the entry was read, but the namespace did not have the new
# script yet). The probe is GET /_dbping with no spike token: b-dosql answers
# it with its own 403 before and after the install.
#   ready:    2xx, 3xx, 401 or 403, with no x-wfp-error
#   retried:  no answer, 404, 5xx, x-wfp-error no-site or not-deployed
#   fails at once: x-wfp-error bad-entry or dispatch (a configuration fault)
# Bound SITE_WAIT (300) s, every SITE_WAIT_STEP (10) s; a timeout prints the last answer.
# The time wait_site waits for a new site to answer. Phase B's FIRST deploy
# must cover the Advanced Certificate issuance for a new Custom Domain, which
# can exceed 15 min (Cloudflare docs: a new hostname has no certificate until
# the pack is active, so TLS fails until then). Phase A has no certificate, so
# it stays short. SITE_WAIT overrides either.
site_wait_cap() { echo "${SITE_WAIT:-$([ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo 1800 || echo 300)}"; }
# The clock and the sleep of wait_site, as two functions a test can redefine after it sources
# this file (#319): the test then drives a fake clock by request count, so a loaded box cannot
# move a case across a bound. The defaults are the real ones: $SECONDS and sleep.
wait_now() { echo "$SECONDS"; }
wait_sleep() { sleep "$1"; }
wait_site() { # wait_site <origin>
  local t0 t code err body cap said_tls=0 said_dispatch=0
  t0=$(wait_now)
  cap=$(site_wait_cap)
  t=$(mktemp -d)
  while :; do
    code=$(curl -s -o "$t/b" -D "$t/h" -w '%{http_code}' -m 60 "$1/_dbping?nocache=$RANDOM$RANDOM" 2>/dev/null) || code=000
    err=$(tr -d '\r' < "$t/h" 2>/dev/null | awk -F': ' 'tolower($1) == "x-wfp-error" { print $2 }')
    body=$(head -c 80 "$t/b" 2>/dev/null | tr -s '\n\r\t' ' ')
    # bad-entry is a malformed site map entry: a fault at once. dispatch is any error from
    # the namespace script, and a brand-new site's FIRST cold boot can give one before it
    # answers (#294: fdprobe1111c answered 502 dispatch once, then served). So a dispatch
    # error is retried for WFP_DISPATCH_GRACE seconds (default 120) before it is a fault.
    case "$err" in
      bad-entry) echo "the dispatcher answered $code $err: a configuration fault, not a delay ($body)" >&2; rm -rf "$t"; return 1 ;;
      dispatch)
        if [ $(($(wait_now) - t0)) -ge "${WFP_DISPATCH_GRACE:-120}" ]; then
          echo "the dispatcher answered $code $err for ${WFP_DISPATCH_GRACE:-120} s: a fault in the site script, not a cold boot ($body)" >&2; rm -rf "$t"; return 1
        fi
        [ "${said_dispatch:-0}" = 1 ] || { echo "  the site script errored ($code $err); retrying for up to ${WFP_DISPATCH_GRACE:-120} s (a first cold boot)"; said_dispatch=1; } ;;
    esac
    if [ -z "$err" ] && [[ "$code" =~ ^(2..|3..|401|403)$ ]]; then
      echo "  the site answered HTTP $code after $(($(wait_now) - t0)) s"
      rm -rf "$t"; return 0
    fi
    # Phase B first deploy: a new Custom Domain's Advanced Certificate may still
    # be issuing, so TLS is not ready and curl reads 000 or a 52x edge code.
    # That is a delay, not a fault: say so once and keep waiting to the cap.
    if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && [ "$said_tls" = 0 ] && [[ "$code" =~ ^(000|522|523|525|526)$ ]]; then
      echo "  waiting for TLS on $1 (the Advanced Certificate may still be issuing; up to ${cap}s)"
      said_tls=1
    fi
    if [ $(($(wait_now) - t0)) -ge "$cap" ]; then
      echo "the site did not answer in ${cap} s; last: HTTP $code${err:+, x-wfp-error $err}, body: $body" >&2
      [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo "  if the Advanced Certificate for $1 is still issuing, re-run up.sh once it is active: the data plane persists and the install completes on the re-run" >&2
      rm -rf "$t"; return 1
    fi
    wait_sleep "${SITE_WAIT_STEP:-10}"
  done
}
# Which parts of a site exist, from the API only (no Terraform): one line
# each, "<part> <state>": dispatcher yes|no, script present|gone|unknown
# (ns_script_state), entry yes|no, bucket yes|no; any other HTTP answer is
# "unknown". Needs KV_ID and SUB. "site add" refuses unless every part is
# absent; "site remove" checks that every part is absent after.
site_footprint() { # site_footprint <name>
  local s=$1 c
  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] || { [ "${REC_SITE:-}" = "$s" ] && [ "${REC_CD:-}" = true ]; }; then
    # Phase B: the per-site routing is the Custom Domain, not a per-site Worker; the site's
    # cron-only copy wp-<site> (#533) carries its scheduled snapshot.
    if api GET "/workers/domains" | grep -q "\"$(site_key "$s")\""; then echo "domain yes"; else echo "domain no"; fi
    c=$(api_code GET "/workers/scripts/$(dispatcher_name "$s")")
    case "$c" in 200) echo "cron yes" ;; 404) echo "cron no" ;; *) echo "cron unknown" ;; esac
  else
    c=$(api_code GET "/workers/scripts/$(dispatcher_name "$s")")
    case "$c" in 200) echo "dispatcher yes" ;; 404) echo "dispatcher no" ;; *) echo "dispatcher unknown" ;; esac
  fi
  echo "script $(ns_script_state "$(user_script "$s")")"
  c=$(api_code GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$s")")
  case "$c" in 200) echo "entry yes" ;; 404) echo "entry no" ;; *) echo "entry unknown" ;; esac
  c=$(api_code GET "/r2/buckets/$(media_bucket "$s")")
  case "$c" in 200) echo "bucket yes" ;; 404) echo "bucket no" ;; *) echo "bucket unknown" ;; esac
  # The search index (#330): a part when WP_VECTORIZE_SEARCH is on, or whenever one exists.
  case "$(search_index_state "$s")" in present) echo "search yes" ;; gone) ! search_on || echo "search no" ;; *) echo "search unknown" ;; esac
}
# Who wrote a site's map entry (#294): "core" when it is the provisioning core's (cli.mjs or the
# provisioning Worker: its entry has a "kind" field, and this package's Terraform entry never
# does), "workspace" for any other entry, "none" when there is none, "unknown" when it cannot be
# read. deploy/wfp/site remove refuses a core site BEFORE any change: it has parts this package
# does not make or know (a per-site KV namespace, descriptor resources), so a remove here could
# only ever be half of one.
entry_by_core() { # entry_by_core <name>; needs KV_ID and SUB
  local out code
  out=$(api GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$1")")
  code=${out##*$'\n'}
  case "$code" in
    404) echo none; return 0 ;;
    200) ;;
    *) echo unknown; return 0 ;;
  esac
  printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
try: d = json.loads(sys.stdin.read())
except ValueError: print("unknown"); sys.exit(0)
print("core" if isinstance(d, dict) and "kind" in d else "workspace")'
}
footprint_absent() { # footprint_absent <footprint text>: 0 when every part is absent
  ! printf '%s\n' "$1" | grep -qvE '^(dispatcher no|domain no|cron no|script gone|entry no|bucket no|search no)$'
}
footprint_present() { # footprint_present <footprint text>: 0 when every part is there
  ! printf '%s\n' "$1" | grep -qvE '^(dispatcher yes|domain yes|cron yes|script present|entry yes|bucket yes|search yes)$'
}
# What a site's workspace RECORDS: its hostname, whether it has a Custom
# Domain, and that domain's zone. Prints "<hostname> <true|false> <zone_id|->",
# or nothing when the workspace records no hostname (a site that was never
# applied). Needs the site's workspace selected. For an existing site these
# win over the computed ones (site_host, WFP_CUSTOM_DOMAIN, the zone_id
# default): a site can be added with its own apex on its own zone (ggc.sh on
# the ggc.sh zone), and an update, import or remove that recomputed them
# would re-key its site map entry and replace its Custom Domain on another
# zone, which takes the site off its domain.
site_recorded() {
  local host cd=false zone=-
  host=$(tfr site output -raw hostname 2>/dev/null) || host=""
  case "$host" in *[!A-Za-z0-9.-]*|"") return 0 ;; esac
  if tfr site state list 2>/dev/null | grep -qxF 'cloudflare_workers_custom_domain.site[0]'; then
    cd=true
    zone=$(tfr site state show -no-color 'cloudflare_workers_custom_domain.site[0]' 2>/dev/null | sed -n 's/^ *zone_id *= *"\([0-9a-f]*\)"$/\1/p' | head -1)
    [ -n "$zone" ] || { echo "site_recorded: the Custom Domain in the state has no zone_id; stopping" >&2; return 1; }
  fi
  echo "$host $cd $zone"
}
# The -var arguments for an EXISTING site: the recorded values when there are
# some, else the computed ones (phase A, or WFP_CUSTOM_DOMAIN). Sets the
# globals REC_HOST, REC_CD and REC_VARS. Needs the site's workspace selected.
site_vars() { # site_vars <site> <workers.dev subdomain> <kv id>
  local rec zone
  rec=$(site_recorded) || return 1
  if [ -n "$rec" ]; then
    read -r REC_HOST REC_CD zone <<< "$rec"
  else
    REC_HOST=$(site_host "$1" "$2"); zone=-
    REC_CD=$([ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo true || echo false)
  fi
  REC_SITE=$1
  REC_VARS=(-var "name=$1" -var "hostname=$REC_HOST" -var "kv_namespace_id=$3" -var "custom_domain=$REC_CD")
  [ "$zone" = - ] || REC_VARS+=(-var "zone_id=$zone")
  # The recorded data hold (#515) goes to every apply, so an apply that does not mean to clear it
  # keeps it. Only "site restore" clears it (a later -var data_hold= wins).
  local hold; hold=$(tfr site output -raw data_hold 2>/dev/null) || hold=""
  case "$hold" in *[!A-Za-z0-9._/-]*) hold="" ;; esac
  REC_VARS+=(-var "data_hold=$hold")
}
# The sites: the Terraform workspaces of terraform/site, without "default".
list_sites() {
  # Loud on failure (#338): a silent exit 1 here hid a missing state credential.
  tfr site init -input=false >/dev/null 2>&1 || {
    echo "list_sites: terraform init of deploy/wfp/terraform/site failed (WFP_STATE=${WFP_STATE:-local}; with r2 it needs the R2 state credentials AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY loaded)" >&2
    return 1
  }
  tfr site workspace list | tr -d ' *' | grep -v '^default$' | grep -v '^$' || true
}
# A site answers its OWN title through its dispatcher: HTTP 200 and the page
# <title> contains <want>. Used by cross.sh's setup-green gate (issue #35).
site_title_ok() { # site_title_ok <url> <want>
  local body code title
  body=$(curl -s -m 60 -w '\n%{http_code}' "$1" 2>/dev/null) || return 1
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [ "$code" = 200 ] || return 1
  title=$(printf '%s' "$body" | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p' | head -1)
  case "$title" in *"$2"*) return 0 ;; *) return 1 ;; esac
}
# Wait for a re-uploaded site to run the new build (issue #35 slice 5). Poll
# /_build (the OBJECT's running version) until it equals <want>. Measured
# 2026-11-06: a re-upload flips it in about 1 s. If it has not flipped by
# BUILD_EVICT_AFTER s, call /_evict once (the fast-path for a busy object;
# abort() is unproven on our compat date, so this is best-effort), then keep
# polling to BUILD_WAIT s. Prints the last build seen; 0 when it flips.
wait_build() { # wait_build <origin> <token> <want>
  local t0=$SECONDS b evicted=0
  while :; do
    b=$(curl -s -m 30 -K <(printf 'header = "x-spike-token: %s"\n' "$2") "$1/_build" 2>/dev/null | python3 -c "import json,sys
try: print(json.load(sys.stdin).get(\"build\",\"\"))
except Exception: print(\"\")")
    [ "$b" = "$3" ] && { echo "  build $b live after $((SECONDS - t0)) s"; return 0; }
    if [ "$evicted" = 0 ] && [ $((SECONDS - t0)) -ge "${BUILD_EVICT_AFTER:-20}" ]; then
      echo "  the old build still runs after $((SECONDS - t0)) s; calling /_evict (best-effort)" >&2
      curl -s -o /dev/null -m 30 -K <(printf 'header = "x-spike-token: %s"\n' "$2") "$1/_evict" || true
      evicted=1
    fi
    [ $((SECONDS - t0)) -lt "${BUILD_WAIT:-60}" ] || { echo "the new build $3 did not go live in ${BUILD_WAIT:-60} s (last: ${b:-none})" >&2; return 1; }
    sleep "${BUILD_POLL_S:-3}"
  done
}
# Run <updater-fn> over the sites in order, STOP at the first failure: the
# sites after the failed one are NOT reached, so a bad version never rolls
# across the estate (issue #35 slice 5). Prints a summary; returns 1 if any
# failed.
update_all() { # update_all <updater-fn> <site>...
  local fn=$1; shift
  local rc=0 done_list="" failed="" left="" site
  for site in "$@"; do
    if [ "$rc" = 0 ]; then
      # The failed site's own code is kept (#515: 3 is a failed data restore, the site is held).
      if "$fn" "$site"; then done_list="$done_list $site"; else rc=$?; [ "$rc" != 0 ] || rc=1; failed=" $site"; fi
    else left="$left $site"; fi
  done
  echo "update --all: updated:${done_list:- none}; failed:${failed:- none}; not reached:${left:- none}"
  return "$rc"
}
subdomain() {
  api GET /workers/subdomain | sed '$d' | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])'
}

# Terraform: tfr <root> <args...> in deploy/wfp/terraform/<root>. WFP_STATE=r2
# keeps the state in the R2 state bucket (wp-on-cf-tfstate, key
# wfp-ref/<root>.tfstate; a site workspace adds its own prefix), as deploy/ does.
tfr() {
  local r=$1; shift
  if [ "${WFP_STATE:-local}" = r2 ] && [ ! -f "$WFP/terraform/$r/backend_override.tf" ]; then
    cat > "$WFP/terraform/$r/backend_override.tf" <<HCL
terraform {
  backend "s3" {
    bucket                      = "wp-on-cf-tfstate"
    key                         = "wfp-ref/$r.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://$ACCOUNT_ID.r2.cloudflarestorage.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
HCL
  fi
  (cd "$WFP/terraform/$r" && terraform "$@")
}
log() { printf '\n== %s\n' "$*"; }

# r2_temp_mint <bucket> <ttl s> <cred file>: mint a temporary credential for that one bucket into
# <cred file> (r2_temp.py, #273), for r2-empty.sh and media.sh as R2_CRED_FILE. Returns 1 if it
# cannot. r2_temp_refresh_cmd <same>: the R2_CRED_REFRESH command that mints a fresh one into the
# same file on a refusal. The deploy token needs R2 Storage Write and no API Tokens permission.
r2_temp_mint() { python3 -I "$WFP/r2_temp.py" mint "$1" "$2" "$3"; }
r2_temp_refresh_cmd() { printf 'python3 -I %q mint %q %q %q' "$WFP/r2_temp.py" "$1" "$2" "$3"; }
# down_empty_bucket <site>: empty the site's media bucket before its workspace is destroyed.
# Uses the workspace already selected. Only when the bucket exists: a down creates nothing. The
# empty runs with a temporary credential that reaches only that bucket (#273), minted here from
# the deploy token, so no token is made in the account and none is left in the state: it expires
# after R2_TEMP_TTL (3600 s) and cannot be revoked alone. r2-empty.sh mints a fresh one on a
# refusal. R2_EMPTY overrides the empty script (tests).
down_empty_bucket() {
  local s=$1 B rc=0 cf ttl=${R2_TEMP_TTL:-3600}
  B=$(media_bucket "$s")
  if [ "$(api_code GET "/r2/buckets/$B")" != 200 ]; then
    echo "  bucket $B does not exist: nothing to empty"; return 0
  fi
  cf=$(mktemp); chmod 600 "$cf"
  r2_temp_mint "$B" "$ttl" "$cf" || { rm -f "$cf"; echo "site $s: no temporary credential for $B, so it was not emptied" >&2; return 1; }
  R2_CRED_FILE=$cf R2_CRED_REFRESH=$(r2_temp_refresh_cmd "$B" "$ttl" "$cf") \
    "${R2_EMPTY:-$ROOT/deploy/variants/r2-empty.sh}" "$(tfr site output -raw r2_endpoint)" "$B" || rc=$?
  rm -f "$cf" "$cf.flock" "$cf.minted"
  [ "$rc" = 0 ] || echo "  emptying $B failed (exit $rc); its temporary credential expires within $ttl s" >&2
  return "$rc"
}
