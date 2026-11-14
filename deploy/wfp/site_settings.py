#!/usr/bin/env python3
"""The recorded per-site settings of a deploy/wfp site (#558).

lib.sh render_user reads a site's runtime settings from the run's environment only (PHP_INI,
LAZY_CACHE_MB, LAZY_ARENA, ...). A `site update` that did not export one dropped it: on
2026-11-14 ggc-test lost its PHP_INI opcache.memory_consumption 32 pin that way, and the update
said only "config changed". Now each good `site add` and `site update` records the run's settings
in the site's own media bucket, private outside uploads/ like _build/inputs.json (#379):

    _build/settings.json    {"v": 1, "settings": {NAME: value, ...}, "secrets": [NAME, ...]}

An update KEEPS a recorded setting the run does not set, uses the run's value when it sets one,
and drops one only when DROP_SETTINGS names it. A secret's VALUE is never recorded, only that the
site has it (TURNSTILE_SECRET): an update without it is refused unless DROP_SETTINGS names it.
OBSERVABILITY is not recorded on purpose: its logs record client IPs, so they stay on only when a
run asks again (lib.sh render_user).

    site_settings.py env-json                         this run's settings (stdout)
    site_settings.py get <bucket> <out.json>          exit 0 with the record, 3 when none
    site_settings.py put <bucket> <record.json>       write and read back
    site_settings.py merge <record.json>              the shell lines that keep the recorded
                                                      settings (stdout: export lines, a drop is
                                                      an empty value); what it did (stderr);
                                                      exit 5 when a recorded secret is missing
    site_settings.py dropcheck <user config> <bindings.json> <secrets.json>
                                                      exit 6 when the live script binds a setting
                                                      this run's config or secrets drop, unless
                                                      DROP_SETTINGS names it (the guard for a site
                                                      with no record yet, and any miss of merge)
DROP_SETTINGS: names separated by spaces or commas; each must be a known setting or exit 2.
"""
import json
import os
import re
import shlex
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snapshot  # noqa: E402

RECORD = "_build/settings.json"
# The env-only settings render_user reads (lib.sh), each rendered as a [vars] name of its own.
SETTINGS = ("PHP_INI", "LAZY_CACHE_MB", "LAZY_ARENA", "LAZY_ARENA_MB", "PHP_RECYCLE", "CRON_INTERVAL_MS",
            "TURNSTILE_SITEKEY", "TURNSTILE_WOO", "TURNSTILE_LOGIN", "TURNSTILE_COMMENTS",
            "MAIL_FROM", "MAIL_FROM_NAME", "PHP_LOCATION", "WP_VECTORIZE_SEARCH", "OPCACHE_SPLIT", "OPCACHE_REMOTE", "SITE_REMOTE",
            "REMOTE_FETCH_CAP", "REMOTE_HOLD_KIB", "SITE_FETCH_CAP", "SITE_HOLD_KIB", "SITE_RETRY_MS", "REQUEST_FRAMES")
# Measurement flags: never recorded, never kept, by design (the lead's ruling on #561). Silent
# persistence is the dangerous direction for them; silently going off is the safe one. A run that
# exports one turns it on for that upload; the next update without it turns it OFF, and says so.
#   HEADROOM_PROBE  GET /_headroom allocates until the isolate dies (#394): it KILLS the isolate.
#   MEM_LEDGER      "on" logs the isolate memory ledger on every request and cron leg: a steady
#                   log and CPU cost, for a diagnosis only.
#   WFP_PHP_ENV     a measurement build's PHP env (USE_ZEND_ALLOC=1 swaps PHP's allocator, #434).
MEASUREMENT = ("HEADROOM_PROBE", "MEM_LEDGER", "WFP_PHP_ENV")
SECRETS = ("TURNSTILE_SECRET",)
# No log line carries data from SECRETS: a message about a secret is one fixed text, and which
# secret, and what happened, is in the exit code (5 a recorded secret is missing, 6 a live one would
# be dropped). The only place SECRETS reaches is the record itself (env-json): names, never values.
# The settings the live bindings can show dropped: rendered only when set. MAIL_FROM and PHP_LOCATION
# always render (a default); WP_VECTORIZE_SEARCH and OPCACHE_SPLIT render
# bindings (AI and the index; ASSETS), not a var: the record keeps those.
DROPPABLE_VARS = ("PHP_INI", "LAZY_CACHE_MB", "LAZY_ARENA", "LAZY_ARENA_MB", "PHP_RECYCLE", "CRON_INTERVAL_MS",
                  "TURNSTILE_SITEKEY", "TURNSTILE_WOO", "TURNSTILE_LOGIN", "TURNSTILE_COMMENTS",
                  "MAIL_FROM_NAME", "OPCACHE_REMOTE", "SITE_REMOTE",
                  "REMOTE_FETCH_CAP", "REMOTE_HOLD_KIB", "SITE_FETCH_CAP", "SITE_HOLD_KIB", "SITE_RETRY_MS", "REQUEST_FRAMES")  # each renders its var only when on (#563, #569)


def drop_list(env=os.environ):
    names = [x for x in re.split(r"[\s,]+", env.get("DROP_SETTINGS", "") or "") if x]
    bad = [x for x in names if x not in SETTINGS + SECRETS + MEASUREMENT]  # a measurement flag: a no-op
    if bad:
        print("site settings: DROP_SETTINGS names an unknown setting: %s (known: %s, and the Turnstile secret)" % (" ".join(bad), " ".join(SETTINGS)), file=sys.stderr)
        sys.exit(2)
    return set(names)


def env_json(env=os.environ):
    return {"v": 1, "settings": {k: env[k] for k in SETTINGS if env.get(k)}, "secrets": [k for k in SECRETS if env.get(k)]}


def merge(record, env=os.environ):
    drop = drop_list(env)
    lines, rc = [], 0
    for k, v in sorted((record.get("settings") or {}).items()):
        if k not in SETTINGS:
            print("  settings: the record has %s, which is not a known setting: ignored" % k, file=sys.stderr)
        elif k in drop:
            lines.append("export %s=''" % k)
            print("  settings: %s DROPPED on purpose (DROP_SETTINGS)" % k, file=sys.stderr)
        elif env.get(k):
            print("  settings: %s is set by this run%s" % (k, "" if env[k] == v else " (it replaces the recorded value)"), file=sys.stderr)
        else:
            lines.append("export %s=%s" % (k, shlex.quote(str(v))))
            print("  settings: %s kept from the record" % k, file=sys.stderr)
    for k in record.get("secrets") or []:
        if k not in SECRETS:
            continue
        if k in drop:
            print("  settings: a recorded secret is DROPPED on purpose (DROP_SETTINGS)", file=sys.stderr)
        elif not env.get(k):
            print("  settings: a required secret is missing from this run: export it, or drop it on purpose with DROP_SETTINGS (deploy/wfp/README.md, #558); refused", file=sys.stderr)
            rc = 5
    # A drop is an empty value, never unset: the caller holds these as local -x (update --all runs
    # many sites), and every render function reads an empty value as not set.
    for k in sorted(drop - set(record.get("settings") or {}) - set(record.get("secrets") or [])):
        lines.append("export %s=''" % k)
    print("\n".join(lines))
    return rc


def rendered_vars(conf_text):
    out, on = set(), False
    for line in conf_text.splitlines():
        s = line.strip()
        if s.startswith("["):
            on = s == "[vars]"
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*=", s)
        if on and m:
            out.add(m.group(1))
    return out


def dropcheck(conf_path, bindings_path, secrets_path, env=os.environ):
    drop = drop_list(env)
    try:
        live = json.load(open(bindings_path))
        live = live.get("result") if isinstance(live, dict) else live
    except (OSError, ValueError):
        live = None
    if not isinstance(live, list):
        print("site settings: the live bindings cannot be read, so a dropped setting cannot be ruled out; refused", file=sys.stderr)
        return 6
    plain = {b.get("name") for b in live if isinstance(b, dict) and b.get("type") == "plain_text"}
    secret = {b.get("name") for b in live if isinstance(b, dict) and b.get("type") == "secret_text"}
    now_vars = rendered_vars(open(conf_path).read())
    now_secrets = set(json.load(open(secrets_path)))
    # A measurement flag going off is allowed, and said: it is never kept.
    for k in MEASUREMENT:
        if k in plain and k not in now_vars:
            print("site settings: %s was on and is now OFF: measurement flags are never kept" % k, file=sys.stderr)
    lost = sorted(k for k in DROPPABLE_VARS if k in plain and k not in now_vars and k not in drop)
    lost_secret = any(k in secret and k not in now_secrets and k not in drop for k in SECRETS)
    if lost or lost_secret:
        what = " ".join(lost + (["a required secret"] if lost_secret else []))
        print("site settings: the live site has %s, and this update would DROP it: export it, or drop it on purpose with DROP_SETTINGS=\"%s\"; refused" % (what, " ".join(lost + (["TURNSTILE_SECRET"] if lost_secret else []))), file=sys.stderr)
        return 6
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "env-json":
        print(json.dumps(env_json(), sort_keys=True)); return 0
    if cmd == "get":
        st, b = snapshot.s3("GET", "/%s/%s" % (argv[2], RECORD))
        if st == 404:
            return 3
        if st != 200:
            print("site settings: cannot read %s/%s (HTTP %s)" % (argv[2], RECORD, st), file=sys.stderr); return 1
        try:
            d = json.loads(b)
        except ValueError:
            print("site settings: %s/%s is not JSON" % (argv[2], RECORD), file=sys.stderr); return 1
        json.dump(d, open(argv[3], "w")); return 0
    if cmd == "put":
        body = open(argv[3], "rb").read()
        st, _ = snapshot.s3("PUT", "/%s/%s" % (argv[2], RECORD), body)
        g, b = snapshot.s3("GET", "/%s/%s" % (argv[2], RECORD))
        if st not in (200, 201) or g != 200 or b != body:
            print("site settings: the record did not store (PUT %s, read back %s)" % (st, g), file=sys.stderr); return 1
        return 0
    if cmd == "merge":
        return merge(json.load(open(argv[2])))
    if cmd == "dropcheck":
        return dropcheck(argv[2], argv[3], argv[4])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
