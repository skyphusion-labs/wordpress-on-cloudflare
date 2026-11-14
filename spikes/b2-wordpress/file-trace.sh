#!/bin/bash
# Record which bundle files each request reads (#394 M0, file-trace.mjs). Run after ./build.sh and
# ./opcache.sh, so the trace sees the PRIMED build a site runs (a cold runtime loads the shipped
# OPcache files; a warm one should not need them).
#
# Starts wrangler dev with FILE_TRACE=on on a fresh local state, installs, activates WooCommerce
# (WOO_ACTIVE=1, as the store build), drives the pages e2e.sh and tests/woo.py drive plus the
# admin pages of #394, then saves GET /_trace to build/file-trace.json and stops the server.
# Summarize with: python3 file-trace-report.py build/file-trace.json
set -euo pipefail
cd "$(dirname "$0")"
[ -s build/opcache.zip ] || { echo "build/opcache.zip is missing or empty: run ./opcache.sh first"; exit 1; }
STATE=$(mktemp -d "${TMPDIR:-/tmp}/file-trace-state.XXXXXX")
export PERSIST_TO=$STATE
trap 'rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_VARS="FILE_TRACE:on${DEV_VARS:+ $DEV_VARS}" ./run.sh _ping > /dev/null
trap './run.sh --stop; rm -rf "$STATE"' EXIT
P=${PORT:-8797}
B=http://localhost:$P
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=${ADMIN_PASSWORD:-local-spike-password}
curl "${ST[@]}" -sf -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
if [ "${WOO_ACTIVE:-1}" = 1 ]; then
  curl "${ST[@]}" -sf -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" | grep -q '\\"active\\":true' || { echo "WooCommerce did not activate"; exit 1; }
fi
# Drop what install and activation read: the trace is for page traffic.
curl "${ST[@]}" -sf "$B/_trace" > /dev/null
./e2e.sh "$B" > build/file-trace-e2e.log 2>&1 || { echo "e2e failed, see build/file-trace-e2e.log"; exit 1; }
if [ "${WOO_ACTIVE:-1}" = 1 ]; then
  B=$B ADMIN_PASSWORD=$PW python3 tests/woo.py > build/file-trace-woo.log 2>&1 || { echo "woo.py failed, see build/file-trace-woo.log"; exit 1; }
fi
# The #394 admin pages, logged in, each twice (the second is warm).
J=$(mktemp "${TMPDIR:-/tmp}/file-trace-jar.XXXXXX")
curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"
for path in /wp-admin/ /wp-admin/profile.php '/wp-admin/post-new.php?post_type=page' /wp-admin/ /wp-admin/profile.php '/wp-admin/post-new.php?post_type=page' '/?post_type=product' '/?post_type=product' /; do
  code=$(curl -s -c "$J" -b "$J" -o /dev/null -w '%{http_code}' "$B$path")
  echo "$code $path" >> build/file-trace-admin.log
done
# #569 (#394 Gate 2): the GET screens of the 7-screen round (docs/admin-memory-matrix.md,
# admin-round.py), each COLD (POST /_install drops the runtime, so the next request boots one) then
# warm. Post 1 and page 2 are the ones a WordPress install makes. The profile SAVE (a POST with a
# nonce) is not traced.
for path in /wp-admin/ /wp-admin/post-new.php '/wp-admin/post-new.php?post_type=page' '/wp-admin/post.php?post=1&action=edit' '/wp-admin/post.php?post=2&action=edit' /wp-admin/profile.php; do
  curl "${ST[@]}" -s -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  for pass in cold warm; do
    code=$(curl -s -c "$J" -b "$J" -o /dev/null -w '%{http_code}' "$B$path")
    echo "$code $pass $path" >> build/file-trace-admin.log
  done
done
rm -f "$J"
curl "${ST[@]}" -sf "$B/_trace" > build/file-trace.json
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['on'], 'FILE_TRACE was not on'; print('file-trace.json:', len(d['requests']), 'requests,', d['dropped'], 'dropped')" build/file-trace.json
