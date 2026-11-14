#!/usr/bin/env python3
"""python3 -I spikes/b2-wordpress/tests/site-remote-pack-test.py  (#569, SITE_REMOTE)
site-remote.py on a synthetic build: the HOT set (files read by at least half of the warm requests)
goes to one site-hot.zip; every other site.zip file goes to st-<n>.zip packs in cold-boot read
order; site.zip is left empty; the index keeps every directory (empty ones too) and the length
and SHA-256 of each pack; the OPcache packs of opcache-remote.py beside them are NOT touched.
A trace that cannot be trusted, an unsafe build id, or a missing OPcache remote index is refused."""
import hashlib, json, os, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(HERE, '..', 'site-remote.py')
fails = 0
def ok(label, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + label)
    fails += 0 if cond else 1

W = 'wordpress/'
files = {W + 'index.php': b'<?php // index', W + 'wp-includes/theme.json': b'{"v":3}', W + 'wp-includes/a.php': os.urandom(3000),
         W + 'wp-includes/b.php': os.urandom(2000), W + 'wp-admin/c.php': os.urandom(4000), W + 'wp-content/d.php': b'D' * 5000}
S = lambda n: ['site:/' + W + n, 1]
# Warm requests: theme.json and index.php in 3 of 3 (hot); a.php in 1 of 3 (not hot).
# The boot reads index.php, theme.json, c, b; a later request reads a. Never read: d.
ORDER = [W + 'wp-admin/c.php', W + 'wp-includes/b.php', W + 'wp-includes/a.php', W + 'wp-content/d.php']
HOT = sorted([W + 'index.php', W + 'wp-includes/theme.json'])

def setup(d, build_id='abc123-wooprimed', on=True, with_boot=True, remote_index=True, extra_read=None):
    b = os.path.join(d, 'build'); pdir = os.path.join(b, 'public', '_pf', build_id); os.makedirs(pdir, exist_ok=True)
    open(os.path.join(pdir, 'oc-0.zip'), 'wb').write(b'opcache pack')
    open(os.path.join(pdir, 'st-9.zip'), 'wb').write(b'stale site pack')
    with zipfile.ZipFile(os.path.join(b, 'site.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(W, b''); z.writestr(W + 'wp-content/uploads/', b'')
        for n, data in files.items(): z.writestr(n, data)
    reqs = []
    if with_boot:
        reqs.append({'cls': 'front', 'boot': 1, 'reads': [S('index.php'), S('wp-includes/theme.json'), S('wp-admin/c.php'), S('wp-includes/b.php')]})
    reqs.append({'cls': 'front', 'boot': 0, 'reads': [S('index.php'), S('wp-includes/theme.json'), S('wp-includes/a.php')] + ([S(extra_read)] if extra_read else [])})
    reqs.append({'cls': 'front', 'boot': 0, 'reads': [S('index.php'), S('wp-includes/theme.json')]})
    reqs.append({'cls': 'admin:index', 'boot': 0, 'reads': [S('wp-includes/theme.json'), S('index.php')]})
    json.dump({'on': on, 'dropped': 0, 'requests': reqs}, open(os.path.join(b, 'file-trace.json'), 'w'))
    open(os.path.join(b, 'build-id.js'), 'w').write('export default "%s";\n' % build_id)
    if remote_index:
        open(os.path.join(b, 'opcache-remote-index.js'), 'w').write('export default {"id":"%s","packs":[],"files":{}};\n' % build_id)
    return b

def run(b, kib=None):
    env = dict(os.environ)
    if kib is not None: env['SITE_PACK_KIB'] = str(kib)
    return subprocess.run([sys.executable, '-I', PACK, os.path.join(b, 'site.zip'), os.path.join(b, 'file-trace.json'), os.path.join(b, 'build-id.js')], capture_output=True, text=True, env=env)

def index(b):
    p = os.path.join(b, 'site-remote-index.js')
    if not os.path.isfile(p): return {'packs': [], 'files': {}, 'dirs': [], 'hot': None}
    return json.loads(open(p).read()[len('export default '):].rstrip(';\n'))

with tempfile.TemporaryDirectory() as d:
    b = setup(d)
    r = run(b, 0)  # 0 KiB: one file per pack, so the ORDER is visible pack by pack
    ok('packs (exit 0): ' + (r.stdout + r.stderr).strip()[:100], r.returncode == 0)
    ok('site.zip is left EMPTY', os.path.isfile(os.path.join(b, 'site.zip')) and zipfile.ZipFile(os.path.join(b, 'site.zip')).namelist() == [])
    idx = index(b)
    pdir = os.path.join(b, 'public', '_pf', 'abc123-wooprimed')
    hot = idx.get('hot') or {}
    ok('the hot pack holds exactly the hot set', bool(hot) and sorted(zipfile.ZipFile(os.path.join(pdir, hot.get('name', 'x'))).namelist()) == HOT)
    ok('the index puts the hot files in pack -1', bool(idx['files']) and all(idx['files'][n][0] == -1 for n in HOT))
    got = [zipfile.ZipFile(os.path.join(pdir, pk['name'])).namelist() for pk in idx['packs']] if idx['packs'] else []
    ok('the other packs follow the cold-boot read order, then the rest by path', got == [[n] for n in ORDER])
    ok('every file is in the index once, with its size', sorted(idx['files']) == sorted(files) and all(idx['files'][n][1] == len(files[n]) for n in files))
    ok('every pack and the hot pack: length and SHA-256 match the index', bool(idx['packs']) and all(
        os.path.getsize(os.path.join(pdir, pk['name'])) == pk['bytes'] and hashlib.sha256(open(os.path.join(pdir, pk['name']), 'rb').read()).hexdigest() == pk['sha256']
        for pk in idx['packs'] + [hot]))
    ok('the directories are kept, the empty uploads/ too', 'wordpress/wp-content/uploads' in idx.get('dirs', []) and 'wordpress/wp-admin' in idx.get('dirs', []))
    ok('the bytes are unchanged', bool(idx['packs']) and all(
        (zipfile.ZipFile(os.path.join(pdir, hot['name'] if idx['files'][n][0] == -1 else idx['packs'][idx['files'][n][0]]['name'])).read(n) == files[n]) for n in files))
    ok('the OPcache pack beside them is NOT touched', open(os.path.join(pdir, 'oc-0.zip'), 'rb').read() == b'opcache pack')
    ok('a stale site pack of an earlier run is removed', not os.path.exists(os.path.join(pdir, 'st-9.zip')))
with tempfile.TemporaryDirectory() as d:
    b = setup(d)
    r = run(b)
    ok('at the default 512 KiB the small set fits ONE non-hot pack', r.returncode == 0 and len(index(b)['packs']) == 1)
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, remote_index=False))
    ok('no OPcache remote index (SITE_REMOTE needs OPCACHE_REMOTE): refused', r.returncode != 0 and 'OPCACHE_REMOTE' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, on=False))
    ok('a trace recorded without FILE_TRACE=on is refused', r.returncode != 0)
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, with_boot=False))
    ok('a trace with no booting request is refused', r.returncode != 0 and 'boot' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, extra_read='wp-includes/other-build.php'))
    ok('a trace from another build is refused', r.returncode != 0 and 'another build' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, build_id='../../evil'))
    ok('an unsafe build id is refused', r.returncode != 0 and 'not safe' in (r.stderr + r.stdout))
print('\n%d FAILED' % fails if fails else '\nALL PASS')
sys.exit(1 if fails else 0)
