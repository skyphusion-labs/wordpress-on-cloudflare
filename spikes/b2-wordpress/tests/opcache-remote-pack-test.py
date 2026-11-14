#!/usr/bin/env python3
"""python3 -I spikes/b2-wordpress/tests/opcache-remote-pack-test.py  (#563, OPCACHE_REMOTE)
opcache-remote.py on a synthetic build: EVERY opcache.zip file goes to packs under _pf/<build-id>/,
in the order a cold boot reads them (the boot requests' first-read order, then later requests,
then the rest by path), opcache.zip is left empty, no boot pack exists, and the index gives each
pack's length and SHA-256. A trace that cannot be trusted, or an unsafe build id, is refused."""
import hashlib, json, os, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(HERE, '..', 'opcache-remote.py')
P = 'opcache:/internal/shared/opcache/'
fails = 0
def ok(label, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + label)
    fails += 0 if cond else 1

# Path order is a, b, c, d, e. The boot reads d, b; a later request reads e, b (b already counted);
# a and c are never read. So the cold-boot order is d, b, e, then a, c by path.
files = {'s/w/a.php.bin': b'A' * 4000, 's/w/b.php.bin': os.urandom(3000), 's/w/c.php.bin': b'C' * 5000, 's/w/d.php.bin': os.urandom(2000), 's/w/e.php.bin': b'E' * 6000}
ORDER = ['s/w/d.php.bin', 's/w/b.php.bin', 's/w/e.php.bin', 's/w/a.php.bin', 's/w/c.php.bin']

def setup(d, boot_reads=('s/w/d.php.bin', 's/w/b.php.bin'), later=('s/w/e.php.bin', 's/w/b.php.bin'), build_id='abc123-wooprimed', on=True, with_boot=True):
    b = os.path.join(d, 'build'); os.makedirs(os.path.join(b, 'public', '_pf', build_id), exist_ok=True)
    open(os.path.join(b, 'public', '_pf', build_id, 'stale.zip'), 'wb').write(b'old')
    with zipfile.ZipFile(os.path.join(b, 'opcache.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for n, data in files.items(): z.writestr(n, data)
    reqs = []
    if with_boot:
        reqs.append({'cls': 'front', 'boot': 1, 'reads': [['site:/wordpress/index.php', 1]] + [[P + n, 1] for n in boot_reads]})
    reqs.append({'cls': 'admin:index', 'boot': 0, 'reads': [[P + n, 1] for n in later]})
    json.dump({'on': on, 'dropped': 0, 'requests': reqs}, open(os.path.join(b, 'file-trace.json'), 'w'))
    open(os.path.join(b, 'build-id.js'), 'w').write('export default "%s";\n' % build_id)
    return b

def run(b, kib=None):
    env = dict(os.environ)
    if kib is not None: env['REMOTE_PACK_KIB'] = str(kib)
    return subprocess.run([sys.executable, '-I', PACK, os.path.join(b, 'opcache.zip'), os.path.join(b, 'file-trace.json'), os.path.join(b, 'build-id.js')], capture_output=True, text=True, env=env)

def index(b):
    p = os.path.join(b, 'opcache-remote-index.js')
    if not os.path.isfile(p): return {'packs': [], 'files': {}}
    return json.loads(open(p).read()[len('export default '):].rstrip(';\n'))

with tempfile.TemporaryDirectory() as d:
    b = setup(d)
    r = run(b, 0)  # 0 KiB: one file per pack, so the ORDER is visible pack by pack
    ok('packs (exit 0): ' + (r.stdout + r.stderr).strip()[:100], r.returncode == 0)
    ok('opcache.zip is left EMPTY (no OPcache file stays in the bundle)', os.path.isfile(os.path.join(b, 'opcache.zip')) and zipfile.ZipFile(os.path.join(b, 'opcache.zip')).namelist() == [])
    ok('no boot pack: opcache-boot-index.js is null (no split)', os.path.isfile(os.path.join(b, 'opcache-boot-index.js')) and open(os.path.join(b, 'opcache-boot-index.js')).read() == 'export default null;\n')
    idx = index(b)
    pdir = os.path.join(b, 'public', '_pf', 'abc123-wooprimed')
    got = [sorted(zipfile.ZipFile(os.path.join(pdir, pk['name'])).namelist()) for pk in idx['packs']] if idx['packs'] else []
    ok('the pack order is the cold-boot read order: boot first reads, then later reads, then the rest by path', got == [[n] for n in ORDER])
    ok('the index names the build id, and every file is in exactly one pack with its size', idx.get('id') == 'abc123-wooprimed' and sorted(idx['files']) == sorted(files) and all(idx['files'][n][1] == len(files[n]) for n in files))
    ok('each pack holds exactly the files the index puts in it, bytes unchanged', bool(idx['packs']) and all(
        sorted(zipfile.ZipFile(os.path.join(pdir, pk['name'])).namelist()) == sorted(n for n, (k, _) in idx['files'].items() if k == i)
        and all(zipfile.ZipFile(os.path.join(pdir, pk['name'])).read(n) == files[n] for n, (k, _) in idx['files'].items() if k == i)
        for i, pk in enumerate(idx['packs'])))
    ok('each pack length and SHA-256 match the index', bool(idx['packs']) and all(
        os.path.getsize(os.path.join(pdir, pk['name'])) == pk['bytes'] and hashlib.sha256(open(os.path.join(pdir, pk['name']), 'rb').read()).hexdigest() == pk['sha256'] for pk in idx['packs']))
    ok('a stale file of an earlier run under _pf/<id>/ is removed', not os.path.exists(os.path.join(pdir, 'stale.zip')))
with tempfile.TemporaryDirectory() as d:
    b = setup(d)
    r = run(b)
    ok('at the default 1024 KiB the small set fits ONE pack', r.returncode == 0 and len(index(b)['packs']) == 1)
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, on=False))
    ok('a trace recorded without FILE_TRACE=on is refused', r.returncode != 0 and not os.path.isfile(os.path.join(d, 'build', 'opcache-remote-index.js')))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, with_boot=False))
    ok('a trace with no booting request is refused (no cold-boot order to follow)', r.returncode != 0 and 'boot' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, later=('s/w/other-build.php.bin',)))
    ok('a trace from another build is refused', r.returncode != 0 and 'another build' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, build_id='../../evil'))
    ok('an unsafe build id is refused', r.returncode != 0 and 'not safe' in (r.stderr + r.stdout))
print('\n%d FAILED' % fails if fails else '\nALL PASS')
sys.exit(1 if fails else 0)
