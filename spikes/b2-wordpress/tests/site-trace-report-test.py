#!/usr/bin/env python3
"""python3 -I spikes/b2-wordpress/tests/site-trace-report-test.py  (#569)
site-trace-report.py on a synthetic build whose answers are known by hand: the hot set, the
once-per-runtime hot fetch, the LRU refetch under a small budget, and the OPcache columns from a
real-shaped remote index. The instrument must be able to report a wrong-looking number."""
import json, os, re, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REP = os.path.join(HERE, '..', 'site-trace-report.py')
fails = 0
def ok(label, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + label)
    fails += 0 if cond else 1

with tempfile.TemporaryDirectory() as d:
    z = os.path.join(d, 'site.zip')
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_STORED) as f:  # stored: deflated size == raw size
        for n in ('a', 'b', 'c'):
            f.writestr('wordpress/%s.php' % n, b'x' * 3000)
        f.writestr('wordpress/h.json', b'h' * 100)
    S = lambda n: ['site:/wordpress/' + n, 1]
    O = lambda n: ['opcache:/internal/shared/opcache/' + n, 1]
    # The trace keeps the FIRST read of a file per request, so no file repeats inside a request.
    reqs = [
        {'cls': 'front', 'boot': 1, 'path': '/', 'reads': [S('h.json'), S('a.php'), S('b.php'), O('x.bin'), O('y.bin')]},
        {'cls': 'front', 'boot': 0, 'path': '/', 'reads': [S('h.json')]},
        {'cls': 'front', 'boot': 0, 'path': '/', 'reads': [S('h.json')]},
        {'cls': 'front', 'boot': 0, 'path': '/', 'reads': [S('h.json')]},
        {'cls': 'admin:index', 'boot': 0, 'path': '/wp-admin/', 'reads': [S('h.json'), S('a.php'), S('c.php'), S('b.php')]},
    ]
    t = os.path.join(d, 'trace.json'); json.dump({'on': True, 'dropped': 0, 'requests': reqs}, open(t, 'w'))
    idx = os.path.join(d, 'idx.js')
    open(idx, 'w').write('export default %s;\n' % json.dumps({'id': 't', 'packs': [{'name': 'oc-0.zip', 'bytes': 2000, 'sha256': ''}, {'name': 'oc-1.zip', 'bytes': 2000, 'sha256': ''}], 'files': {'x.bin': [0, 1], 'y.bin': [1, 1]}}))
    # By hand: h.json is in 4 of 4 warm requests (hot); a, b, c in 1 of 4 (not hot). Packs of 4 KiB in
    # cold-boot order: P0 = {a, b} (about 6 KiB: a pack closes once it passes the size), P1 = {c}.
    # A 7 KiB site budget holds P0 alone, so admin's a (P0), c (P1, evicts P0), b (P0 again) is 3 fetches
    # of 2 distinct packs. OPcache: x, y in two 2000-byte packs, 4 KiB held: 2 fetches.
    env = dict(os.environ, SITE_PACK_KIB='4', SITE_HOLD_KIB='7', OPC_HOLD_KIB='4')
    r = subprocess.run([sys.executable, '-I', REP, z, t, idx], capture_output=True, text=True, env=env)
    out = r.stdout
    print(out)
    ok('exit 0', r.returncode == 0)
    ok('the hot set is h.json alone (in 4 of 4 warm requests)', 'HOT set (read by >= 50% of 4 warm requests): 1 files' in out)
    rows = [l.split() for l in out.splitlines() if re.match(r'^\s*\d+\s', l)]
    tot = [int(x[-1]) for x in rows]
    ok('five request rows', len(rows) == 5)
    ok('boot: the hot pack 1 + P0 1 + OPcache 2 = 4 fetches', tot[:1] == [4])
    ok('warm front: only the hot file, held across requests: 0 fetches', tot[1:4] == [0, 0, 0])
    ok('warm admin: a, c, b under a one-pack budget is 3 fetches of 2 distinct packs', len(rows) == 5 and rows[4][-3] == '3/2' and tot[4] == 3)
    ok('the calibration line names the front boot', 'CALIBRATION: simulated OPcache fetches on the first traced front boot (#0 /): 2' in out)
# #569 step 3: a trace with OPENS ("site-open:") beside READS ("site:"). A .php opened 3 times and
# read never (OPcache resolving a cached source) costs the OPEN model fetches, the READ model none.
# The hybrid model fetches .php at read and every other file at open.
with tempfile.TemporaryDirectory() as d:
    z = os.path.join(d, 'site.zip')
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_STORED) as f:
        for n in ('s1.php', 's2.php', 's3.php', 'x.php'):
            f.writestr('wordpress/' + n, b'p' * 3000)
        f.writestr('wordpress/t.json', b'j' * 3000)
    SO = lambda n: ['site-open:/wordpress/' + n, 1]
    S = lambda n: ['site:/wordpress/' + n, 1]
    reqs = [
        {'cls': 'front', 'boot': 1, 'path': '/', 'reads': [SO('x.php'), S('x.php'), SO('t.json'), S('t.json')]},
        {'cls': 'admin:index', 'boot': 1, 'path': '/wp-admin/', 'reads': [SO('s1.php'), SO('s2.php'), SO('s3.php'), SO('x.php'), S('x.php'), SO('t.json'), S('t.json')]},
    ]
    t = os.path.join(d, 'trace.json'); json.dump({'on': True, 'dropped': 0, 'requests': reqs}, open(t, 'w'))
    # 2 KiB packs: each 3,046-byte file (with its header) is its own pack. No warm
    # request, so no hot set. A 5 KiB budget holds one pack.
    env = dict(os.environ, SITE_PACK_KIB="2", SITE_HOLD_KIB="5", OPC_HOLD_KIB="4")
    r = subprocess.run([sys.executable, '-I', REP, z, t], capture_output=True, text=True, env=env)
    out = r.stdout
    print(out)
    m = {k: v for k, v in re.findall(r'^MODEL (\w+) .*?admin:index B\s+site fetches (\d+)', out, re.M | re.S)}
    ok('the open and read counts are reported per request', 'opens 5 reads 2 opened-not-read 3 (php 3, other 0)' in out)
    ok('MODEL open: the admin boot fetches all 5 opened files (5 packs)', m.get('open') == '5')
    ok('MODEL read: the admin boot fetches only the 2 files it read', m.get('read') == '2')
    ok('MODEL hybrid: .php at read (x), others at open (t.json): 2', m.get('hybrid') == '2')
print('\n%d FAILED' % fails if fails else '\nALL PASS')
sys.exit(1 if fails else 0)
