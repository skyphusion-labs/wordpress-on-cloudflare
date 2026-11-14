#!/usr/bin/env python3
"""ALL of the OPcache file cache as static-asset packs, fetched while PHP pauses in open() (#563).

#394 Gate 1, the variant the 2026-11-13 ruling allows (#394 issuecomment-6862048364, item 3): no
split, no boot pack, nothing held across the boot. Design: #394 issuecomment-6878206213.

  python3 opcache-remote.py build/opcache.zip build/file-trace.json build/build-id.js

Reads the primed build/opcache.zip and the trace file-trace.sh recorded on it (FILE_TRACE=on).
Writes:
  build/public/_pf/<build-id>/oc-<n>.zip   EVERY OPcache file, in packs of about REMOTE_PACK_KIB
                                           deflated (default 1024), as static assets
  build/opcache.zip                        EMPTY (no OPcache file stays in the bundle)
  build/opcache-boot-index.js              export default null (no boot pack)
  build/opcache-remote-index.js            export default { id, packs: [{ name, bytes, sha256 }],
                                           files: { name: [pack, size] } }
The order is the order a cold boot reads the files, so a boot streams through the packs under a
small held budget (remote-packs.mjs): first the BOOT requests' first reads in trace order, then the
files first read by later requests, then the files the trace never saw, by path.
"""
import hashlib, io, json, os, re, sys, zipfile

PREFIX = 'opcache:/internal/shared/opcache/'


def main():
    if len(sys.argv) != 4:
        sys.exit('usage: opcache-remote.py <opcache.zip> <file-trace.json> <build-id.js>')
    zpath, tpath, idpath = sys.argv[1:4]
    m = re.search(r'"([^"]+)"', open(idpath).read())
    if not m:
        sys.exit('opcache-remote: no build id in %s' % idpath)
    build_id = m.group(1)
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', build_id) or '..' in build_id:
        sys.exit('opcache-remote: build id %r is not safe as a path' % build_id)
    trace = json.load(open(tpath))
    if not trace.get('on'):
        sys.exit('opcache-remote: the trace was not recorded with FILE_TRACE=on')
    reqs = trace.get('requests') or []
    if not any(r.get('boot') for r in reqs):
        sys.exit('opcache-remote: the trace has no booting request, so there is no cold-boot order to follow')
    src = zipfile.ZipFile(zpath)
    entries = {i.filename: i for i in src.infolist() if not i.is_dir()}
    order, seen = [], set()
    # Boot requests first, then the rest, each in trace order; within a request, first-read order.
    for r in sorted(reqs, key=lambda r: 0 if r.get('boot') else 1):
        for k, _ in r.get('reads', []):
            if not k.startswith(PREFIX):
                continue
            n = k[len(PREFIX):]
            if n not in entries:
                sys.exit('opcache-remote: the traced file %s is not in %s (another build?)' % (n, zpath))
            if n not in seen:
                seen.add(n)
                order.append(n)
    traced = len(order)
    order += sorted(set(entries) - seen)
    out_dir = os.path.join(os.path.dirname(zpath), 'public', '_pf', build_id)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        os.remove(os.path.join(out_dir, f))
    limit = int(os.environ.get('REMOTE_PACK_KIB', '1024')) * 1024
    packs, files = [], {}
    cur = curz = None

    def close():
        if curz is not None:
            curz.close()
            data = cur.getvalue()
            name = 'oc-%d.zip' % len(packs)
            if len(data) > 25 * 1048576:
                sys.exit('opcache-remote: %s is over the 25 MiB static asset limit' % name)
            open(os.path.join(out_dir, name), 'wb').write(data)
            packs.append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

    for n in order:
        if curz is None or cur.tell() >= limit:
            close()
            cur = io.BytesIO()
            curz = zipfile.ZipFile(cur, 'w', zipfile.ZIP_DEFLATED, compresslevel=6)
        data = src.read(entries[n])
        curz.writestr(n, data)
        files[n] = [len(packs), len(data)]
    close()
    d = os.path.dirname(zpath)
    idx = {'id': build_id, 'packs': packs, 'files': files}
    zipfile.ZipFile(zpath, 'w').close()
    open(os.path.join(d, 'opcache-boot-index.js'), 'w').write('export default null;\n')
    stale = os.path.join(d, 'opcache-boot.zip')
    if os.path.exists(stale):
        os.remove(stale)
    open(os.path.join(d, 'opcache-remote-index.js'), 'w').write('export default %s;\n' % json.dumps(idx, separators=(',', ':')))
    total = sum(p['bytes'] for p in packs)
    print('opcache remote (#563): %d files (%d traced, from %d boot request(s) first) in %d pack(s), %.2f MiB, under _pf/%s; opcache.zip empty, no boot pack' % (
        len(files), traced, sum(1 for r in reqs if r.get('boot')), len(packs), total / 1048576, build_id))


if __name__ == '__main__':
    main()
