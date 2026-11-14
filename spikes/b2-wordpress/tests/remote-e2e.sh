#!/bin/bash
# End-to-end check of #563 (#394 Gate 1, OPCACHE_REMOTE): ALL OPcache files in static-asset packs,
# fetched while PHP pauses in open(), NO split and no boot pack. Local wrangler dev (workerd), after
# build.sh, opcache.sh, file-trace.sh and opcache-remote.py. Three runs:
#   1. remote: pages, login, admin, editor, REST write and the store work; pack fetches happen
#      (rfN > 0 summed over fresh-runtime pages) and none fail (rfFail 0);
#   2. cap 0 (REMOTE_FETCH_CAP:0): no pack is fetched, every open of a warm file fails clean, OPcache
#      compiles from source, and the same pages STILL work (rfCapped > 0, rfN 0);
#   3. off (OPCACHE_REMOTE:off): no remote node at all, the pages still work (x-perf remote 'off').
# In every run, GET /_pf/<id>/oc-0.zip answers 404, with and without the spike token (#412).
# Exits 1 on any failure.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=local-spike-password
ID=$(python3 -c "import json,re; m=re.search(r'\{.*\}', open('build/opcache-remote-index.js').read()); print(json.loads(m.group(0))['id'] if m else '')")
[ -n "$ID" ] || { echo "FAIL build/opcache-remote-index.js is null: run opcache-split.py --remote first"; exit 1; }
[ -s "build/public/_pf/$ID/oc-0.zip" ] || { echo "FAIL build/public/_pf/$ID/oc-0.zip is missing"; exit 1; }
[ "$(cat build/opcache-boot-index.js)" = "export default null;" ] || { echo "FAIL build/opcache-boot-index.js is not null: a remote build has no boot pack"; exit 1; }
python3 -c "import zipfile,sys; sys.exit(0 if zipfile.ZipFile('build/opcache.zip').namelist() == [] else 1)" || { echo "FAIL build/opcache.zip is not empty on a remote build"; exit 1; }
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
STATE=""
trap './run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"' EXIT
# perf_sum <field>...: boot a NEW runtime (/_install drops it), GET a few pages, print the summed
# x-perf fields and the boot's remote state, as "rfN=.. rfFail=.. rfCapped=.. remote=..".
perf_sum() {
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  local f; f=$(mktemp)
  for u in "/?nocache=r$RANDOM" "/?post_type=product&nocache=r$RANDOM" "/wp-login.php" "/?rest_route=/wp/v2/types&nocache=r$RANDOM"; do
    curl -s -D - -o /dev/null "${ST[@]}" "$B$u" | grep -i '^x-perf:' >> "$f"
  done
  python3 - "$f" <<'PY'
import json, sys
s = {'rfN': 0, 'rfFail': 0, 'rfCapped': 0}; remote = None; n = 0; held = 0
for line in open(sys.argv[1]):
    d = json.loads(line.split(': ', 1)[1]); n += 1
    for k in s: s[k] += int(d.get(k, 0))
    if d.get('boot') == 1: remote = d.get('remote')
    held = max(held, int(d.get('rfHeldKiB', 0)))
# The remote state has spaces ("packs 21 files 2128 cap 64 holdKiB 2048"): one token, so the
# key=value line splits cleanly (a run of the first shape failed here on a correct reading).
print('pages=%d rfN=%d rfFail=%d rfCapped=%d heldKiB=%d remote=%s' % (n, s['rfN'], s['rfFail'], s['rfCapped'], held, str(remote).replace(' ', '_')))
PY
  rm -f "$f"
}
run_case() { # run_case <label> <DEV_VARS> <python test on the perf_sum line>
  local label=$1 vars=$2 want=$3
  ./run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"
  STATE=$(mktemp -d "${TMPDIR:-/tmp}/remote-e2e.XXXXXX"); export PERSIST_TO=$STATE
  DEV_LOCAL=1 DEV_VARS="$vars" ./run.sh _ping > /dev/null || { echo "FAIL $label: wrangler dev did not start"; bad=1; return; }
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null
  ./e2e.sh "$B" > "build/remote-e2e-$label.log" 2>&1; local e2e=$?
  ok "$label: e2e.sh (pages, login, admin, editor, REST write)" "$([ $e2e = 0 ] && echo 1 || echo 0)"
  B=$B ADMIN_PASSWORD=$PW python3 tests/woo.py > "build/remote-woo-$label.log" 2>&1; local woo=$?
  ok "$label: tests/woo.py (the store and a checkout)" "$([ $woo = 0 ] && echo 1 || echo 0)"
  local line; line=$(perf_sum)
  ok "$label: $line" "$(python3 -c "
import sys; d = dict(kv.split('=', 1) for kv in sys.argv[1].split())
n = lambda k: int(d[k])
print(1 if ($want) else 0)" "$line")"
  local c1 c2
  c1=$(curl -s -o /dev/null -w '%{http_code}' "$B/_pf/$ID/oc-0.zip")
  c2=$(curl -s -o /dev/null -w '%{http_code}' "${ST[@]}" "$B/_pf/$ID/oc-0.zip")
  ok "$label: /_pf/ packs are never served (stranger $c1, with the spike token $c2)" "$([ "$c1" = 404 ] && [ "$c2" = 404 ] && echo 1 || echo 0)"
}
# The held budget is REMOTE_HOLD_KIB (2048) plus the one pack being opened (about 1024 deflated).
run_case remote "" "n('pages') == 4 and n('rfN') > 0 and n('rfFail') == 0 and n('rfCapped') == 0 and 0 < n('heldKiB') <= 3200 and d['remote'].startswith('packs_')"
run_case cap0 "REMOTE_FETCH_CAP:0" "n('pages') == 4 and n('rfN') == 0 and n('rfCapped') > 0"
run_case off "OPCACHE_REMOTE:off" "n('pages') == 4 and n('rfN') == 0 and n('rfCapped') == 0 and d['remote'] == 'off'"
exit $bad
