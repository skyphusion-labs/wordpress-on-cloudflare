#!/bin/bash
# One site of the reference deployment (issue #35, deploy/wfp).
#   CLOUDFLARE_API_TOKEN=... deploy/wfp/site.sh up <name>
#   CLOUDFLARE_API_TOKEN=... deploy/wfp/site.sh down <name>
# up.sh and down.sh call it for each site; slice 3 makes it "site add/remove".
# The shared pieces (up.sh) must exist. b-dosql must be built (up.sh builds it).
#
# up, in the order of the #35 design (a KV entry must exist before its
# hostname is ever requested, or the "absent" answer is cached):
#   1. the site's Terraform workspace: media bucket, secrets, site map entry
#   2. the user Worker site-<name> in the namespace (b-dosql), with its secrets
#   3. the dispatcher copy wp-<name> on workers.dev: the site's hostname, and (#533) the daily
#      cron of its scheduled snapshot, with the site's SNAPSHOT_TOKEN
#   4. wait for the site, then install WordPress
# down, the other way round, each step checked against the API before the next:
#   1. the dispatcher copy (the hostname)   2. the user Worker
#   3. the bucket emptied, then the workspace destroyed (bucket, secrets, entry)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_account
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
cmd=${1:-}; s=${2:-}
valid_site "$s" || { echo "usage: site.sh up|down <name> (lower case, digits, hyphens; 1 to 30; not probe, not auto)" >&2; exit 2; }
umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$GEN"
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)
D=$(dispatcher_name "$s"); U=$(user_script "$s")
HOST="$(site_host "$s" "$SUB")"; ORIGIN="https://$HOST" # phase A workers.dev, phase B the Custom Domain (lib.sh)
# Phase B (#138): true attaches this site's Custom Domain (terraform); false
# (the default) is phase A, workers.dev only.
CD=$([ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo true || echo false)
VARS=(-var "name=$s" -var "hostname=$HOST" -var "kv_namespace_id=$KV_ID" -var "custom_domain=$CD")
# down: an existing site's workspace records its hostname, Custom Domain and
# zone (lib.sh site_vars); those win, so a remove of a site on its own apex
# detaches and deletes exactly what it has.
if [ "$cmd" = down ]; then
  tfr site init -input=false >/dev/null
  if tfr site workspace select "$s" >/dev/null 2>&1; then
    site_vars "$s" "$SUB" "$KV_ID" || exit 1
    HOST=$REC_HOST; ORIGIN="https://$HOST"; CD=$REC_CD; VARS=("${REC_VARS[@]}")
    [ "$CD" = true ] && WFP_CUSTOM_DOMAIN=1
    tfr site workspace select default >/dev/null
  fi
fi
# The id of the built bundle (build.sh writes build/build-id.js), recorded in
# the entry so "site update" has a rollback target (issue #35 slice 5). The
# config hash is recorded after the upload, once the rendered config and the
# secret key names exist (#421).
BUILD_ID=$(sed -n 's/export default "\(.*\)";/\1/p' "$APP/build/build-id.js" 2>/dev/null || true); BUILD_ID=${BUILD_ID:-unknown}
out() { tfr site output -raw "$1"; }
ws() { tfr site init -input=false >/dev/null && tfr site workspace select -or-create "$s" >/dev/null; }
gone() { # gone <what> <API path>: 404 or stop
  local c; c=$(api_code GET "$2")
  case "$c" in 404) echo "  $1 is gone (API 404)" ;; *) echo "  $1 is NOT gone (API $c): stopping" >&2; exit 1 ;; esac
}

if [ "$cmd" = up ]; then
  log "site $s: data plane and site map entry (workspace $s)"
  kv_wait_writable "$KV_ID"
  ws
  tfr site apply -input=false -auto-approve "${VARS[@]}" -var "build=$BUILD_ID" >/dev/null

  log "site $s: user Worker $U in $NAMESPACE"
  CONF="$APP/wrangler.deploy.wfp-$s.toml"
  render_user "$s" "$ORIGIN" > "$CONF"
  tfr site output -json | site_secrets_json "$W/secrets.json"
  # WP_VECTORIZE_SEARCH (#330): the binding needs its index to exist at deploy.
  if search_on; then ensure_search_index "$s" || { rm -f "$W/secrets.json"; exit 1; }; fi
  # #569: a remote build is never uploaded without its ASSETS binding and /_pf/ first.
  remote_assets_check "$CONF" "$APP" || { rm -f "$W/secrets.json"; exit 2; }
  bundle_size_check || exit 1
  (cd "$APP" && "$ROOT/deploy/wr" deploy --config "$CONF" --dispatch-namespace "$NAMESPACE" --secrets-file "$W/secrets.json") > "$W/user.log" 2>&1 \
    || { rm -f "$W/secrets.json"; tail -20 "$W/user.log"; exit 1; }
  # The salts exist only after the workspace apply above, so the hash is a second
  # apply. It records the hash next to the build id. If this apply fails, the
  # entry has no hash and the next site update uploads once.
  CH=$(config_hash "$CONF" "$W/secrets.json") || { rm -f "$W/secrets.json"; exit 1; }
  rm -f "$W/secrets.json"
  tfr site apply -input=false -auto-approve "${VARS[@]}" -var "build=$BUILD_ID" -var "config_hash=$CH" >/dev/null
  grep -E 'Total Upload|Current Version' "$W/user.log" || true

  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then
    log "site $s: phase B, routed by the shared $SHARED_DISPATCHER and this site's Custom Domain $HOST (attached by the workspace apply above)"
    log "site $s: its cron-only copy $D (no route, no workers.dev), for the scheduled snapshot (#533)"
    render_site_dispatcher "$s" "$KV_ID" cron-only > "$GEN/$D.toml"
    tfr site output -json | dispatcher_secrets_json "$W/disp-secrets.json"
    wrangler_deploy "$GEN" "$W/disp.log" --config "$D.toml" --secrets-file "$W/disp-secrets.json" || { rm -f "$W/disp-secrets.json"; tail -20 "$W/disp.log"; exit 1; }
    rm -f "$W/disp-secrets.json"
    cron_copy_check "$D" || exit 1
    echo "  $D: workers.dev and previews off, no Custom Domain (read back)"
  else
    log "site $s: dispatcher $D, with the scheduled snapshot of this site (#533)"
    render_site_dispatcher "$s" "$KV_ID" > "$GEN/$D.toml"
    tfr site output -json | dispatcher_secrets_json "$W/disp-secrets.json"
    wrangler_deploy "$GEN" "$W/disp.log" --config "$D.toml" --secrets-file "$W/disp-secrets.json" || { rm -f "$W/disp-secrets.json"; tail -20 "$W/disp.log"; exit 1; }
    rm -f "$W/disp-secrets.json"
    grep -q "$ORIGIN" "$W/disp.log" || { echo "the dispatcher did not deploy to $ORIGIN:" >&2; tail -5 "$W/disp.log" >&2; exit 1; }
  fi

  log "site $s: wait for $ORIGIN (the site itself, lib.sh wait_site), then install"
  wait_site "$ORIGIN"
  hdr() { printf 'header = "x-spike-token: %s"\nheader = "x-admin-password: %s"\n' "$(out spike_token)" "$(out admin_password)"; }
  curl -s -m 300 -X POST -K <(hdr) "$ORIGIN/_install" > "$W/install.json" || true
  python3 -c 'import json, sys
try:
    d = json.load(open(sys.argv[1])); print("  install:", str(d.get("installed") or d.get("out", ""))[-80:])
except ValueError:
    print("  install did not answer JSON:", open(sys.argv[1]).read()[:200]); sys.exit(1)' "$W/install.json"
  echo "site $s: up at $ORIGIN"
elif [ "$cmd" = down ]; then
  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then
    log "site $s: phase B, detach the Custom Domain $HOST first (CR #138 remove order: the hostname before the entry)"
    tfr site init -input=false >/dev/null
    if tfr site workspace select "$s" >/dev/null 2>&1; then
      tfr site destroy -input=false -auto-approve "${VARS[@]}" -target=cloudflare_workers_custom_domain.site >/dev/null || true
    fi
    log "site $s: its cron-only copy $D (#533)"
    case "$(api_code GET "/workers/scripts/$D")" in
      200) (cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name "$D" --force) > "$W/del.log" 2>&1 || tail -5 "$W/del.log"
           gone "cron-only copy $D" "/workers/scripts/$D" ;;
      404) echo "  no cron-only copy $D (a phase B site made before #533 has none)" ;;
      *) echo "  the cron-only copy $D cannot be read: stopping" >&2; exit 1 ;;
    esac
  else
    log "site $s: dispatcher $D (the hostname first)"
    (cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name "$D" --force) > "$W/del.log" 2>&1 || tail -5 "$W/del.log"
    gone "dispatcher $D" "/workers/scripts/$D"
  fi

  log "site $s: user Worker $U"
  api DELETE "/workers/dispatch/namespaces/$NAMESPACE/scripts/$U?force=true" > /dev/null || true
  # Not by the single GET's status (a deleted script can read 200 there): lib.sh ns_script_state.
  st=$(ns_script_state "$U")
  case "$st" in
    gone) echo "  user Worker $U is gone (not in the namespace list; the single GET is 404 or an empty record)" ;;
    *) echo "  user Worker $U is NOT known to be gone ($st): stopping" >&2; exit 1 ;;
  esac

  log "site $s: search index (after the user Worker that binds it)"
  remove_search_index "$s" || exit 1

  log "site $s: media bucket emptied, then the workspace destroyed"
  # A down never creates: no workspace means no data plane to remove.
  tfr site init -input=false >/dev/null
  if tfr site workspace select "$s" >/dev/null 2>&1; then
    # Empty the bucket with a temporary credential that can reach only that
    # bucket (lib.sh down_empty_bucket, #273).
    down_empty_bucket "$s"
    tfr site destroy -input=false -auto-approve "${VARS[@]}" >/dev/null
    tfr site workspace select default >/dev/null && tfr site workspace delete "$s" >/dev/null
  else
    echo "  no workspace $s: no data plane to remove (checked below)"
  fi
  gone "site map entry $HOST" "/storage/kv/namespaces/$KV_ID/values/$HOST"
  gone "bucket $(media_bucket "$s")" "/r2/buckets/$(media_bucket "$s")"
  rm -f "$APP/wrangler.deploy.wfp-$s.toml" "$GEN/$D.toml"
  echo "site $s: down"
else
  echo "usage: site.sh up|down <name>" >&2; exit 2
fi
