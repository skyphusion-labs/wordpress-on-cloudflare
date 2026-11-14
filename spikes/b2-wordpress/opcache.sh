#!/bin/bash
# Precompile PHP for the Worker. Boots the Worker locally (wrangler dev) with an
# empty OPcache, runs e2e.sh (and tests/woo.py) so real pages, login, admin
# and the store compile their
# scripts, then saves the OPcache file cache to build/opcache.zip.
# The same PHP build runs locally and on Cloudflare, so the files match.
# Run after ./build.sh, then deploy.
set -euo pipefail
cd "$(dirname "$0")"
python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
# #394 L1: priming runs unsplit; a split from an earlier run would point at other files.
rm -f build/opcache-boot.zip
echo 'export default null;' > build/opcache-boot-index.js
echo 'export default null;' > build/opcache-remote-index.js  # #563: priming runs with no remote packs
rm -rf build/public/_pf
# A fresh, empty local state for every run (#313). With the default .wrangler/state, WooCommerce
# was primed whenever an EARLIER run on this machine had left it active, so the same tree made a
# 2131-file cache on one laptop and a 620-file one on a fresh clone, and the fresh-clone build
# exceeded memory on every request of a store. WOO_ACTIVE decides it now, nothing else.
STATE=$(mktemp -d "${TMPDIR:-/tmp}/opcache-state.XXXXXX")
export PERSIST_TO=$STATE
trap 'rm -rf "$STATE"' EXIT
# No recycle for memory while priming (index.js, PHP_RECYCLE): one runtime must
# compile everything, or the dump holds only what compiled after a recycle.
# --local (#371): priming compiles PHP and needs no remote binding. Without it the env's AI binding
# starts a remote proxy session, which needs a login (none on a runner) and would run on the deploy token.
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off${DEV_VARS:+ $DEV_VARS}" ./run.sh _ping > /dev/null
# Stop the server this run started, however the script ends (run.sh records it).
# Before this, a failed step exited under set -e before the kill, and the server
# stayed on the port for the next run.
trap './run.sh --stop; rm -rf "$STATE"' EXIT
P=${PORT:-8797}
SERVER=$(cut -d' ' -f1 ".dev-$P.pid")
# The isolate before any page (the dump answers 409 with its id): the dump at the
# end must come from the same one. A reload by wrangler dev makes a new isolate.
hdr() { grep -i "^$1:" "$2" | tr -d '\r' | awk '{print $2}'; }
curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -D build/opcache.headers.start -o /dev/null localhost:$P/_opcache-dump
ISO0=$(hdr x-isolate build/opcache.headers.start)
[ -n "$ISO0" ] || { echo "/_opcache-dump gave no x-isolate before the pages: no OPcache files saved"; exit 1; }
curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -sf -X POST -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" localhost:${PORT:-8797}/_install > /dev/null   # "already" when installed
# WOO_ACTIVE=1: activate WooCommerce (its files are in every build, WOO=1).
if [ "${WOO_ACTIVE:-0}" = 1 ]; then
  curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -sf -X POST -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" "localhost:${PORT:-8797}/_activate?plugin=woocommerce/woocommerce.php" | grep -q '\\"active\\":true' || { echo "WooCommerce did not activate"; exit 1; }
fi
./e2e.sh > build/opcache-e2e.log 2>&1 || { echo "e2e failed; no OPcache files saved. Last lines of build/opcache-e2e.log:"; tail -15 build/opcache-e2e.log; exit 1; }
# WooCommerce pages too, when it is active (tests/woo.py buys a product).
if curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -sf "localhost:${PORT:-8797}/?rest_route=/wc/store/v1/cart" > /dev/null; then
  B=http://localhost:${PORT:-8797} ADMIN_PASSWORD=local-spike-password python3 tests/woo.py > /dev/null || { echo "woo.py failed; no OPcache files saved"; exit 1; }
elif [ "${WOO_ACTIVE:-0}" = 1 ]; then
  echo "WOO_ACTIVE=1 but the WooCommerce Store API did not answer: the store pages were not primed. No OPcache files saved (#313)"; exit 1
fi
# Plugins from the suite in this build (PLUGINS, see build.sh): activate and
# exercise each one so its scripts compile too.
if [ -n "${PLUGINS:-}" ]; then
  B=http://localhost:${PORT:-8797} ADMIN_PASSWORD=local-spike-password python3 ../../tests/plugins/plugins.py $PLUGINS > build/opcache-plugins.jsonl || { echo "plugins.py failed; no OPcache files saved"; exit 1; }
fi
# The dump must come from the server that ran the pages above.
now=$(lsof -t -nP -iTCP:"$P" -sTCP:LISTEN 2>/dev/null | sort -u | head -1)
[ "$now" = "$SERVER" ] || { echo "the server on port $P changed during the run (pid $SERVER, now ${now:-none}): no OPcache files saved"; exit 1; }
code=$(curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -D build/opcache.headers -o build/opcache.zip.new -w '%{http_code}' localhost:$P/_opcache-dump)
iso=$(hdr x-isolate build/opcache.headers); drops=$(hdr x-runtime-drops build/opcache.headers)
[ "$iso" = "$ISO0" ] || { echo "/_opcache-dump came from another isolate ($ISO0 at the start, now ${iso:-none}): wrangler dev reloaded the worker during the run (a file it watches changed). No OPcache files saved."; exit 1; }
if [ "$code" = 409 ]; then
  echo "/_opcache-dump: 409 not booted ($drops runtime drops). The runtime was dropped after the pages ran: recycled (memory or a crash, see x-runtime-recycled) or a failed request. No OPcache files saved. Last lines of dev.log:"
  grep -v '^\s*$' dev.log | tail -5 | cut -c1-200
  exit 1
fi
[ "$code" = 200 ] || { echo "/_opcache-dump answered $code: no OPcache files saved"; exit 1; }
# A runtime dropped during the run took the files it compiled: the dump would
# hold only what compiled after the drop.
[ "$drops" = 0 ] || { echo "/_opcache-dump: $drops runtime drops during priming (a recycle, a crash or a failed request): the OPcache would hold only what compiled after the last one. No OPcache files saved."; exit 1; }
files=$(python3 -c "import zipfile, sys; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))" build/opcache.zip.new)
[ "$files" -gt 0 ] || { echo "/_opcache-dump gave an empty zip: no OPcache files saved"; exit 1; }
# Never ship the compiled eval file of php.run (#294). It changes on every php.run, and with
# validate_timestamps=0 a shipped copy made EVERY php.run on a deployed site run the priming
# run's last script (the install answered nothing). index.js blacklists it; this refuses a
# dump that still holds it, so a regression fails the build instead of the deploy.
if python3 -c "import zipfile, sys; sys.exit(0 if any(n.endswith('internal/eval.php.bin') for n in zipfile.ZipFile(sys.argv[1]).namelist()) else 1)" build/opcache.zip.new; then
  echo "/_opcache-dump holds internal/eval.php.bin (the php.run eval file): no OPcache files saved (#294)"; exit 1
fi
# The floor (#313): a WooCommerce build must hold the WooCommerce scripts, or the store compiles
# them inside the 128 MiB isolate on every request.
python3 opcache-check.py build/opcache.zip.new "${WOO_ACTIVE:-0}" || { echo "No OPcache files saved"; exit 1; }
mv build/opcache.zip.new build/opcache.zip
echo "opcache.zip $(wc -c < build/opcache.zip) bytes, $files files, isolate $iso, 0 runtime drops, $(grep -i '^x-files' build/opcache.headers | tr -d '\r')"
