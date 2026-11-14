#!/usr/bin/env python3
"""python3 -I spikes/b2-wordpress/tests/opcache-split-test.py  (#394 L1)
opcache-split.py on a synthetic build: the warm files stay in opcache.zip, every other file goes to
the boot pack (module and asset chunk), nothing is lost or doubled, and a trace too thin to trust,
a trace from another build, or an unsafe build id is refused."""
import io, json, os, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SPLIT = os.path.join(HERE, '..', 'opcache-split.py')
fails = 0
def ok(label, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + label)
    fails += 0 if cond else 1

def setup(d, files, warm_reads, nwarm=12, build_id='abc123-wooprimed', on=True):
    b = os.path.join(d, 'build'); os.makedirs(b, exist_ok=True)
    with zipfile.ZipFile(os.path.join(b, 'opcache.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for n, data in files.items(): z.writestr(n, data)
    reqs = [{'cls': 'front', 'boot': 1, 'reads': [['opcache:/internal/shared/opcache/' + n, 1] for n in files]}]
    for i in range(nwarm):
        reqs.append({'cls': 'front', 'boot': 0, 'reads': [['opcache:/internal/shared/opcache/' + n, 1] for n in warm_reads] + [['site:/wordpress/index.php', 1]]})
    json.dump({'on': on, 'dropped': 0, 'requests': reqs}, open(os.path.join(b, 'file-trace.json'), 'w'))
    open(os.path.join(b, 'build-id.js'), 'w').write('export default "%s";\n' % build_id)
    return b

def run(b):
    return subprocess.run([sys.executable, '-I', SPLIT, os.path.join(b, 'opcache.zip'), os.path.join(b, 'file-trace.json'), os.path.join(b, 'build-id.js')], capture_output=True, text=True)

files = {'sys/wordpress/wp-settings.php.bin': b'A' * 5000, 'sys/wordpress/wp-includes/x.php.bin': b'B' * 7000, 'sys/wordpress/wp-admin/y.php.bin': b'C' * 9000, 'sys/wordpress/z.php.bin': os.urandom(3000)}
warm = ['sys/wordpress/wp-settings.php.bin', 'sys/wordpress/wp-includes/x.php.bin']
with tempfile.TemporaryDirectory() as d:
    b = setup(d, files, warm)
    r = run(b)
    ok('a good trace splits (exit 0): ' + r.stdout.strip()[:90], r.returncode == 0)
    w = zipfile.ZipFile(os.path.join(b, 'opcache.zip'))
    ok('opcache.zip holds exactly the warm files', sorted(w.namelist()) == sorted(warm))
    boot = sorted(set(files) - set(warm))
    ok('no fallback module is written (#411: a bundled module costs memory even unimported)', not os.path.exists(os.path.join(b, 'opcache-boot.zip')))
    chz = zipfile.ZipFile(os.path.join(b, 'public', '_pf', 'abc123-wooprimed', 'boot-0.zip'))
    ok('the bytes are unchanged', all(w.read(n) == files[n] for n in warm) and all(chz.read(n) == files[n] for n in boot))
    idx = json.loads(open(os.path.join(b, 'opcache-boot-index.js')).read()[len('export default '):].rstrip(';\n'))
    ok('the index names the build id, the chunk and the file count', idx['id'] == 'abc123-wooprimed' and idx['chunks'] == ['boot-0.zip'] and idx['files'] == len(boot))
    chunk = os.path.join(b, 'public', '_pf', 'abc123-wooprimed', 'boot-0.zip')
    ok('the asset chunk holds the boot files', os.path.isfile(chunk) and sorted(zipfile.ZipFile(chunk).namelist()) == boot)
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, files, warm, nwarm=3))
    ok('a trace with too few warm requests is refused', r.returncode != 0 and 'not enough' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, files, warm + ['sys/wordpress/other-build.php.bin']))
    ok('a trace from another build is refused', r.returncode != 0 and 'another build' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, files, warm, build_id='../../evil'))
    ok('an unsafe build id is refused', r.returncode != 0 and 'not safe' in (r.stderr + r.stdout))
with tempfile.TemporaryDirectory() as d:
    r = run(setup(d, files, warm, on=False))
    ok('a trace recorded without FILE_TRACE=on is refused', r.returncode != 0)
# #563 (OPCACHE_REMOTE=1): --remote moves the WARM files to packs too; opcache.zip is left empty.
import hashlib
def run_remote(b, kib):
    env = dict(os.environ, REMOTE_PACK_KIB=str(kib))
    return subprocess.run([sys.executable, '-I', SPLIT, os.path.join(b, 'opcache.zip'), os.path.join(b, 'file-trace.json'), os.path.join(b, 'build-id.js'), '--remote'], capture_output=True, text=True, env=env)
def rindex(b):
    if not os.path.isfile(os.path.join(b, 'opcache-remote-index.js')): return {'packs': [], 'files': {}}
    return json.loads(open(os.path.join(b, 'opcache-remote-index.js')).read()[len('export default '):].rstrip(';\n'))
with tempfile.TemporaryDirectory() as d:
    b = setup(d, files, warm)
    r = run(b)
    ok('without --remote the remote index is null (the default build is unchanged)', r.returncode == 0 and os.path.isfile(os.path.join(b, 'opcache-remote-index.js')) and open(os.path.join(b, 'opcache-remote-index.js')).read() == 'export default null;\n')
with tempfile.TemporaryDirectory() as d:
    b = setup(d, files, warm)
    r = run_remote(b, 0)  # 0 KiB: every file starts a new pack, so the split across packs is exercised
    ok('--remote splits (exit 0): ' + r.stdout.strip()[:90], r.returncode == 0)
    ok('--remote leaves opcache.zip EMPTY (the warm module is gone)', r.returncode == 0 and zipfile.ZipFile(os.path.join(b, 'opcache.zip')).namelist() == [])
    idx = rindex(b) if r.returncode == 0 else {'packs': [], 'files': {}}
    pdir = os.path.join(b, 'public', '_pf', 'abc123-wooprimed')
    ok('the index names the build id and one pack per warm file at 0 KiB', idx.get('id') == 'abc123-wooprimed' and len(idx['packs']) == len(warm))
    ok('every warm file is in exactly one pack, by the index, with its size', sorted(idx['files']) == sorted(warm) and all(idx['files'][n][1] == len(files[n]) for n in warm))
    ok('each pack holds exactly the files the index puts in it, bytes unchanged', bool(idx['packs']) and all(
        sorted(zipfile.ZipFile(os.path.join(pdir, pk['name'])).namelist()) == sorted(n for n, (k, _) in idx['files'].items() if k == i)
        and all(zipfile.ZipFile(os.path.join(pdir, pk['name'])).read(n) == files[n] for n, (k, _) in idx['files'].items() if k == i)
        for i, pk in enumerate(idx['packs'])))
    ok('each pack length and SHA-256 match the index', bool(idx['packs']) and all(
        os.path.getsize(os.path.join(pdir, pk['name'])) == pk['bytes'] and hashlib.sha256(open(os.path.join(pdir, pk['name']), 'rb').read()).hexdigest() == pk['sha256'] for pk in idx['packs']))
    ok('the boot chunk is still written beside the packs', os.path.isfile(os.path.join(pdir, 'boot-0.zip')))
with tempfile.TemporaryDirectory() as d:
    b = setup(d, files, warm)
    r = run_remote(b, 512)
    idx = rindex(b) if r.returncode == 0 else {'packs': []}
    ok('at 512 KiB the small warm set fits ONE pack', r.returncode == 0 and len(idx['packs']) == 1)
print('\n%d FAILED' % fails if fails else '\nALL PASS')
sys.exit(1 if fails else 0)
