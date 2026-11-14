#!/usr/bin/env python3
"""site.zip as static-asset packs, fetched while PHP pauses in open() (#569, #394 Gate 2).

  python3 site-remote.py build/site.zip build/file-trace.json build/build-id.js

Run AFTER opcache-remote.py (SITE_REMOTE=1 needs OPCACHE_REMOTE=1: the same hook, budget and
/_pf/ assets; this refuses without build/opcache-remote-index.js). Reads the trace file-trace.sh
recorded (FILE_TRACE=on). Design: #394 issuecomment-6879005325; measured: issuecomment-6879197224.
Writes, under build/public/_pf/<build-id>/ beside the oc-<n>.zip packs (which it never touches):
  site-hot.zip      the HOT set: files read by at least HOT_SHARE (0.5) of the traced warm requests
                    (measured: 46 files, 34.8 KiB deflated). Held for the life of a runtime.
  st-<n>.zip        every other file, in packs of about SITE_PACK_KIB (512) deflated, in cold-boot
                    read order (the boot requests' first reads, then later requests', then by path)
  build/site.zip    EMPTY (no site file stays in the bundle)
  build/site-remote-index.js
                    export default { id, hot: { name, bytes, sha256 }, packs: [...], files: { name:
                    [pack, size] } (pack -1 = hot), dirs: [every directory, empty ones too] }
"""
import hashlib, io, json, os, re, sys, zipfile

PREFIX = 'site:/'


def main():
    if len(sys.argv) != 4:
        sys.exit('usage: site-remote.py <site.zip> <file-trace.json> <build-id.js>')
    zpath, tpath, idpath = sys.argv[1:4]
    d = os.path.dirname(zpath)
    if not os.path.isfile(os.path.join(d, 'opcache-remote-index.js')) or 'export default null' in open(os.path.join(d, 'opcache-remote-index.js')).read():
        sys.exit('site-remote: no OPcache remote index: SITE_REMOTE=1 needs OPCACHE_REMOTE=1 (run opcache-remote.py first)')
    m = re.search(r'"([^"]+)"', open(idpath).read())
    if not m:
        sys.exit('site-remote: no build id in %s' % idpath)
    build_id = m.group(1)
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', build_id) or '..' in build_id:
        sys.exit('site-remote: build id %r is not safe as a path' % build_id)
    trace = json.load(open(tpath))
    if not trace.get('on'):
        sys.exit('site-remote: the trace was not recorded with FILE_TRACE=on')
    reqs = trace.get('requests') or []
    if not any(r.get('boot') for r in reqs):
        sys.exit('site-remote: the trace has no booting request, so there is no cold-boot order to follow')
    src = zipfile.ZipFile(zpath)
    entries = {i.filename: i for i in src.infolist() if not i.is_dir()}
    dirs = set(i.filename.rstrip('/') for i in src.infolist() if i.is_dir())
    for n in entries:
        parts = n.split('/')[:-1]
        for k in range(1, len(parts) + 1):
            dirs.add('/'.join(parts[:k]))

    def reads(r):
        out = []
        for k, _ in r.get('reads', []):
            if k.startswith(PREFIX):
                n = k[len(PREFIX):]
                if n not in entries:
                    sys.exit('site-remote: the traced file %s is not in %s (another build?)' % (n, zpath))
                out.append(n)
        return out

    share = float(os.environ.get('HOT_SHARE', '0.5'))
    warm = [r for r in reqs if not r.get('boot')]
    count = {}
    for r in warm:
        for n in set(reads(r)):
            count[n] = count.get(n, 0) + 1
    hot = sorted(n for n, c in count.items() if warm and c >= share * len(warm))
    order, seen = [], set(hot)
    for r in sorted(reqs, key=lambda r: 0 if r.get('boot') else 1):
        for n in reads(r):
            if n not in seen:
                seen.add(n)
                order.append(n)
    traced = len(order) + len(hot)
    order += sorted(set(entries) - seen)
    out_dir = os.path.join(d, 'public', '_pf', build_id)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.startswith('st-') or f.startswith('site-hot'):
            os.remove(os.path.join(out_dir, f))

    def write(name, members):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for n in members:
                z.writestr(n, src.read(entries[n]))
        data = buf.getvalue()
        if len(data) > 25 * 1048576:
            sys.exit('site-remote: %s is over the 25 MiB static asset limit' % name)
        open(os.path.join(out_dir, name), 'wb').write(data)
        return {'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    files = {}
    hot_pack = write('site-hot.zip', hot) if hot else None
    for n in hot:
        files[n] = [-1, entries[n].file_size]
    limit = int(os.environ.get('SITE_PACK_KIB', '512')) * 1024
    packs, cur, acc = [], [], 0
    for n in order:
        if cur and acc >= limit:
            packs.append(write('st-%d.zip' % len(packs), cur))
            cur, acc = [], 0
        cur.append(n)
        files[n] = [len(packs), entries[n].file_size]
        acc += entries[n].compress_size + 30 + len(n)
    if cur:
        packs.append(write('st-%d.zip' % len(packs), cur))
    idx = {'id': build_id, 'hot': hot_pack, 'packs': packs, 'files': files, 'dirs': sorted(dirs)}
    zipfile.ZipFile(zpath, 'w').close()
    open(os.path.join(d, 'site-remote-index.js'), 'w').write('export default %s;\n' % json.dumps(idx, separators=(',', ':')))
    print('site remote (#569): %d files (%d traced), hot %d files %.1f KiB, %d pack(s) %.2f MiB, %d dirs, under _pf/%s; site.zip empty' % (
        len(files), traced, len(hot), (hot_pack['bytes'] if hot_pack else 0) / 1024, len(packs), sum(p['bytes'] for p in packs) / 1048576, len(dirs), build_id))


if __name__ == '__main__':
    main()
