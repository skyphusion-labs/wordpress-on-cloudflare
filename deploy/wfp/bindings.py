#!/usr/bin/env python3
"""Read every script's bindings back from the API, and check that each binds
only its own site's resources (issue #35, slice 4).

  bindings.py <site>...

For each site <s>:
- the user Worker site-<s> (GET .../dispatch/namespaces/<ns>/scripts/site-<s>/bindings)
  may bind only: its own bucket (r2_bucket wp-wfp-<s>-media), its own
  Durable Object class (durable_object_namespace PhpRuntime, with no
  script_name or script_name site-<s>), images, assets (named ASSETS, and
  only on an OPCACHE_SPLIT=1 or OPCACHE_REMOTE=1 build, #412, #563), plain_text vars, and
  the secrets WP_SALT and SPIKE_TOKEN (secret_text), TURNSTILE_SECRET when Turnstile is
  wired (#340), and SNAPSHOT_TOKEN, the key of its scheduled snapshot (#533). It may ALSO bind the
  opinionated defaults wired through the provisioning descriptor table (#201): the
  Browser Rendering binding (browser), the Workers AI binding (ai), its own
  object-cache L2 namespace (kv_namespace named OC_KV), its own durable-email
  queue (queue with queue_name wp-wfp-<s>-email), its own pageview-analytics
  dataset (analytics_engine with dataset wp-wfp-<s>-analytics), and its own
  Vectorize search index (vectorize with index_name wp-wfp-<s>-search). Any other binding type (D1, a service, a dispatch
  namespace, a foreign queue or KV namespace, ...) fails.
- the dispatcher wp-<s> (GET .../workers/scripts/wp-<s>/settings) may bind
  only: the site map (kv_namespace SITES, id KV_ID) and the namespace
  (dispatch_namespace, namespace NAMESPACE, outbound only to
  wp-wfp-outbound). A site's copy also binds its scheduled snapshot (#533, lib.sh
  render_site_dispatcher), and only that: plain_text SNAPSHOT_SCRIPT naming its OWN user
  Worker (site-<s>), plain_text SNAPSHOT_TIMEOUT_MS (digits), and the secret SNAPSHOT_TOKEN.
A script whose bindings cannot be read fails: an unread script is not a pass.

Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NAMESPACE, KV_ID;
WFP_API overrides the API base (tests). Prints JSON (binding names and
types only, never a value) and exits 1 on any violation.
"""
import json, os, sys, urllib.error, urllib.request

ENV = os.environ
USER_OK = {"r2_bucket", "durable_object_namespace", "images", "assets", "send_email", "plain_text", "secret_text", "browser", "ai", "kv_namespace", "queue", "analytics_engine", "vectorize"}
# TURNSTILE_SECRET: the site's own Turnstile secret, set only when the run has it (#340).
SECRETS_OK = {"WP_SALT", "SPIKE_TOKEN", "TURNSTILE_SECRET", "SNAPSHOT_TOKEN"}  # SNAPSHOT_TOKEN: #533


def api(path):
    base = ENV.get("WFP_API") or "https://api.cloudflare.com/client/v4/accounts/" + ENV["CLOUDFLARE_ACCOUNT_ID"]
    req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + ENV["CLOUDFLARE_API_TOKEN"], "User-Agent": "wp-on-cf-wfp-bindings"})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None
    except (OSError, ValueError):
        return 0, None


def listed(d, key=None):
    r = (d or {}).get("result")
    if key and isinstance(r, dict):
        r = r.get(key)
    return r if isinstance(r, list) else None


def check_user(s, bs):
    bad = []
    for b in bs:
        t, n = b.get("type"), b.get("name")
        if t not in USER_OK:
            bad.append("%s binds %s %s: not allowed for a site" % ("site-" + s, t, n))
        elif t == "assets" and n != "ASSETS":
            bad.append("site-%s binds assets as %s, not ASSETS" % (s, n))
        elif t == "r2_bucket" and b.get("bucket_name") != "wp-wfp-%s-media" % s:
            bad.append("site-%s binds the bucket %s, not its own" % (s, b.get("bucket_name")))
        elif t == "durable_object_namespace" and (b.get("class_name") != "PhpRuntime" or b.get("script_name") not in (None, "", "site-" + s)):
            bad.append("site-%s binds the object class %s of script %s, not its own" % (s, b.get("class_name"), b.get("script_name")))
        elif t == "secret_text" and n not in SECRETS_OK:
            bad.append("site-%s has an unexpected secret %s" % (s, n))
        elif t == "queue" and b.get("queue_name") != "wp-wfp-%s-email" % s:
            bad.append("site-%s binds the queue %s, not its own" % (s, b.get("queue_name")))
        elif t == "kv_namespace" and n != "OC_KV":
            bad.append("site-%s binds a kv_namespace named %s, not its own OC_KV L2" % (s, n))
        elif t == "analytics_engine" and b.get("dataset") != "wp-wfp-%s-analytics" % s:
            bad.append("site-%s binds the analytics dataset %s, not its own" % (s, b.get("dataset")))
        elif t == "vectorize" and b.get("index_name") != "wp-wfp-%s-search" % s:
            bad.append("site-%s binds the vectorize index %s, not its own" % (s, b.get("index_name")))
    return bad


def check_dispatcher(s, bs):
    bad = []
    for b in bs:
        t, n = b.get("type"), b.get("name")
        if t == "kv_namespace":
            if n != "SITES" or b.get("namespace_id") != ENV["KV_ID"]:
                bad.append("wp-%s binds the KV namespace %s as %s, not the site map" % (s, b.get("namespace_id"), n))
        elif t == "dispatch_namespace":
            out = (b.get("outbound") or {}).get("worker") or {}
            if b.get("namespace") != ENV["NAMESPACE"]:
                bad.append("wp-%s binds the dispatch namespace %s" % (s, b.get("namespace")))
            elif b.get("outbound") and out.get("service") != "wp-wfp-outbound":
                bad.append("wp-%s sends its outbound to %s" % (s, out.get("service")))
        # #533: the scheduled snapshot of THIS site, and nothing wider.
        elif t == "plain_text" and n == "SNAPSHOT_SCRIPT":
            if b.get("text") != "site-" + s:
                bad.append("wp-%s binds SNAPSHOT_SCRIPT to %s, not its own site-%s" % (s, b.get("text"), s))
        elif t == "plain_text" and n == "SNAPSHOT_TIMEOUT_MS":
            if not str(b.get("text", "")).isdigit():
                bad.append("wp-%s binds SNAPSHOT_TIMEOUT_MS to a value that is not a number" % s)
        elif t == "secret_text" and n == "SNAPSHOT_TOKEN":
            pass
        else:
            bad.append("wp-%s binds %s %s: not allowed for a dispatcher" % (s, t, n))
    return bad


def main(sites):
    out, bad = {"sites": {}}, []
    for s in sites:
        rec = {}
        st, d = api("/workers/dispatch/namespaces/%s/scripts/site-%s/bindings" % (ENV["NAMESPACE"], s))
        ub = listed(d)
        if st != 200 or ub is None:
            bad.append("site-%s: its bindings cannot be read (HTTP %s)" % (s, st))
        else:
            rec["user"] = sorted("%s %s" % (b.get("type"), b.get("name")) for b in ub)
            bad += check_user(s, ub)
        st, d = api("/workers/scripts/wp-%s/settings" % s)
        db = listed(d, "bindings")
        if st != 200 or db is None:
            bad.append("wp-%s: its bindings cannot be read (HTTP %s)" % (s, st))
        else:
            rec["dispatcher"] = sorted("%s %s" % (b.get("type"), b.get("name")) for b in db)
            bad += check_dispatcher(s, db)
        out["sites"][s] = rec
    out["failed"] = bad
    print(json.dumps(out, indent=1))
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1:]))
