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
print('\n%d FAILED' % fails if fails else '\nALL PASS')
sys.exit(1 if fails else 0)
