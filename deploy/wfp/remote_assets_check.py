#!/usr/bin/env python3
"""A REMOTE build is never uploaded without its assets (#569, #563, #412).

  remote_assets_check.py <rendered user config .toml> <app dir>

Reads <app>/build/site-remote-index.js and opcache-remote-index.js (a missing file is null: a build
from before #563). When either index is non-null, the config about to be uploaded must have
[assets] binding = "ASSETS" and run_worker_first holding "/_pf/*":
- without the binding, a SITE_REMOTE build has NO site files (site.zip is empty), and an
  OPCACHE_REMOTE build has no compiled PHP;
- without /_pf/ first, the asset router serves the packs (the site's PHP source and its compiled
  PHP) to anyone (#412).
A SITE_REMOTE build and its config must also agree: vars.SITE_REMOTE is "on" exactly when the
build's site index is non-null. Exit 0 allowed, 2 refused (the reason on stderr), 1 unreadable.

The config is the one render_user writes, read line by line as site_settings.py rendered_vars
does: no tomllib, because the deploys run on Conrad's laptop, whose python3 is 3.9 (measured
2026-11-14), and a guard that cannot run would refuse every deploy.
"""
import os, re, sys


def sections(text):
    """{section: {key: raw value}} for the single-line keys of a rendered config."""
    out, cur = {'': {}}, ''
    for line in text.splitlines():
        t = line.strip()
        if not t or t.startswith('#'):
            continue
        if t.startswith('[') and not t.startswith('[['):
            cur = t.strip('[]').strip()
            out.setdefault(cur, {})
            continue
        if t.startswith('[['):
            cur = '[[' + t.strip('[]').strip()  # an array table: never [assets] or [vars]
            continue
        m = re.match(r'^([A-Za-z0-9_]+)\s*=\s*(.*)$', t)
        if m:
            out.setdefault(cur, {})[m.group(1)] = m.group(2).strip()
    return out


def unq(v):
    v = (v or '').split('#', 1)[0].strip() if not (v or '').startswith(('"', "'")) else v
    m = re.match(r'^"([^"]*)"|^\'([^\']*)\'', v or '')
    return (m.group(1) if m.group(1) is not None else m.group(2)) if m else None


def index_on(path):
    if not os.path.isfile(path):
        return False
    s = open(path).read()
    m = re.search(r'export default (.*?);?\s*$', s, re.S)
    return bool(m) and m.group(1).strip() not in ('null', '')


def main():
    if len(sys.argv) != 3:
        print('usage: remote_assets_check.py <config.toml> <app dir>', file=sys.stderr)
        return 1
    conf, app = sys.argv[1], sys.argv[2]
    try:
        c = sections(open(conf).read())
    except OSError as e:  # an unreadable config is not a pass
        print('remote assets check: cannot read %s: %s' % (conf, e), file=sys.stderr)
        return 1
    site = index_on(os.path.join(app, 'build', 'site-remote-index.js'))
    opc = index_on(os.path.join(app, 'build', 'opcache-remote-index.js'))
    a = c.get('assets') or {}
    var_site = unq((c.get('vars') or {}).get('SITE_REMOTE')) == 'on'
    binding = unq(a.get('binding'))
    first = re.findall(r'"([^"]*)"', a.get('run_worker_first') or '')
    bad = []
    if site != var_site:
        bad.append('the build %s a SITE_REMOTE build but the config %s SITE_REMOTE = "on": build and config disagree'
                   % ('IS' if site else 'is NOT', 'has' if var_site else 'lacks'))
    if site or opc:
        kind = 'SITE_REMOTE' if site else 'OPCACHE_REMOTE'
        if binding != 'ASSETS':
            bad.append('an %s build needs [assets] binding = "ASSETS" (it has %r): %s' % (
                kind, binding, 'the site would have NO files' if site else 'the compiled PHP is unreachable'))
        if '/_pf/*' not in first:
            bad.append('an %s build needs run_worker_first = ["/_pf/*"]: without it the asset router serves the packs (PHP source and compiled PHP) to anyone (#412)' % kind)
    if bad:
        for b in bad:
            print('remote assets check: REFUSED: ' + b, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
