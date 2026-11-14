#!/usr/bin/env python3
"""Split the OPcache file cache into a WARM part and a BOOT part (#394 L1, docs/design-394-admin-lever.md).

The whole of build/opcache.zip is a data module today, resident in every isolate for its life (about
21 MiB deflated, part of the 44 MiB the #411 probes measured). Measured at OPcache 48 (M0 re-trace,
2026-11-13): a WARM request reads at most about 3.3 MiB of it, and all warm requests together read
748 of 2,137 files (6.4 MiB deflated). The rest is read only while a runtime boots.

  python3 opcache-split.py build/opcache.zip build/file-trace.json build/build-id.js

Writes:
  build/opcache.zip                         the WARM files only (still a data module, resident)
  build/public/_pf/<build-id>/boot-<n>.zip  the same BOOT files in chunks under 16 MiB, as static
                                            assets (25 MiB per file limit), fetched at a boot
  build/opcache-boot-index.js               export default { id, chunks, files, bytes }
The warm set is every opcache file a NON-boot request read in build/file-trace.json (file-trace.sh on
the primed build). A file that a real warm request needs and the trace did not see is a miss: OPcache
compiles it from source, its normal path. Never silent: index.js logs the boot pack source.
"""
import io, json, os, re, sys, zipfile

CHUNK = 16 * 1048576
PREFIX = '/internal/shared/opcache/'


def main():
    zpath, tpath, idpath = sys.argv[1:4]
    m = re.search(r'"([^"]+)"', open(idpath).read())
    if not m:
        sys.exit('opcache-split: no build id in %s' % idpath)
    build_id = m.group(1)
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', build_id):
        sys.exit('opcache-split: build id %r is not safe as a path' % build_id)
    trace = json.load(open(tpath))
    if not trace.get('on'):
        sys.exit('opcache-split: the trace was not recorded with FILE_TRACE=on')
    warm = set()
    nwarm = 0
    for r in trace['requests']:
        if r.get('boot'):
            continue
        nwarm += 1
        for k, _ in r['reads']:
            if k.startswith('opcache:' + PREFIX):
                warm.add(k[len('opcache:' + PREFIX):])
    if nwarm < 10 or not warm:
        sys.exit('opcache-split: only %d warm requests and %d warm files in the trace: not enough to split on' % (nwarm, len(warm)))
    src = zipfile.ZipFile(zpath)
    entries = [i for i in src.infolist() if not i.is_dir()]
    names = {i.filename for i in entries}
    unknown = warm - names
    if unknown:
        sys.exit('opcache-split: %d traced files are not in %s (another build?): %s' % (len(unknown), zpath, sorted(unknown)[:3]))
    warm_buf, boot_buf = io.BytesIO(), io.BytesIO()
    wz = zipfile.ZipFile(warm_buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6)
    bz = zipfile.ZipFile(boot_buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6)
    boot = []
    for i in entries:
        data = src.read(i)
        if i.filename in warm:
            wz.writestr(i.filename, data)
        else:
            bz.writestr(i.filename, data)
            boot.append((i.filename, data))
    wz.close(); bz.close()
    # Chunks for the static assets, each under 16 MiB deflated.
    out_dir = os.path.join(os.path.dirname(zpath), 'public', '_pf', build_id)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        os.remove(os.path.join(out_dir, f))
    chunks, cur, curz, cur_bytes = [], None, None, 0
    def close():
        if curz:
            curz.close()
            name = 'boot-%d.zip' % len(chunks)
            open(os.path.join(out_dir, name), 'wb').write(cur.getvalue())
            chunks.append(name)
    for name, data in boot:
        if curz is None or cur_bytes > CHUNK:
            close()
            cur = io.BytesIO(); curz = zipfile.ZipFile(cur, 'w', zipfile.ZIP_DEFLATED, compresslevel=6); cur_bytes = 0
        curz.writestr(name, data)
        cur_bytes += len(zipfile.ZipInfo(name).filename) + len(data) // 3  # a rough deflated size; the cap has slack under 25 MiB
    close()
    open(zpath, 'wb').write(warm_buf.getvalue())
    # No fallback module: #411 measured that a bundled data module costs isolate memory even when it
    # is never imported, so the boot files must NOT ship in the bundle at all.
    stale = os.path.join(os.path.dirname(zpath), 'opcache-boot.zip')
    if os.path.exists(stale):
        os.remove(stale)
    idx = {'id': build_id, 'chunks': chunks, 'files': len(boot), 'bytes': len(boot_buf.getvalue())}
    open(os.path.join(os.path.dirname(zpath), 'opcache-boot-index.js'), 'w').write('export default %s;\n' % json.dumps(idx))
    for c in chunks:
        if os.path.getsize(os.path.join(out_dir, c)) > 25 * 1048576:
            sys.exit('opcache-split: %s is over the 25 MiB static asset limit' % c)
    M = 1048576
    print('opcache split: warm %d files %.2f MiB (module), boot %d files %.2f MiB in %d asset chunk(s) under _pf/%s (not in the bundle), from %d warm requests' % (
        len(warm), len(warm_buf.getvalue()) / M, len(boot), len(boot_buf.getvalue()) / M, len(chunks), build_id, nwarm))


if __name__ == '__main__':
    main()
