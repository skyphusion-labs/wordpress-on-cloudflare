#!/bin/bash
# #352 end to end on local workerd: the request frame (REQUEST_FRAMES) off, then on, on the primed build.
# Each run: e2e.sh (pages, login, admin, editor, REST write) and tests/woo.py (the store and a checkout)
# must pass. Then the COST, frame on against off (the lead's ask, measured, not estimated):
#   10 REST updates of one post (an admin save) and 10 GETs of post-new.php (a GET that writes an
#   auto-draft), read from x-perf (dbMs, dbN, frame) and x-db-rows (written).
# With frames ON: every save and every post-new GET must open a frame (frame.opened 1), no request may
# report a miss, and a plain public GET that writes nothing must open none (LAZY: it pays nothing).
# Prints one MEASURE line per mode and exits 1 on any failure.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=local-spike-password
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
STATE=""
trap './run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"' EXIT
for mode in off on; do
  ./run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"
  STATE=$(mktemp -d "${TMPDIR:-/tmp}/frames-e2e.XXXXXX"); export PERSIST_TO=$STATE
  DEV_LOCAL=1 DEV_VARS="REQUEST_FRAMES:$mode" ./run.sh _ping > /dev/null || { echo "FAIL $mode: wrangler dev did not start"; bad=1; continue; }
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null
  ./e2e.sh "$B" > "build/frames-e2e-$mode.log" 2>&1; e=$?
  ok "$mode: e2e.sh (pages, login, admin, editor, REST write)" "$([ $e = 0 ] && echo 1 || echo 0)"
  B=$B ADMIN_PASSWORD=$PW python3 tests/woo.py > "build/frames-woo-$mode.log" 2>&1; w=$?
  ok "$mode: tests/woo.py (the store and a checkout)" "$([ $w = 0 ] && echo 1 || echo 0)"
  # The cost: log in, take the REST nonce from post-new.php, create one post, then time saves of it.
  T=$(mktemp -d); J=$T/jar
  curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"
  curl -s -c "$J" -b "$J" -o "$T/pn" "$B/wp-admin/post-new.php"
  N=$(grep -o 'createNonceMiddleware( "[a-f0-9]*' "$T/pn" | grep -o '[a-f0-9]*$')
  id=$(curl -s -c "$J" -b "$J" -H "X-WP-Nonce: $N" -H 'Content-Type: application/json' -d '{"title":"frame cost","content":"<p>v0</p>","status":"publish"}' "$B/?rest_route=/wp/v2/posts" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  : > "$T/perf"
  for i in $(seq 1 10); do
    curl -s -c "$J" -b "$J" "${ST[@]}" -D - -o /dev/null -H "X-WP-Nonce: $N" -H 'Content-Type: application/json' -d "{\"content\":\"<p>v$i $(head -c 2000 /dev/zero | tr '\0' x)</p>\"}" "$B/?rest_route=/wp/v2/posts/$id" | tr -d '\r' | grep -i -E '^(x-perf|x-db-rows):' | sed "s/^/save /" >> "$T/perf"
    curl -s -c "$J" -b "$J" "${ST[@]}" -D - -o /dev/null "$B/wp-admin/post-new.php" | tr -d '\r' | grep -i -E '^(x-perf|x-db-rows):' | sed "s/^/postnew /" >> "$T/perf"
    curl -s "${ST[@]}" -D - -o /dev/null "$B/?p=$id&nocache=$RANDOM" | tr -d '\r' | grep -i -E '^(x-perf|x-db-rows):' | sed "s/^/public /" >> "$T/perf"
  done
  python3 - "$T/perf" "$mode" <<'PY' > "$T/out"
import json, re, statistics, sys
rows = {}
for line in open(sys.argv[1]):
    kind, h, v = line.split(' ', 2)
    v = v.split(': ', 1)[1].strip() if ': ' in v else v.strip()
    r = rows.setdefault(kind, {'perf': [], 'written': []})
    if h.lower().startswith('x-perf'):
        r['perf'].append(json.loads(v))
    else:
        m = re.search(r'written=(\d+)', v)
        if m: r['written'].append(int(m.group(1)))
mode = sys.argv[2]
ok = True
for kind in ('save', 'postnew', 'public'):
    r = rows.get(kind, {'perf': [], 'written': []})
    p = r['perf']
    med = lambda k: statistics.median([x.get(k, 0) for x in p]) if p else None
    fr = [x.get('frame') for x in p]
    opened = sum(1 for f in fr if f and f.get('opened'))
    miss = sum((f or {}).get('miss', 0) for f in fr)
    written = statistics.median(r['written']) if r['written'] else None
    print('MEASURE %s %s n=%d dbMs_med=%s dbN_med=%s written_med=%s frames_opened=%d miss=%d' % (mode, kind, len(p), med('dbMs'), med('dbN'), written, opened, miss))
    bys = sorted(set((f or {}).get('by') for f in fr if f and f.get('by')))
    if bys: print('OPENED-BY %s %s: %s' % (mode, kind, ' | '.join(bys)))
    if mode == 'on':
        if miss: ok = False; print('BAD %s: %d frame misses' % (kind, miss))
        if kind in ('save', 'postnew') and opened != len(p): ok = False; print('BAD %s: %d of %d opened a frame' % (kind, opened, len(p)))
        if kind == 'public' and written == 0 and opened: ok = False; print('BAD public: a frame opened on a request that wrote nothing')
    elif any(fr): ok = False; print('BAD %s: a frame field with frames off' % kind)
print('OK' if ok else 'NOTOK')
PY
  cat "$T/out"
  ok "$mode: frame cost and laziness checks" "$(tail -1 "$T/out" | grep -qx OK && echo 1 || echo 0)"
  rm -rf "$T"
done
exit $bad
