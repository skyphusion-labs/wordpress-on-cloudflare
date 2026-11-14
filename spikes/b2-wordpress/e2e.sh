#!/bin/bash
# End-to-end check against a running spike: pages, login, admin, editor, REST write.
# Usage: ./e2e.sh [base-url]   (default http://localhost:$PORT, PORT default 8797)
# Prints one line per request. Exits 1 if any request fails or reports D1 failures.
set -u
B=${1:-http://localhost:${PORT:-8797}}
PW=${ADMIN_PASSWORD:-local-spike-password}
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
T=$(mktemp -d); J=$T/jar; H=$T/h; bad=0
val() { grep -i "^$1:" "$H" | head -1 | cut -d: -f2- | tr -d ' \r'; }
row() {
  local code; code=$(head -1 "$H" | cut -d' ' -f2)
  printf "%-30s %s calls=%-4s d1ms=%-5s phpms=%-5s fail=%-2s %ss\n" "$1" "$code" "$(val x-d1-calls)" "$(val x-d1-ms)" "$(val x-php-ms)" "$(val x-d1-failures)" "$(cat "$T/t" 2>/dev/null)"; : > "$T/t"
  case "$code" in 2*|3*) ;; *) bad=1 ;; esac
  # A redirect must stay on this site. (PHP in a Durable Object once redirected
  # every logged-out page to http://<host>:443/, docs/approach-b.md 8i.)
  case "$code" in 3*) loc=$(val location); case "$loc" in "$B"/*|"$B"|/*|'') ;; *) echo "   redirect to another origin: $loc"; bad=1 ;; esac ;; esac
  f=$(val x-d1-failures); [ -z "$f" ] || [ "$f" = "0" ] || { bad=1; curl -s "${ST[@]}" "$B/_last" | python3 -c "
import json,sys
for f in json.load(sys.stdin).get('failures',[])[:3]: print('   ', f['error'][:140], '|', f['sql'][:160])"; }
}
get() { curl -s -c "$J" -b "$J" -o "$T/body" -D "$H" -w '%{time_total}' "$B$2" > "$T/t"; row "$1"; }
# Issue #578: every script and stylesheet a page loads from this site must answer a real body. build.sh
# keeps no .js of core in PHP's files, so a script PHP builds from them (load-scripts.php)
# answered 200 with one newline per handle, and wp-admin had no jQuery. Core sends
# load-scripts.php with a cache of one year, so a page must not ask for it at all: a browser
# that kept the empty answer would keep using it.
scripts_ok() {
  local label=$1 u code size out n=0
  if grep -qE 'load-(scripts|styles)\.php' "$T/body"; then echo "   $label asks for load-scripts.php or load-styles.php (#578)"; bad=1; fi
  for u in $(python3 -c "
import html, re, sys
b = sys.argv[1]
t = open(sys.argv[2]).read()
found = re.findall(r'<script[^>]*\ssrc=[\"\x27]([^\"\x27]+)', t) + re.findall(r'<link[^>]*rel=[\"\x27]stylesheet[\"\x27][^>]*\shref=[\"\x27]([^\"\x27]+)', t)
for s in sorted(set(html.unescape(m) for m in found)):
    if s.startswith(b + '/'): print(s)
    elif s.startswith('/') and not s.startswith('//'): print(b + s)
" "$B" "$T/body"); do
    n=$((n + 1))
    # Command substitution, not `read < <(...)`: macOS /bin/bash 3.2 keeps each process
    # substitution's descriptor open until the function returns, so ~256 assets in one call
    # exhausted the descriptor limit and the build died with SIGTRAP (Trace/BPT trap: 5).
    out=$(curl -s -b "$J" -o /dev/null -w '%{http_code} %{size_download}' "$u")
    code=${out%% *}; size=${out##* }
    if [ "$code" != 200 ] || [ "$size" -lt 32 ]; then echo "   $label file answered $code with $size bytes: $u"; bad=1; fi
  done
  echo "$label: $n scripts and stylesheets from this site checked"
  [ "$n" -gt 0 ] || { echo "   $label loads no script from this site"; bad=1; }
}
get 'GET /' /
[ "$(head -1 "$H" | cut -d' ' -f2)" = 200 ] || { echo "   GET / must answer 200"; bad=1; }
# WordPress links its pages from WP_HOME. A runtime booted with another origin
# links there (docs/approach-b.md 8i).
grep -q "$B/" "$T/body" || { echo "   GET / does not link to $B"; bad=1; }
# #578: core prints the emoji loader inline from wp-includes/js (file_get_contents). Empty if
# PHP's files do not hold it.
if grep -q 'wp-emoji-settings' "$T/body"; then
  grep -q 'script#wp-emoji-settings' "$T/body" && echo "emoji loader inline: present" || { echo "   GET / emoji loader inline script is empty (#578)"; bad=1; }
fi
get 'GET / (warm)' /
get 'GET /?p=1' '/?p=1'
get 'GET /?page_id=2' '/?page_id=2'
get 'GET /?feed=rss2' '/?feed=rss2'
get 'GET /?s=hello' '/?s=hello'
get 'GET /?cat=1' '/?cat=1'
get 'GET /?m=2026' "/?m=$(date -u +%Y)"
# #578: the embed scripts are printed inline from wp-includes/js too.
get 'GET embed page' '/?p=1&embed=true'
grep -q 'postMessage({message:' "$T/body" && echo "embed template script inline: present" || { echo "   embed page: wp-embed-template script is empty (#578)"; bad=1; }
get 'GET REST oembed' "/?rest_route=/oembed/1.0/embed&url=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1] + '/?p=1', safe=''))" "$B")"
grep -q 'receiveEmbedMessage' "$T/body" && echo "oembed wp-embed script inline: present" || { echo "   oembed html: wp-embed script is empty (#578)"; bad=1; }
get 'GET REST posts' '/?rest_route=/wp/v2/posts'
get 'GET wp-login.php' /wp-login.php
curl -s -c "$J" -b "$J" -o /dev/null -D "$H" --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"; row 'POST wp-login.php'
get 'GET /wp-admin/' /wp-admin/
scripts_ok 'GET /wp-admin/'
get 'GET post-new.php' '/wp-admin/post-new.php'
scripts_ok 'GET post-new.php'
N=$(grep -o 'createNonceMiddleware( "[a-f0-9]*' "$T/body" | grep -o '[a-f0-9]*$')
curl -s -c "$J" -b "$J" -o "$T/post" -D "$H" -H "X-WP-Nonce: $N" -H 'Content-Type: application/json' \
  -d '{"title":"Written to D1","content":"<!-- wp:paragraph --><p>This post lives in Cloudflare D1.</p><!-- /wp:paragraph -->","status":"publish"}' \
  "$B/?rest_route=/wp/v2/posts"; row 'POST REST create post'
id=$(python3 -c "import json; print(json.load(open('$T/post')).get('id',''))")
get 'GET new post' "/?p=$id"
grep -q 'This post lives in Cloudflare D1' "$T/body" && echo "new post content present" || { echo "new post content MISSING"; bad=1; }
get 'GET /wp-admin/edit.php' /wp-admin/edit.php
get 'GET upload.php' /wp-admin/upload.php
rm -rf "$T"
exit $bad
