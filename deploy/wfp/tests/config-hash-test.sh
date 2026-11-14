#!/bin/bash
# site update uploads a same-build config change (#421).
# The old gate compared the build id only, so a PHP_INI or OBSERVABILITY change
# printed "nothing to do" and exited 0. The hash is the rendered user config
# plus the sorted secret key names. A secret value is not part of it.
#   deploy/wfp/tests/config-hash-test.sh
# Offline: a fake account, a fake S3, a stub terraform and a stub wrangler.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB="$HERE/../lib.sh"
SITE="$HERE/../site"
WFP=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$WFP/../.." && pwd)
# shellcheck disable=SC1090
. "$LIB"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] want [$3]"; fails=$((fails + 1)); fi; }
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# The old script has no update_upload_reasons. Show what its build-id gate does
# with each case, then stop. Running `site update` here would call build_dosql
# on the real app (APP is fixed until this change), so this is the check that
# can run on the old code.
if ! declare -F update_upload_reasons >/dev/null 2>&1 || ! declare -F config_hash >/dev/null 2>&1; then
  echo "OLD GATE: deploy/wfp/site decides from the build id alone:"
  grep -n 'nothing to do' "$SITE" || true
  old() { if [ "$1" = "$2" ] && [ "${3:-0}" != 1 ]; then echo "nothing to do"; else echo "upload"; fi; }
  echo "  same build + same config: $(old bld bld 0) (this case also skips on the old gate)"
  echo "  same build + changed PHP_INI: $(old bld bld 0) (want upload, reason: config changed)"
  echo "  same build + changed secret value: $(old bld bld 0) (this case also skips on the old gate; the value is not hashed)"
  echo "  same build + new secret key: $(old bld bld 0) (want upload)"
  echo "  no recorded hash: $(old bld bld 0) (want upload, reason: no recorded config hash)"
  echo "  FORCE_UPLOAD=1: $(old bld bld 1) (want upload, reason: forced; the old line says FORCE_UPLOAD=1, not reason: forced)"
  echo "FAIL update_upload_reasons or config_hash is not in lib.sh"
  exit 1
fi
ok "the build-id-only skip is gone" "$(grep -c 'if \[ "$new" = "$rollback" \] && \[ "${FORCE_UPLOAD:-0}" != 1 \]' "$SITE" | grep -qx 0 && echo 1 || echo 0)"

# The hash: rendered bytes plus sorted key names. Values never enter it, and never the output.
T=$(mktemp -d)
ACCT_PID=""
S3_PID=""
cleanup() {
  if [ -n "${ACCT_PID:-}" ]; then kill "$ACCT_PID" 2>/dev/null || true; wait "$ACCT_PID" 2>/dev/null || true; fi
  if [ -n "${S3_PID:-}" ]; then kill "$S3_PID" 2>/dev/null || true; wait "$S3_PID" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT
printf 'rendered-v1\n' > "$T/cfg"
printf '%s\n' '{"WP_SALT":"salt-value-aaa","SPIKE_TOKEN":"spike-value-bbb"}' > "$T/sec"
h1=$(config_hash "$T/cfg" "$T/sec" 2>"$T/hash.err") || { echo "FAIL config_hash rc $?"; cat "$T/hash.err"; exit 1; }
printf '%s\n' '{"SPIKE_TOKEN":"spike-value-bbb","WP_SALT":"salt-value-aaa"}' > "$T/sec-order"
h_order=$(config_hash "$T/cfg" "$T/sec-order")
check "key order does not change the hash" "$h_order" "$h1"
printf '%s\n' '{"WP_SALT":"salt-value-CHANGED","SPIKE_TOKEN":"spike-value-bbb"}' > "$T/sec-val"
h_val=$(config_hash "$T/cfg" "$T/sec-val")
check "a changed secret value does not change the hash" "$h_val" "$h1"
printf '%s\n' '{"SPIKE_TOKEN":"spike-value-bbb","TURNSTILE_SECRET":"turnstile-value-ccc","WP_SALT":"salt-value-aaa"}' > "$T/sec-key"
h_key=$(config_hash "$T/cfg" "$T/sec-key")
ok "a new secret key changes the hash" "$([ "$h_key" != "$h1" ] && echo 1 || echo 0)"
printf 'rendered-v2\n' > "$T/cfg2"
h_cfg=$(config_hash "$T/cfg2" "$T/sec")
ok "a changed rendered config changes the hash" "$([ "$h_cfg" != "$h1" ] && echo 1 || echo 0)"
ok "the hash is 64 hex characters" "$(printf '%s' "$h1" | grep -qxE '[0-9a-f]{64}' && echo 1 || echo 0)"
blob=$(printf '%s' "$h1 $h_order $h_val $h_key $h_cfg"; cat "$T/hash.err" 2>/dev/null)
ok "the hasher output has no secret value" "$(printf '%s' "$blob" | grep -cE 'salt-value-aaa|salt-value-CHANGED|spike-value-bbb|turnstile-value-ccc' | grep -qx 0 && echo 1 || echo 0)"
# A bad secrets file fails without echoing the body.
printf 'not-json salt-value-aaa\n' > "$T/bad"
config_hash "$T/cfg" "$T/bad" >"$T/bad.out" 2>"$T/bad.err" || true
ok "a bad secrets file does not print its body" "$(cat "$T/bad.out" "$T/bad.err" | grep -c 'salt-value-aaa' | grep -qx 0 && echo 1 || echo 0)"

# kv_build.py reads config_hash the same way it reads build. A missing field is empty.
# The code line has no trailing newline after it (lib.sh api's -w '\n%{http_code}').
kb() { printf '%s' "$1"$'\n'"200" | python3 "$WFP/kv_build.py" "$2"; }
check "kv_build.py config_hash" "$(kb '{"build":"bld","config_hash":"abc"}' config_hash)" "abc"
check "kv_build.py config_hash missing" "$(kb '{"build":"bld"}' config_hash)" ""
check "kv_build.py still defaults to build" "$(printf '%s' '{"build":"bld","config_hash":"abc"}'$'\n''200' | python3 "$WFP/kv_build.py")" "bld"

# update_upload_reasons: the three upload reasons, plus a missing hash.
check "same build, same hash: no reason" "$(update_upload_reasons b b "$h1" "$h1")" ""
check "same build, different hash: config changed" "$(update_upload_reasons b b "$h_cfg" "$h1")" "config changed"
check "missing hash: no recorded config hash" "$(update_upload_reasons b b "$h1" "")" "no recorded config hash"
check "different build: build changed" "$(update_upload_reasons n o "$h1" "$h1")" "build changed"
check "FORCE_UPLOAD=1: forced" "$(FORCE_UPLOAD=1 update_upload_reasons b b "$h1" "$h1")" "forced"
check "FORCE and a new build: both reasons" "$(FORCE_UPLOAD=1 update_upload_reasons n o "$h1" "$h1")" "build changed, forced"

# The real `site update`, with the build, terraform, S3 and the upload stubbed.
# Nothing here talks to Cloudflare.
unset PHP_INI PHP_RECYCLE MEM_LEDGER CRON_INTERVAL_MS OPCACHE_SPLIT OPCACHE_REMOTE SITE_REMOTE REMOTE_FETCH_CAP REMOTE_HOLD_KIB SITE_FETCH_CAP SITE_HOLD_KIB SITE_RETRY_MS REQUEST_FRAMES TURNSTILE_SITEKEY TURNSTILE_SECRET \
  TURNSTILE_WOO TURNSTILE_LOGIN TURNSTILE_COMMENTS OBSERVABILITY MAIL_FROM MAIL_FROM_NAME HTTP_ALLOW_HOSTS \
  WFP_PHP_ENV PHP_LOCATION LAZY_CACHE_MB LAZY_ARENA LAZY_ARENA_MB HEADROOM_PROBE WP_VECTORIZE_SEARCH FORCE_UPLOAD PLUGINS IMPORT_CONTENT IMPORT_THEMES \
  IMPORT_PLUGINS IMPORT_MU_PLUGINS FORCE_FAIL COUNT_ROWS WFP_CUSTOM_DOMAIN REPLACE_INPUTS || true
export WOO_ACTIVE=0 ALLOW_DIRTY=1 NO_SNAPSHOT=1 BUILD_WAIT=4 BUILD_POLL_S=0.2 BUILD_EVICT_AFTER=3
export ACCOUNT_ID=test-account CLOUDFLARE_API_TOKEN=test NAMESPACE=wp-wfp
export SALT=salt-value-aaa SPIKE=spike-value-bbb
APP="$T/app"
mkdir -p "$APP/build" "$APP/node_modules" "$APP/vendor" "$T/bin"
printf 'compatibility_date = "2026-07-01"\n' > "$APP/wrangler.toml"
ln -s "$ROOT/spikes/b2-wordpress/mail-from.mjs" "$APP/mail-from.mjs"
ln -s "$ROOT/spikes/b2-wordpress/http-allow.mjs" "$APP/http-allow.mjs"
: > "$APP/vendor/php_8_3.js"; : > "$APP/vendor/php_8_3.wasm"
: > "$APP/build/site.zip"; : > "$APP/build/opcache.zip"
printf 'export default "bld-same";\n' > "$APP/build/build-id.js"
cat > "$APP/build.sh" <<'SH'
#!/bin/bash
mkdir -p build vendor
printf 'export default "bld-same";\n' > build/build-id.js
: > build/site.zip; : > build/opcache.zip
: > vendor/php_8_3.js; : > vendor/php_8_3.wasm
echo built
SH
# prepare.sh runs on every build (#446). Without it every build here failed, and before #464 the
# update went on after the failed build, so this test passed on a build that never ran.
printf '#!/bin/bash\necho prepared\n' > "$APP/prepare.sh"; chmod +x "$APP/prepare.sh"
echo '#!/bin/bash' > "$APP/opcache.sh"
echo 'echo primed' >> "$APP/opcache.sh"
printf 'print("c00000001")\n' > "$APP/content-id.py"
chmod +x "$APP/build.sh" "$APP/opcache.sh"

STATE="$T/state.json"
cat > "$STATE" <<'JSON'
{"sites": {"shop": {"entry": "{\"script\":\"site-shop\",\"outbound\":true,\"build\":\"bld-same\"}"}}, "ns_list_shape": "top"}
JSON
python3 -I "$HERE/fake-account.py" "$T/port" "$STATE" >/dev/null 2>&1 & ACCT_PID=$!
cat > "$T/s3.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port_file = sys.argv[1]
store = {}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p in store:
            self._send(200, store[p])
        else:
            self._send(404, b"missing")
    def do_DELETE(self):
        store.pop(self.path.split("?", 1)[0], None)
        self._send(204, b"")
    def do_PUT(self):
        n = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(n) if n else b""
        store[self.path.split("?", 1)[0]] = body
        self._send(200, b"")
s = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
PY
python3 -I "$T/s3.py" "$T/s3port" >/dev/null 2>&1 & S3_PID=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && [ -s "$T/s3port" ] && break; sleep 0.1; done
[ -s "$T/port" ] && [ -s "$T/s3port" ] || { echo "FAIL the fake account or S3 did not start"; exit 1; }
export WFP_API="http://127.0.0.1:$(cat "$T/port")"
export WFP_S3_ENDPOINT="http://127.0.0.1:$(cat "$T/s3port")"
export WFP_S3_KEY_ID=test-s3-key WFP_S3_SECRET=test-s3-secret
export APP
REAL_CURL=$(PATH=/usr/bin:/bin command -v curl)
UPLOAD_LOG="$T/uploads"; APPLY_LOG="$T/applies"
: > "$UPLOAD_LOG"; : > "$APPLY_LOG"
SNAP_FILE="$T/snapshot-token-applied"; : > "$SNAP_FILE"
export UPLOAD_LOG APPLY_LOG SALT SPIKE SNAP_FILE
cat > "$T/bin/curl" <<EOF
#!/bin/bash
args="\$*"
# Only the site origin. The KV path also contains the workers.dev hostname.
if [[ "\$args" != *https://*.workers.dev* ]]; then
  exec $REAL_CURL "\$@"
fi
if [[ "\$args" == *rest_route* ]]; then
  printf '404'
elif [[ "\$args" == */_build* ]]; then
  printf '%s\n' '{"build":"bld-same"}'
else
  printf '200'
fi
EOF
cat > "$T/bin/terraform" <<'SH'
#!/bin/bash
case "$1" in
  init|workspace|state) 
    if [ "$1" = workspace ] && [ "$2" = list ]; then printf '* default\n  shop\n'; fi
    exit 0 ;;
  output)
    if [ "$2" = "-json" ]; then
      SALT="$SALT" SPIKE="$SPIKE" python3 -I -c 'import json,os; o={"wp_salt":{"value":os.environ["SALT"]},"spike_token":{"value":os.environ["SPIKE"]},"hostname":{"value":"wp-shop.sub.workers.dev"},"r2_endpoint":{"value":os.environ["WFP_S3_ENDPOINT"]}}
# #533: the snapshot token exists once the workspace has been applied with it (SNAP_FILE).
if os.path.exists(os.environ["SNAP_FILE"]): o["snapshot_token"]={"value":"snap-value-ddd"}
print(json.dumps(o))'
    else
      case "$3" in
        kv_namespace_id) printf kv1 ;;
        hostname) printf '%s' "wp-shop.sub.workers.dev" ;;
        spike_token) printf '%s' "$SPIKE" ;;
        snapshot_token) [ -e "$SNAP_FILE" ] || exit 1; printf '%s' snap-value-ddd ;;
        r2_endpoint) printf '%s' "$WFP_S3_ENDPOINT" ;;
        *) echo "stub terraform: unexpected output $*" >&2; exit 9 ;;
      esac
    fi ;;
  apply)
    printf '%s\n' "$*" >> "$APPLY_LOG"
    [ -n "${NO_SNAP_APPLY:-}" ] || : > "$SNAP_FILE"
    exit 0 ;;
  *) echo "stub terraform: unexpected $*" >&2; exit 9 ;;
esac
SH
cat > "$T/wr" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$UPLOAD_LOG"
# Do not read the secrets file. An upload log must not gain a secret value.
exit 0
SH
chmod +x "$T/bin/curl" "$T/bin/terraform" "$T/wr"
export PATH="$T/bin:$PATH" WR="$T/wr"

lines() { wc -l < "$1" | tr -d ' '; }
set_entry() { # set_entry <build> <hash or empty>
  python3 -I -c '
import json, sys
p, build, h = sys.argv[1], sys.argv[2], sys.argv[3]
s = json.load(open(p))
e = {"script": "site-shop", "outbound": True, "build": build}
if h:
    e["config_hash"] = h
s["sites"]["shop"]["entry"] = json.dumps(e, separators=(",", ":"))
with open(p, "w") as f:
    json.dump(s, f)
' "$STATE" "$1" "${2:-}"
}
last_hash() { sed -n 's/.*config_hash=\([0-9a-f]\{64\}\).*/\1/p' "$APPLY_LOG" | tail -1; }
no_secret() {
  local blob
  blob=$(printf '%s' "$OUT"; cat "$UPLOAD_LOG" "$APPLY_LOG")
  if printf '%s' "$blob" | grep -qE 'salt-value-aaa|salt-value-CHANGED|spike-value-bbb|turnstile-value-ccc'; then
    echo 0
  else
    echo 1
  fi
}
run_update() {
  OUT=$("$SITE" update shop 2>&1)
  RC=$?
}

# Direct read of a missing hash, the same call site update makes.
read_entry() { WFP_API="$WFP_API" CLOUDFLARE_API_TOKEN=test KV_ID=kv1 SUB=sub bash -c '. "'"$LIB"'"; entry_build shop; entry_config_hash shop'; }
got_entry=$(read_entry)
check "entry_build reads the recorded build" "$(printf '%s\n' "$got_entry" | sed -n 1p)" "bld-same"
check "entry_config_hash: a site with no hash reads empty" "$(printf '%s\n' "$got_entry" | sed -n 2p)" ""

# 1. No recorded hash: upload once, and say so.
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "no recorded hash: exit 0" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
ok "no recorded hash: reason stated" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: no recorded config hash' && echo 1 || echo 0)"
ok "no recorded hash: uploaded once" "$([ "$u1" = $((u0 + 1)) ] && echo 1 || echo 0)"
ok "no recorded hash: the apply records a config hash" "$([ "$a1" = $((a0 + 1)) ] && last_hash | grep -qxE '[0-9a-f]{64}' && echo 1 || echo 0)"
ok "no recorded hash: no secret in the output" "$(no_secret)"
H0=$(last_hash)
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 2. Same build, same config: nothing to do, no upload.
set_entry bld-same "$H0"
unset PHP_INI TURNSTILE_SECRET FORCE_UPLOAD
export SALT=salt-value-aaa
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "same config: exit 0" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
ok "same config: nothing to do" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: already at build bld-same; nothing to do' && echo 1 || echo 0)"
ok "same config: no upload and no apply" "$([ "$u1" = "$u0" ] && [ "$a1" = "$a0" ] && echo 1 || echo 0)"
ok "same config: no secret in the output" "$(no_secret)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 3. Same build, changed PHP_INI: upload, reason config changed.
set_entry bld-same "$H0"
export PHP_INI='{"opcache.memory_consumption":"48"}'
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "PHP_INI change: exit 0" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
ok "PHP_INI change: reason config changed" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: config changed' && echo 1 || echo 0)"
ok "PHP_INI change: uploaded" "$([ "$u1" = $((u0 + 1)) ] && [ "$a1" = $((a0 + 1)) ] && echo 1 || echo 0)"
ok "PHP_INI change: no secret in the output" "$(no_secret)"
H1=$(last_hash)
ok "PHP_INI change: the recorded hash differs from the previous one" "$([ -n "$H1" ] && [ "$H1" != "$H0" ] && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 4. Same build, same PHP_INI, secret VALUE only: no upload.
set_entry bld-same "$H1"
export SALT=salt-value-CHANGED
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "secret value only: nothing to do" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: already at build bld-same; nothing to do' && echo 1 || echo 0)"
ok "secret value only: no upload" "$([ "$RC" = 0 ] && [ "$u1" = "$u0" ] && [ "$a1" = "$a0" ] && echo 1 || echo 0)"
ok "secret value only: no secret in the output" "$(no_secret)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 5. Same build, a new secret key: upload.
set_entry bld-same "$H1"
export TURNSTILE_SECRET=turnstile-value-ccc
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "new secret key: reason config changed" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: config changed' && echo 1 || echo 0)"
ok "new secret key: uploaded" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && echo 1 || echo 0)"
ok "new secret key: no secret in the output" "$(no_secret)"
H2=$(last_hash)
ok "new secret key: the hash differs from the value-only hash" "$([ -n "$H2" ] && [ "$H2" != "$H1" ] && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 6. FORCE_UPLOAD=1 with the same build and the same config: upload, reason forced.
set_entry bld-same "$H2"
export FORCE_UPLOAD=1
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "FORCE_UPLOAD=1: reason forced" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: forced' && echo 1 || echo 0)"
ok "FORCE_UPLOAD=1: uploaded" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && echo 1 || echo 0)"
ok "FORCE_UPLOAD=1: no secret in the output" "$(no_secret)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 7. #533: a site recorded before the scheduled snapshot (no snapshot_token in its workspace): the
# update applies the workspace ONCE first, with the recorded build and hash, then uploads with
# SNAPSHOT_TOKEN (a new secret key name, so the hash changes: reason config changed).
unset FORCE_UPLOAD
# The hash such a site recorded: this config with the secret key names it had (no SNAPSHOT_TOKEN).
printf '{"WP_SALT":"x","SPIKE_TOKEN":"x","TURNSTILE_SECRET":"x"}' > "$T/old-sec.json"
HOLD=$(bash -c '. "'"$LIB"'"; config_hash "'"$APP"'/wrangler.deploy.wfp-shop.toml" "'"$T"'/old-sec.json"')
ok "  (the pre-#533 hash is a hash, and differs from the one with the token)" "$(printf '%s' "$HOLD" | grep -qxE '[0-9a-f]{64}' && [ "$HOLD" != "$H2" ] && echo 1 || echo 0)"
# 7a. The apply does not make the token (NO_SNAP_APPLY): the update stops before any upload.
set_entry bld-same "$HOLD"
rm -f "$SNAP_FILE"
u0=$(lines "$UPLOAD_LOG")
NO_SNAP_APPLY=1 run_update
u1=$(lines "$UPLOAD_LOG")
ok "no snapshot token after the apply: exit 1, nothing uploaded" "$([ "$RC" = 1 ] && [ "$u1" = "$u0" ] && printf '%s' "$OUT" | grep -Fq 'the snapshot token could not be made; nothing was uploaded' && echo 1 || echo 0)"
# 7b. The apply makes it.
set_entry bld-same "$HOLD"
rm -f "$SNAP_FILE"
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "no snapshot token yet: it says so, and applies the workspace first" "$(printf '%s' "$OUT" | grep -Fq 'site shop: the workspace has no snapshot token yet (#533)' && echo 1 || echo 0)"
ok "  that first apply carries the recorded build and hash, unchanged" "$(sed -n "$((a0 + 1))p" "$APPLY_LOG" | grep -Fq "build=bld-same" && sed -n "$((a0 + 1))p" "$APPLY_LOG" | grep -Fq "config_hash=$HOLD" && echo 1 || echo 0)"
ok "  then it uploads once (a new secret key: config changed), and records the new hash" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && [ "$a1" = $((a0 + 2)) ] && printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: config changed' && [ "$(last_hash)" != "$HOLD" ] && echo 1 || echo 0)"
ok "  no secret in the output (the snapshot token value included)" "$([ "$(no_secret)" = 1 ] && printf '%s' "$OUT" | grep -c snap-value-ddd | grep -qx 0 && echo 1 || echo 0)"
H3=$(last_hash)
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }
# 8. The token now exists: no extra apply.
set_entry bld-same "$H3"
a0=$(lines "$APPLY_LOG")
run_update
a1=$(lines "$APPLY_LOG")
ok "with the token: no extra apply, nothing to do" "$([ "$RC" = 0 ] && [ "$a1" = "$a0" ] && printf '%s' "$OUT" | grep -Fqx 'site shop: already at build bld-same; nothing to do' && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 9. #558: a site's env-only settings are recorded and kept. SREC is the record, LB the live bindings.
SREC="$WFP_S3_ENDPOINT/wp-wfp-shop-media/_build/settings.json"
srec_put() { printf '%s' "$1" | "$REAL_CURL" -s -o /dev/null -X PUT --data-binary @- "$SREC"; }
srec_del() { "$REAL_CURL" -s -o /dev/null -X DELETE "$SREC"; }
srec_get() { "$REAL_CURL" -s "$SREC"; }
live() { STATE="$STATE" B="$1" python3 -I -c 'import json, os; p = os.environ["STATE"]; d = json.load(open(p)); d["sites"]["shop"]["bindings"] = json.loads(os.environ["B"]); json.dump(d, open(p, "w"))'; }
conf_has() { grep -c "^$1 = " "$APP/wrangler.deploy.wfp-shop.toml" 2>/dev/null || true; }
unset PHP_INI TURNSTILE_SECRET FORCE_UPLOAD DROP_SETTINGS
PIN='{"opcache.memory_consumption":"32"}'
# 9a. The ggc-test case (2026-11-14): no record, the LIVE site has PHP_INI, this run does not set it.
srec_del; live '[{"type":"plain_text","name":"PHP_INI","text":"x"},{"type":"plain_text","name":"SITE_ORIGIN","text":"y"}]'
set_entry bld-other "$(last_hash)"
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "#558 no record, the live site has PHP_INI, the run drops it: REFUSED (exit 2), nothing uploaded" "$([ "$RC" = 2 ] && [ "$u1" = "$u0" ] && printf '%s' "$OUT" | grep -Fq 'the live site has PHP_INI, and this update would DROP it' && echo 1 || echo 0)"
[ "$RC" = 2 ] || { echo "$OUT" | tail -5 | sed 's/^/   /'; }
# 9b. The same with DROP_SETTINGS=PHP_INI: it uploads, and records the settings (no PHP_INI).
u0=$(lines "$UPLOAD_LOG")
DROP_SETTINGS=PHP_INI run_update
u1=$(lines "$UPLOAD_LOG")
ok "#558 DROP_SETTINGS=PHP_INI: the drop is on purpose: uploaded, and the record holds no PHP_INI" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && [ "$(conf_has PHP_INI)" = 0 ] && srec_get | python3 -I -c 'import json, sys; d = json.load(sys.stdin); sys.exit(0 if d["v"] == 1 and "PHP_INI" not in d["settings"] else 1)' && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | tail -5 | sed 's/^/   /'; }
# 9c. A run WITH PHP_INI: uploaded, and the record now holds it.
live '[{"type":"plain_text","name":"SITE_ORIGIN","text":"y"}]'
set_entry bld-other "$(last_hash)"
PHP_INI=$PIN run_update
ok "#558 a run that sets PHP_INI: uploaded with it, and the record holds it" "$([ "$RC" = 0 ] && [ "$(conf_has PHP_INI)" = 1 ] && srec_get | PIN=$PIN python3 -I -c 'import json, os, sys; d = json.load(sys.stdin); sys.exit(0 if d["settings"].get("PHP_INI") == os.environ["PIN"] else 1)' && echo 1 || echo 0)"
H5=$(last_hash)
# 9d. THE FIX: the next update does NOT set PHP_INI. It is kept from the record: same config, nothing to do.
live '[{"type":"plain_text","name":"PHP_INI","text":"x"},{"type":"plain_text","name":"SITE_ORIGIN","text":"y"}]'
set_entry bld-same "$H5"
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "#558 THE FIX: an update without PHP_INI keeps the recorded pin: the same config, nothing to do, no upload" "$([ "$RC" = 0 ] && [ "$u1" = "$u0" ] && printf '%s' "$OUT" | grep -Fq 'settings: PHP_INI kept from the record' && printf '%s' "$OUT" | grep -Fqx 'site shop: already at build bld-same; nothing to do' && [ "$(conf_has PHP_INI)" = 1 ] && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | tail -6 | sed 's/^/   /'; }
# 9e. A new build without PHP_INI: kept, uploaded with it.
set_entry bld-other "$H5"
run_update
ok "#558 a new build without PHP_INI in the run: uploaded WITH the recorded pin" "$([ "$RC" = 0 ] && [ "$(conf_has PHP_INI)" = 1 ] && grep -F 'PHP_INI = ' "$APP/wrangler.deploy.wfp-shop.toml" | grep -Fq '"32"' && echo 1 || echo 0)"
# 9f. A run that sets ANOTHER value replaces it, and says so.
set_entry bld-other "$(last_hash)"
PHP_INI='{"opcache.memory_consumption":"48"}' run_update
ok "#558 a run with another PHP_INI replaces the recorded one, and says so" "$([ "$RC" = 0 ] && printf '%s' "$OUT" | grep -Fq 'PHP_INI is set by this run (it replaces the recorded value)' && srec_get | grep -Fq '48' && echo 1 || echo 0)"
# 9g. A recorded secret the run does not have: refused before anything changes.
srec_put '{"v": 1, "settings": {}, "secrets": ["TURNSTILE_SECRET"]}'
set_entry bld-other "$(last_hash)"
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "#558 the site has TURNSTILE_SECRET and the run does not: REFUSED (exit 2), nothing uploaded" "$([ "$RC" = 2 ] && [ "$u1" = "$u0" ] && printf '%s' "$OUT" | grep -Fq 'a required secret is missing from this run' && echo 1 || echo 0)"
# 9h. Live bindings that cannot be read, on an upload: refused, never read as "nothing to drop".
srec_del
python3 -I -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["bindings_status"] = 500; json.dump(d, open(p, "w"))' "$STATE"
set_entry bld-other "$(last_hash)"
run_update
ok "#558 the live bindings cannot be read: REFUSED (exit 2)" "$([ "$RC" = 2 ] && printf '%s' "$OUT" | grep -Fq 'cannot be read' && echo 1 || echo 0)"
python3 -I -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); d.pop("bindings_status", None); json.dump(d, open(p, "w"))' "$STATE"
# 9i. A DROP_SETTINGS that names an unknown setting is refused.
DROP_SETTINGS=NOT_A_SETTING run_update
ok "#558 DROP_SETTINGS with an unknown name: REFUSED" "$([ "$RC" = 2 ] && echo 1 || echo 0)"
# 9j. The local -x list in site update is exactly lib.sh SITE_SETTINGS (a new setting cannot be missed).
want=$(bash -c '. "'"$LIB"'"; printf "%s\n" $SITE_SETTINGS' | sort | tr '\n' ' ')
got=$(sed -n '/^  local -x PHP_INI=/p' "$SITE" | grep -oE '[A-Z_]+="\$\{' | sed 's/="\${//' | sort | tr '\n' ' ')
pyl=$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings; print(" ".join(sorted(site_settings.SETTINGS)) + " ")' "$(dirname "$LIB")")
ok "#558 the settings list is the same in lib.sh, site update (local -x) and site_settings.py" "$([ -n "$want" ] && [ "$want" = "$got" ] && [ "$want" = "$pyl" ] && echo 1 || echo 0)"
# 9k. Measurement flags are never kept (the lead's ruling on #561): HEADROOM_PROBE KILLS the isolate,
# so after one measurement run it must go OFF by itself, said, and never refused.
srec_del; live '[{"type":"plain_text","name":"HEADROOM_PROBE","text":"on"},{"type":"plain_text","name":"SITE_ORIGIN","text":"y"}]'
set_entry bld-other "$(last_hash)"
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "#558 the live site has HEADROOM_PROBE and the run does not: NOT refused, uploaded WITHOUT it, and the log says it is now off" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && [ "$(conf_has HEADROOM_PROBE)" = 0 ] && printf '%s' "$OUT" | grep -Fq 'HEADROOM_PROBE was on and is now OFF: measurement flags are never kept' && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | tail -5 | sed 's/^/   /'; }
set_entry bld-other "$(last_hash)"
HEADROOM_PROBE=on MEM_LEDGER=on run_update
ok "#558 a run with HEADROOM_PROBE=on MEM_LEDGER=on renders them, and the record holds NEITHER" "$([ "$RC" = 0 ] && [ "$(conf_has HEADROOM_PROBE)" = 1 ] && [ "$(conf_has MEM_LEDGER)" = 1 ] && srec_get | python3 -I -c 'import json, sys; d = json.load(sys.stdin); sys.exit(0 if not {"HEADROOM_PROBE", "MEM_LEDGER", "WFP_PHP_ENV"} & set(d["settings"]) else 1)' && echo 1 || echo 0)"
live '[{"type":"plain_text","name":"HEADROOM_PROBE","text":"on"},{"type":"plain_text","name":"MEM_LEDGER","text":"on"},{"type":"plain_text","name":"SITE_ORIGIN","text":"y"}]'
set_entry bld-other "$(last_hash)"
run_update
ok "#558 the next run without them turns BOTH off, and says so for each" "$([ "$RC" = 0 ] && [ "$(conf_has HEADROOM_PROBE)" = 0 ] && [ "$(conf_has MEM_LEDGER)" = 0 ] && printf '%s' "$OUT" | grep -Fq 'HEADROOM_PROBE was on and is now OFF' && printf '%s' "$OUT" | grep -Fq 'MEM_LEDGER was on and is now OFF' && echo 1 || echo 0)"
DROP_SETTINGS=HEADROOM_PROBE run_update
ok "#558 DROP_SETTINGS naming a measurement flag is a no-op, not a refusal" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
srec_del; live '[{"type":"plain_text","name":"SITE_ORIGIN","text":"y"}]'
# 9l. THE GUARD for the next new setting: every env name render_user and its helpers read must be a
# recorded setting, or named here with why it is not. A new one fails this until it is listed.
derived=$(python3 -I - "$LIB" <<'PY2'
import re, sys
s = open(sys.argv[1]).read()
funcs = {m.group(1): m.group(2) for m in re.finditer(r'^([a-z_][a-z0-9_]*)\(\) \{(.*?)^\}', s, re.S | re.M)}
seen, todo, names = {"render_user"}, ["render_user"], set()
while todo:
    b = funcs[todo.pop()]
    names |= set(re.findall(r'\$\{?!?([A-Z][A-Z0-9_]+)', b))
    for m in re.findall(r'\bfor \w+ in ([A-Z0-9_ ]+);', b):
        names |= set(m.split())
    for g in funcs:
        if g not in seen and re.search(r'(?<![A-Za-z0-9_])' + g + r'(?![A-Za-z0-9_])', b):
            seen.add(g); todo.append(g)
names.add("HTTP_ALLOW_HOSTS")  # read by node http-allow.mjs, which render_user runs
print(" ".join(sorted(names)))
PY2
)
# Not settings: the deploy's own names (API, APP, the credential, the namespace, the phase B names, a
# constant). OBSERVABILITY: not recorded on purpose (client IPs). HTTP_ALLOW_HOSTS: #564 (three states).
# measurement flags: never recorded, by design (site_settings.py MEASUREMENT): ON only for the run.
measurement=" HEADROOM_PROBE MEM_LEDGER WFP_PHP_ENV "
notset=" API APP CLOUDFLARE_API_TOKEN NAMESPACE SEARCH_EMBED_PRESET SHARED_DISPATCHER WFP WFP_CUSTOM_DOMAIN WFP_SUBDOMAIN OBSERVABILITY HTTP_ALLOW_HOSTS$measurement"
settings=" $(bash -c '. "'"$LIB"'"; echo $SITE_SETTINGS') "
miss=""; for n in $derived; do case "$settings$notset" in *" $n "*) ;; *) miss="$miss $n" ;; esac; done
ok "#558 every env name render_user reads is a recorded setting or named with a reason (missing:${miss:- none})" "$([ -z "$miss" ] && [ -n "$derived" ] && printf '%s\n' $derived | grep -qx HEADROOM_PROBE && echo 1 || echo 0)"
pym=" $(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings; print(" ".join(sorted(site_settings.MEASUREMENT)))' "$(dirname "$LIB")") "
inset=0; for m in $measurement; do case "$settings" in *" $m "*) inset=1 ;; esac; done
ok "#558 the measurement flags named here are site_settings.py MEASUREMENT, and none is a recorded setting" "$([ "$pym" = "$measurement" ] && [ "$inset" = 0 ] && echo 1 || echo 0)"
unset PHP_INI DROP_SETTINGS HEADROOM_PROBE MEM_LEDGER

echo "$fails failing check(s)"
exit "$fails"
