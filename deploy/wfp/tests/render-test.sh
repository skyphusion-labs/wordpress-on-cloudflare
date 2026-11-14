#!/bin/bash
# Test of the rendered configs of deploy/wfp (issue #35), offline.
#   deploy/wfp/tests/render-test.sh [another lib.sh]
# - The dispatcher copies are ONE config (condition a): two sites' configs
#   differ in exactly one line, the name; no placeholder is left; both parse as
#   TOML and bind the site map, the namespace twice and the outbound Worker.
# - The user Worker config: its name, origin and bucket; the b-dosql Durable
#   Object and migration; the Workers Cache on; no workers.dev name.
# - The Workers Cache probe: one script for both copies, [cache] on, and the
#   namespace copy without a workers.dev name.
# - valid_site: the names it takes and refuses.
# Exits 0 only when every check holds. Needs bash, python3 (tomllib).
set -u
unset MAIL_FROM MAIL_FROM_NAME
unset HTTP_ALLOW_HOSTS
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
# shellcheck disable=SC1090
. "$LIB"
# A python3 with tomllib (3.11 or later); fail, never skip, without one.
PY=""
for p in "${PY_TOML:-}" python3 python3.14 python3.13 python3.12 python3.11; do
	[ -n "$p" ] && command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || { echo "FAIL no python3 with tomllib (3.11 or later) on PATH"; exit 1; }
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
render_dispatcher one kv123 > "$T/one.toml"
render_dispatcher two kv123 > "$T/two.toml"
render_dispatcher probe kv123 > "$T/probe.toml"
d=$(diff "$T/one.toml" "$T/two.toml" | grep -c '^[<>]')
ok "two sites' dispatcher configs differ in exactly one line each way (got $d)" "$([ "$d" = 2 ] && echo 1 || echo 0)"
ok "and that line is the name" "$(diff "$T/one.toml" "$T/two.toml" | grep '^[<>]' | grep -cv '^[<>] name = "wp-\(one\|two\)"$' | grep -qx 0 && echo 1 || echo 0)"
ok "no placeholder is left" "$(grep -q '@[A-Z_]*@' "$T/one.toml" "$T/probe.toml" && echo 0 || echo 1)"
ok "the dispatcher config parses and binds the map, the namespace twice and the outbound Worker" "$("$PY" -c '
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
ns = c["dispatch_namespaces"]
good = (c["name"] == "wp-one" and c["workers_dev"] is True and c["kv_namespaces"] == [{"binding": "SITES", "id": "kv123"}]
        and [n["binding"] for n in ns] == ["DISPATCHER", "DISPATCHER_OUT"] and all(n["namespace"] == "wp-wfp" for n in ns)
        and ns[1]["outbound"] == {"service": "wp-wfp-outbound", "parameters": ["SITE"]} and "outbound" not in ns[0])
print(1 if good else 0)' "$T/one.toml")"
render_user one https://wp-one.sub.workers.dev > "$T/user.toml"
ok "the user Worker config" "$("$PY" -c '
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
v = c["vars"]
good = (c["name"] == "site-one" and "workers_dev" not in c and c["cache"] == {"enabled": True}
        and c["exports"]["Pages"]["cache"] == {"enabled": True} and c["exports"]["default"]["cache"] == {"enabled": False}
        and v["SITE_ORIGIN"] == "https://wp-one.sub.workers.dev" and v["PHP_IN_DO"] == "on" and v["DB_IN_DO"] == "on"
        and v["HTTP_ALLOW_HOSTS"] == ".wordpress.org,.woocommerce.com,.gravatar.com"
        and c["r2_buckets"] == [{"binding": "MEDIA", "bucket_name": "wp-wfp-one-media"}]
        and c["durable_objects"]["bindings"] == [{"name": "PHP_RUNTIME", "class_name": "PhpRuntime"}]
        and c["migrations"] == [{"tag": "v1", "new_sqlite_classes": ["PhpRuntime"]}] and c["main"] == "index.js"
        and "MAIL_FROM" not in v and c["send_email"] == [{"name": "EMAIL"}])
print(1 if good else 0)' "$T/user.toml")"
render_user shop https://shop.example.co > "$T/shop.toml"
ok "a custom host sends as wordpress@host, and the binding allows only that address" "$("$PY" -c '
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
good = (c["vars"]["MAIL_FROM"] == "wordpress@shop.example.co"
        and c["send_email"] == [{"name": "EMAIL", "allowed_sender_addresses": ["wordpress@shop.example.co"]}])
print(1 if good else 0)' "$T/shop.toml")"
render_cacheprobe site-cacheprobe false > "$T/cp-ns.toml"
render_cacheprobe wp-cacheprobe-direct true > "$T/cp-direct.toml"
ok "the cache probe: one script, [cache] on, the namespace copy without workers.dev" "$("$PY" -c '
import sys, tomllib
a = tomllib.load(open(sys.argv[1], "rb")); b = tomllib.load(open(sys.argv[2], "rb"))
good = (a["name"] == "site-cacheprobe" and "workers_dev" not in a and b["name"] == "wp-cacheprobe-direct" and b["workers_dev"] is True
        and a["main"] == b["main"] == "../cache-probe/worker.js" and a["cache"] == b["cache"] == {"enabled": True})
print(1 if good else 0)' "$T/cp-ns.toml" "$T/cp-direct.toml")"
okn=1
for n in one two a-b a1 x23456789012345678901234567890; do valid_site "$n" || { okn=0; echo "  valid_site refused $n"; }; done
for n in "" -a a- A a_b a.b probe dispatch cacheprobe cacheprobe-direct auto wfp-outbound wfp-x x234567890123456789012345678901; do valid_site "$n" && { okn=0; echo "  valid_site took '$n'"; }; done
ok "valid_site takes 1 to 30 of [a-z0-9-] with no end hyphen, no shared Worker name, and not auto (#533)" "$okn"

# Derived, so a NEW shared Worker cannot be missed: every wp-<x> Worker name this tree
# deploys or deletes by a literal name (wrangler templates, --name, the shared
# dispatcher default) must be refused as a site name, because wp-<site> is a site's
# dispatcher and `site remove <x>` would delete the shared one.
# Two sources: literal deploy names, and the workers.dev hosts the checks probe
# (https://wp-<x>.<subdomain>), which is where wp-cacheprobe and wp-cacheprobe-direct
# are named. A templated name (wp-@SITE@, wp-$n, wp-%s) is per site and is not matched.
# cross.sh is left out of the host scan: its wp-crossa and wp-crossb are the
# dispatchers of two ordinary test SITES (crossa, crossb) it adds, not shared Workers.
shared=$( (cd "$WFP" && grep -rhoE '(name = "|--name "?|SHARED_DISPATCHER:-)wp-[a-z0-9-]+' --include='*.toml' --include='*.sh' --include=site --exclude-dir=gen . ;
  cd "$WFP" && grep -rhoE 'https://wp-[a-z0-9-]+\.' --include='*.py' --include='*.sh' --exclude-dir=tests --exclude=cross.sh . ) | sed -E 's/.*(wp-[a-z0-9-]*[a-z0-9]).*$/\1/' | sort -u)
okd=1; nd=0
for w in $shared; do nd=$((nd + 1)); valid_site "${w#wp-}" && { okd=0; echo "  valid_site takes '${w#wp-}', which makes the shared Worker $w"; }; done
[ "$nd" -ge 5 ] || { okd=0; echo "  found only $nd shared Worker name(s), want 5 or more; the scan is broken"; }
ok "every shared wp-<x> Worker in deploy/wfp ($nd found) is refused as a site name" "$okd"
# No default account (or zone) in the deploy tools: every entry point that sources
# lib.sh calls need_account, and no Terraform root defaults account_id. Derived, so
# a new entry script that forgets the check fails here.
okn=1; ne=0
for f in "$WFP"/*.sh "$WFP/site"; do
  [ "$(basename "$f")" = lib.sh ] && continue
  grep -q '^\. "$(dirname "$0")/lib.sh"$' "$f" || continue
  ne=$((ne + 1))
  grep -qx 'need_account' "$f" || { okn=0; echo "  $(basename "$f") sources lib.sh but does not call need_account"; }
done
[ "$ne" -ge 5 ] || { okn=0; echo "  found only $ne entry script(s); the scan is broken"; }
ok "every deploy/wfp entry script ($ne) calls need_account" "$okn"
okt=1
for r in site shared; do
  awk '/^variable "account_id"/,/^}/' "$WFP/terraform/$r/main.tf" | grep -q 'default' && { okt=0; echo "  terraform/$r: account_id has a default"; }
done
grep -q 'fabcb25d9c7eb087110ec474a03e50d2' "$WFP/lib.sh" "$WFP/terraform/site/main.tf" "$WFP/terraform/shared/main.tf" && { okt=0; echo "  a deploy default still carries the reference account id"; }
ok "no account default in lib.sh or the terraform roots (reference ids live in reference.env)" "$okt"
( ACCOUNT_ID=; need_account ) >/dev/null 2>&1; rc=$?
ok "need_account with no ACCOUNT_ID exits 2" "$([ "$rc" = 2 ] && echo 1 || echo 0)"
# Workers Logs (#291), privacy first: OBSERVABILITY=1 is EVENTS ONLY (our own structured lines and
# uncaught exceptions; invocation_logs false, so no client IP, URL or user agent is recorded). "full"
# keeps the invocation logs, for throwaways only. Off is an EXPLICIT enabled = false, so a re-upload
# really turns logging off (an absent block left a site as it was).
obs() { "$PY" -c 'import json, sys, tomllib; c = tomllib.loads(sys.stdin.read()); print(json.dumps(c.get("observability"), sort_keys=True))'; }
ok "off by default: [observability] enabled = false, explicitly" "$(env -u OBSERVABILITY bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | obs | grep -qx '{"enabled": false}' && echo 1 || echo 0)"
ok "OBSERVABILITY=0 is the same explicit off" "$(OBSERVABILITY=0 render_user one https://wp-one.sub.workers.dev | obs | grep -qx '{"enabled": false}' && echo 1 || echo 0)"
ok "OBSERVABILITY=1 is events only: enabled, invocation_logs false" "$(OBSERVABILITY=1 render_user one https://wp-one.sub.workers.dev | obs | grep -qx '{"enabled": true, "head_sampling_rate": 1, "logs": {"enabled": true, "invocation_logs": false}}' && echo 1 || echo 0)"
ok "OBSERVABILITY=full keeps the invocation logs (throwaways only)" "$(OBSERVABILITY=full render_user one https://wp-one.sub.workers.dev | obs | grep -qx '{"enabled": true, "head_sampling_rate": 1, "logs": {"enabled": true, "invocation_logs": true}}' && echo 1 || echo 0)"
ok "any other OBSERVABILITY value fails the render" "$(OBSERVABILITY=yes render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
# WP_VECTORIZE_SEARCH (#330): the AI and SEARCH_INDEX bindings for this site's own index only.
ok "render_user has no [ai] or [[vectorize]] by default" "$(render_user one https://wp-one.sub.workers.dev | grep -cE '^\[ai\]|^\[\[vectorize\]\]' | grep -qx 0 && echo 1 || echo 0)"
ok "WP_VECTORIZE_SEARCH=on renders AI and SEARCH_INDEX on wp-wfp-one-search" "$(WP_VECTORIZE_SEARCH=on render_user one https://wp-one.sub.workers.dev | tr '\n' ' ' | grep -q '\[ai\] binding = "AI" \[\[vectorize\]\] binding = "SEARCH_INDEX" index_name = "wp-wfp-one-search"' && echo 1 || echo 0)"
ok "WP_VECTORIZE_SEARCH=off renders neither" "$(WP_VECTORIZE_SEARCH=off render_user one https://wp-one.sub.workers.dev | grep -cE '^\[ai\]|^\[\[vectorize\]\]' | grep -qx 0 && echo 1 || echo 0)"
# PHP_INI (#394): a site rendered with it gets the var as compact sorted JSON; one without gets none.
phpini() { "$PY" -c 'import json, sys, tomllib; c = tomllib.loads(sys.stdin.read()); print(json.dumps(c["vars"].get("PHP_INI")))'; }
ok "no PHP_INI var without PHP_INI" "$(env -u PHP_INI bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | phpini | grep -qx 'null' && echo 1 || echo 0)"
ok "PHP_INI renders as one var, compact and sorted" "$(PHP_INI='{"opcache.memory_consumption": "48", "memory_limit": 256}' render_user one https://wp-one.sub.workers.dev | "$PY" -c 'import json, sys, tomllib; v = tomllib.loads(sys.stdin.read())["vars"]["PHP_INI"]; print(int(" " not in v and v.index("memory_limit") < v.index("opcache") and json.loads(v) == dict([("memory_limit", 256), ("opcache.memory_consumption", "48")])))')"
ok "PHP_INI with Turnstile: both render" "$(PHP_INI='{"opcache.memory_consumption":"52"}' TURNSTILE_SITEKEY=1x00000000000000000000AA render_user one https://wp-one.sub.workers.dev | "$PY" -c 'import sys, tomllib; v = tomllib.loads(sys.stdin.read())["vars"]; print(int(v["PHP_INI"] == "{\"opcache.memory_consumption\":\"52\"}" and v["TURNSTILE_SITEKEY"] == "1x00000000000000000000AA"))')"
for bad in 'not json' '[]' '{}' '"x"' '{"a b":"1"}' '{"opcache.x":true}' '{"opcache.x":1.5}' '{"opcache.x":null}' "{\"x\":\"it's\"}" '{"x":"a\"b"}' '{"x":"a\\b"}' '{"x":"a\nb"}'; do
  ok "PHP_INI refused: $bad" "$(PHP_INI=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
done
# LAZY_CACHE_MB (#394): an integer from 1 to 64, only when asked.
lcache() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("LAZY_CACHE_MB")))'; }
ok "no LAZY_CACHE_MB var by default" "$(env -u LAZY_CACHE_MB bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | lcache | grep -qx 'null' && echo 1 || echo 0)"
ok "LAZY_CACHE_MB=2 renders it as a string" "$(LAZY_CACHE_MB=2 render_user one https://wp-one.sub.workers.dev | lcache | grep -qx '"2"' && echo 1 || echo 0)"
ok "LAZY_CACHE_MB=08 renders 8 (no octal surprise)" "$(LAZY_CACHE_MB=08 render_user one https://wp-one.sub.workers.dev | lcache | grep -qx '"8"' && echo 1 || echo 0)"
ok "LAZY_CACHE_MB=64 renders it" "$(LAZY_CACHE_MB=64 render_user one https://wp-one.sub.workers.dev | lcache | grep -qx '"64"' && echo 1 || echo 0)"
for bad in 0 65 100 1.5 -2 abc "2 " 0x2; do ok "LAZY_CACHE_MB=$bad fails the render" "$(LAZY_CACHE_MB=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# LAZY_ARENA (#394 step 2): on or off, and LAZY_ARENA_MB 1 to 64, only when asked.
larena() { "$PY" -c 'import json, sys, tomllib; v = tomllib.loads(sys.stdin.read())["vars"]; print(json.dumps([v.get("LAZY_ARENA"), v.get("LAZY_ARENA_MB")]))'; }
ok "no LAZY_ARENA vars by default" "$(env -u LAZY_ARENA -u LAZY_ARENA_MB bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | larena | grep -qx '\[null, null\]' && echo 1 || echo 0)"
ok "LAZY_ARENA=on renders it" "$(LAZY_ARENA=on render_user one https://wp-one.sub.workers.dev | larena | grep -qx '\["on", null\]' && echo 1 || echo 0)"
ok "LAZY_ARENA=on LAZY_ARENA_MB=4 renders both" "$(LAZY_ARENA=on LAZY_ARENA_MB=4 render_user one https://wp-one.sub.workers.dev | larena | grep -qx '\["on", "4"\]' && echo 1 || echo 0)"
for bad in yes ON 1; do ok "LAZY_ARENA=$bad fails the render" "$(LAZY_ARENA=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
for bad in 0 65 1.5 abc; do ok "LAZY_ARENA_MB=$bad fails the render" "$(LAZY_ARENA=on LAZY_ARENA_MB=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# HEADROOM_PROBE (#394): on or off, only when asked.
headroom() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("HEADROOM_PROBE")))'; }
ok "no HEADROOM_PROBE var by default" "$(env -u HEADROOM_PROBE bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | headroom | grep -qx 'null' && echo 1 || echo 0)"
ok "HEADROOM_PROBE=on renders it" "$(HEADROOM_PROBE=on render_user one https://wp-one.sub.workers.dev | headroom | grep -qx '"on"' && echo 1 || echo 0)"
for bad in yes ON 1; do ok "HEADROOM_PROBE=$bad fails the render" "$(HEADROOM_PROBE=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# PHP_RECYCLE (#394 E1): only "off", only when asked.
recyc() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("PHP_RECYCLE")))'; }
ok "no PHP_RECYCLE var by default" "$(env -u PHP_RECYCLE bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | recyc | grep -qx 'null' && echo 1 || echo 0)"
ok "PHP_RECYCLE=off renders it" "$(PHP_RECYCLE=off render_user one https://wp-one.sub.workers.dev | recyc | grep -qx '"off"' && echo 1 || echo 0)"
for bad in on yes OFF 0; do ok "PHP_RECYCLE=$bad fails the render" "$(PHP_RECYCLE=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# CRON_INTERVAL_MS (#479): an integer from 60000 to 86400000, only when asked.
cint() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("CRON_INTERVAL_MS")))'; }
ok "no CRON_INTERVAL_MS var by default" "$(env -u CRON_INTERVAL_MS bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | cint | grep -qx 'null' && echo 1 || echo 0)"
ok "CRON_INTERVAL_MS=86400000 renders it as a string" "$(CRON_INTERVAL_MS=86400000 render_user one https://wp-one.sub.workers.dev | cint | grep -qx '"86400000"' && echo 1 || echo 0)"
ok "CRON_INTERVAL_MS=60000 (the floor) renders it" "$(CRON_INTERVAL_MS=60000 render_user one https://wp-one.sub.workers.dev | cint | grep -qx '"60000"' && echo 1 || echo 0)"
ok "CRON_INTERVAL_MS=0600000 renders 600000 (no octal surprise)" "$(CRON_INTERVAL_MS=0600000 render_user one https://wp-one.sub.workers.dev | cint | grep -qx '"600000"' && echo 1 || echo 0)"
for bad in 59999 0 86400001 100000000 1e6 -60000 abc "60000 " 6e4 0x15f90; do ok "CRON_INTERVAL_MS=$bad fails the render" "$(CRON_INTERVAL_MS=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# MEM_LEDGER (#394): on or off, only when asked.
mled() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("MEM_LEDGER")))'; }
ok "no MEM_LEDGER var by default" "$(env -u MEM_LEDGER bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | mled | grep -qx 'null' && echo 1 || echo 0)"
ok "MEM_LEDGER=on renders it" "$(MEM_LEDGER=on render_user one https://wp-one.sub.workers.dev | mled | grep -qx '"on"' && echo 1 || echo 0)"
ok "MEM_LEDGER=off renders it" "$(MEM_LEDGER=off render_user one https://wp-one.sub.workers.dev | mled | grep -qx '"off"' && echo 1 || echo 0)"
for bad in yes ON 1 true; do ok "MEM_LEDGER=$bad fails the render" "$(MEM_LEDGER=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# OPCACHE_SPLIT (#394 L1): the ASSETS binding and /_pf/ first only on a split build.
assets() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["assets"], sort_keys=True))'; }
ok "unsplit: [assets] is the directory only" "$(env -u OPCACHE_SPLIT bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | assets | grep -qx '{"directory": "build/public"}' && echo 1 || echo 0)"
ok "OPCACHE_SPLIT=0: [assets] is the directory only" "$(OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | assets | grep -qx '{"directory": "build/public"}' && echo 1 || echo 0)"
ok "OPCACHE_SPLIT=1: the ASSETS binding and run_worker_first /_pf/*" "$(OPCACHE_SPLIT=1 render_user one https://wp-one.sub.workers.dev | assets | grep -qx '{"binding": "ASSETS", "directory": "build/public", "run_worker_first": \["/_pf/\*"\]}' && echo 1 || echo 0)"
ok "OPCACHE_SPLIT=2 fails the render" "$(OPCACHE_SPLIT=2 render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
# OPCACHE_REMOTE (#563): ALL OPcache files remote, NO split. The var, the ASSETS binding and /_pf/ first
# on a remote build; never together with OPCACHE_SPLIT (the 2026-11-13 ruling keeps the split off).
ocr() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("OPCACHE_REMOTE")))'; }
ok "no OPCACHE_REMOTE var by default" "$(env -u OPCACHE_REMOTE -u OPCACHE_SPLIT bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | ocr | grep -qx 'null' && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=0: no var, [assets] is the directory only" "$(OPCACHE_REMOTE=0 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | ocr | grep -qx 'null' && OPCACHE_REMOTE=0 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | assets | grep -qx '{"directory": "build/public"}' && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=1 (unsplit) renders the var" "$(OPCACHE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | ocr | grep -qx '"on"' && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=1 (unsplit): the ASSETS binding and run_worker_first /_pf/*" "$(OPCACHE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | assets | grep -qx '{"binding": "ASSETS", "directory": "build/public", "run_worker_first": \["/_pf/\*"\]}' && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=1 with OPCACHE_SPLIT=1 fails the render (no split coupling)" "$(OPCACHE_REMOTE=1 OPCACHE_SPLIT=1 render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
for bad in 2 on yes; do ok "OPCACHE_REMOTE=$bad fails the render" "$(OPCACHE_REMOTE=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# SITE_REMOTE (#569): site.zip remote too. Only on top of OPCACHE_REMOTE=1 (its ASSETS binding, /_pf/ first).
sr() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("SITE_REMOTE")))'; }
ok "no SITE_REMOTE var by default" "$(env -u SITE_REMOTE OPCACHE_REMOTE=1 OPCACHE_SPLIT=0 bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | sr | grep -qx 'null' && echo 1 || echo 0)"
ok "SITE_REMOTE=1 with OPCACHE_REMOTE=1 renders it" "$(SITE_REMOTE=1 OPCACHE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | sr | grep -qx '"on"' && echo 1 || echo 0)"
ok "SITE_REMOTE=1 without OPCACHE_REMOTE=1 fails the render" "$(SITE_REMOTE=1 OPCACHE_REMOTE=0 render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
for bad in 2 on yes; do ok "SITE_REMOTE=$bad fails the render" "$(SITE_REMOTE=$bad OPCACHE_REMOTE=1 render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
# The remote tuning knobs (#569): rendered only when set, only with their flag, and only in range
# (the same ranges index.js accepts). pf570m (the lead's proof site) needs REMOTE_FETCH_CAP=0 (the
# cap0 compile boot) and SITE_HOLD_KIB=8192 rendered into a deploy/wfp site.
tv() { "$PY" -c 'import json, sys, tomllib; v = tomllib.loads(sys.stdin.read())["vars"]; print(json.dumps({k: v.get(k) for k in ("REMOTE_FETCH_CAP", "REMOTE_HOLD_KIB", "SITE_FETCH_CAP", "SITE_HOLD_KIB", "SITE_RETRY_MS")}, sort_keys=True))'; }
ok "no remote tuning var by default" "$(env -u REMOTE_FETCH_CAP -u REMOTE_HOLD_KIB -u SITE_FETCH_CAP -u SITE_HOLD_KIB -u SITE_RETRY_MS OPCACHE_REMOTE=1 SITE_REMOTE=1 OPCACHE_SPLIT=0 bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | tv | grep -qx '{"REMOTE_FETCH_CAP": null, "REMOTE_HOLD_KIB": null, "SITE_FETCH_CAP": null, "SITE_HOLD_KIB": null, "SITE_RETRY_MS": null}' && echo 1 || echo 0)"
ok "pf570m's knobs render: REMOTE_FETCH_CAP=0 and SITE_HOLD_KIB=8192" "$(REMOTE_FETCH_CAP=0 SITE_HOLD_KIB=8192 OPCACHE_REMOTE=1 SITE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | tv | grep -qx '{"REMOTE_FETCH_CAP": "0", "REMOTE_HOLD_KIB": null, "SITE_FETCH_CAP": null, "SITE_HOLD_KIB": "8192", "SITE_RETRY_MS": null}' && echo 1 || echo 0)"
ok "every knob renders in range" "$(REMOTE_FETCH_CAP=64 REMOTE_HOLD_KIB=4096 SITE_FETCH_CAP=96 SITE_HOLD_KIB=2048 SITE_RETRY_MS=50 OPCACHE_REMOTE=1 SITE_REMOTE=1 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev | tv | grep -qx '{"REMOTE_FETCH_CAP": "64", "REMOTE_HOLD_KIB": "4096", "SITE_FETCH_CAP": "96", "SITE_HOLD_KIB": "2048", "SITE_RETRY_MS": "50"}' && echo 1 || echo 0)"
ok "REMOTE_FETCH_CAP without OPCACHE_REMOTE=1 fails the render" "$(REMOTE_FETCH_CAP=10 OPCACHE_REMOTE=0 render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
ok "SITE_HOLD_KIB without SITE_REMOTE=1 fails the render" "$(SITE_HOLD_KIB=8192 OPCACHE_REMOTE=1 SITE_REMOTE=0 OPCACHE_SPLIT=0 render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"
for bad in "REMOTE_FETCH_CAP=1001" "REMOTE_FETCH_CAP=-1" "REMOTE_FETCH_CAP=6e1" "REMOTE_HOLD_KIB=65537" "SITE_FETCH_CAP=x" "SITE_HOLD_KIB=1.5" "SITE_RETRY_MS=5001"; do
  ok "$bad fails the render" "$(env "$bad" OPCACHE_REMOTE=1 SITE_REMOTE=1 OPCACHE_SPLIT=0 bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" >/dev/null 2>&1 && echo 0 || echo 1)"
done
# REQUEST_FRAMES (#352): on, off, or unset (no var).
rqf() { "$PY" -c 'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())["vars"].get("REQUEST_FRAMES")))'; }
ok "no REQUEST_FRAMES var by default" "$(env -u REQUEST_FRAMES bash -c ". '$LIB'; render_user one https://wp-one.sub.workers.dev" | rqf | grep -qx 'null' && echo 1 || echo 0)"
ok "REQUEST_FRAMES=on renders it" "$(REQUEST_FRAMES=on render_user one https://wp-one.sub.workers.dev | rqf | grep -qx '"on"' && echo 1 || echo 0)"
ok "REQUEST_FRAMES=off renders it" "$(REQUEST_FRAMES=off render_user one https://wp-one.sub.workers.dev | rqf | grep -qx '"off"' && echo 1 || echo 0)"
for bad in yes 1 ON; do ok "REQUEST_FRAMES=$bad fails the render" "$(REQUEST_FRAMES=$bad render_user one https://wp-one.sub.workers.dev >/dev/null 2>&1 && echo 0 || echo 1)"; done
echo "$fails failing check(s)"
exit $fails
