#!/bin/bash
# deploy/wfp/tests/remote-assets-test.sh (#569): a REMOTE build is never uploaded without its assets.
# A build whose site-remote-index.js is non-null (SITE_REMOTE, site.zip EMPTY) or whose
# opcache-remote-index.js is non-null (OPCACHE_REMOTE) needs, in the config being uploaded,
# binding = "ASSETS" and run_worker_first with /_pf/*. Without the binding a site build has no files
# at all; without /_pf/ first the asset router serves the packs (the site's PHP source and compiled
# PHP) to anyone (#412). remote_assets_check refuses (exit 2) BEFORE the upload, at deploy time,
# not only at boot. A site build and its config must also agree on SITE_REMOTE.
# Exits 0 only when every check holds. Needs bash and python3 (tomllib).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
export NAMESPACE=test-ns SUB=sub
. "$LIB"
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/remote-assets.XXXXXX"); trap 'rm -rf "$T"' EXIT
app() { # app <dir> <site index json or null> <opcache index json or null>
  mkdir -p "$1/build"
  printf 'export default %s;\n' "$2" > "$1/build/site-remote-index.js"
  printf 'export default %s;\n' "$3" > "$1/build/opcache-remote-index.js"
}
SIDX='{"id":"b","hot":null,"packs":[],"files":{},"dirs":[]}'
OIDX='{"id":"b","packs":[],"files":{}}'
app "$T/plain" null null
app "$T/oc" null "$OIDX"
app "$T/site" "$SIDX" "$OIDX"
check() { remote_assets_check "$1" "$2" > /dev/null 2>&1; echo $?; }
# The real render, each way.
env -u OPCACHE_REMOTE -u SITE_REMOTE -u OPCACHE_SPLIT bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" > "$T/plain.toml"
OPCACHE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev > "$T/oc.toml"
SITE_REMOTE=1 OPCACHE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev > "$T/site.toml"
ok "a plain build with the plain render: allowed" "$([ "$(check "$T/plain.toml" "$T/plain")" = 0 ] && echo 1 || echo 0)"
ok "an OPCACHE_REMOTE build with its render: allowed" "$([ "$(check "$T/oc.toml" "$T/oc")" = 0 ] && echo 1 || echo 0)"
ok "a SITE_REMOTE build with its render: allowed" "$([ "$(check "$T/site.toml" "$T/site")" = 0 ] && echo 1 || echo 0)"
ok "a SITE_REMOTE build with the PLAIN render (no ASSETS binding): REFUSED, exit 2" "$([ "$(check "$T/plain.toml" "$T/site")" = 2 ] && echo 1 || echo 0)"
ok "an OPCACHE_REMOTE build with the plain render: REFUSED (the packs would be public or unreachable)" "$([ "$(check "$T/plain.toml" "$T/oc")" = 2 ] && echo 1 || echo 0)"
ok "a SITE_REMOTE build with an OPcache-only render (no SITE_REMOTE var): REFUSED (build and config disagree)" "$([ "$(check "$T/oc.toml" "$T/site")" = 2 ] && echo 1 || echo 0)"
ok "a SITE_REMOTE render over a plain build: REFUSED (build and config disagree)" "$([ "$(check "$T/site.toml" "$T/plain")" = 2 ] && echo 1 || echo 0)"
# The binding without /_pf/ first: the packs would be served to anyone.
sed '/^run_worker_first/d' "$T/site.toml" > "$T/nofirst.toml"
ok "a SITE_REMOTE build whose config lacks run_worker_first /_pf/*: REFUSED" "$([ "$(check "$T/nofirst.toml" "$T/site")" = 2 ] && echo 1 || echo 0)"
grep -q '^run_worker_first' "$T/site.toml"; rc=$?
ok "  (the control: the real render HAS run_worker_first)" "$([ $rc = 0 ] && echo 1 || echo 0)"
# A missing index file is a plain build (an old build/ from before #563).
mkdir -p "$T/old/build"
ok "a build from before #563 (no index files) with the plain render: allowed" "$([ "$(check "$T/plain.toml" "$T/old")" = 0 ] && echo 1 || echo 0)"
# Every user-script upload of a site build runs the check first (add, update, rollback).
W=$HERE/..
for f in "$W/site.sh" "$W/site"; do
  python3 -I - "$f" <<'PY'
import re, sys
src = open(sys.argv[1]).read().split('\n')
ups = [i for i, l in enumerate(src) if 'deploy --config' in l and '--dispatch-namespace' in l]
bad = [i + 1 for i in ups if not any('remote_assets_check' in l for l in src[max(0, i - 12):i])]
print('%s: %d upload(s), unchecked at line(s) %s' % (sys.argv[1].rsplit('/', 1)[-1], len(ups), bad or 'none'))
sys.exit(1 if bad or not ups else 0)
PY
  rc=$?
  ok "every user upload in $(basename "$f") runs remote_assets_check first" "$([ $rc = 0 ] && echo 1 || echo 0)"
done
echo "$fails failing check(s)"
exit $fails
