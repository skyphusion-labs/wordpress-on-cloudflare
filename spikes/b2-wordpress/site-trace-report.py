#!/usr/bin/env python3
"""The site.zip read pattern and the fetch budget of #569 (#394 Gate 2), from the file trace.

  python3 site-trace-report.py build/site.zip build/file-trace.json [build/opcache-remote-index.js]

A MEASUREMENT, no behavior change. It reads the trace file-trace.sh records (FILE_TRACE=on: which
bundle files each request reads, in first-read order) and replays it against two pack models:
- SITE: site.zip in packs of SITE_PACK_KIB (512) deflated, in cold-boot read order (the boot
  requests' first reads, then later requests', then the rest by path), as opcache-remote.py packs
  OPcache. The HOT set is the files read by at least HOT_SHARE (0.5) of the traced warm requests,
  in one pack held ACROSS requests: fetched once per runtime, on its boot request. The other packs
  are held under SITE_HOLD_KIB (2048), LRU, and dropped at the end of each request.
- OPCACHE: the real packs of build/opcache-remote-index.js (when given), held under
  OPC_HOLD_KIB (4096), LRU, dropped per request, as remote-packs.mjs does since #565.
Fetches are SIMULATED. The trace keeps the first read of a file per request, so a revisit of an
evicted file inside a request is not seen, and the simulation can only UNDERcount. The CALIBRATION
line compares the simulated OPcache fetches of the first traced home boot with the measured rfN of
opcache-build run 43603733149 (20 on a cold home boot at 4096 KiB).
"""
import json, os, re, sys, zipfile

KIB = 1024


def lru_fetches(seq, size, budget):
    """Fetches and distinct packs for a sequence of pack ids, held under budget, LRU, the newest kept."""
    held, used, fetches, distinct = [], 0, 0, set()
    for p in seq:
        if p in held:
            held.remove(p); held.append(p)
            continue
        fetches += 1; distinct.add(p)
        held.append(p); used += size[p]
        while used > budget and len(held) > 1:
            q = held.pop(0); used -= size[q]
    return fetches, len(distinct)


def main():
    zpath, tpath = sys.argv[1], sys.argv[2]
    ipath = sys.argv[3] if len(sys.argv) > 3 else None
    pack_kib = int(os.environ.get('SITE_PACK_KIB', '512'))
    site_hold = int(os.environ.get('SITE_HOLD_KIB', '2048')) * KIB
    opc_hold = int(os.environ.get('OPC_HOLD_KIB', '4096')) * KIB
    share = float(os.environ.get('HOT_SHARE', '0.5'))
    z = zipfile.ZipFile(zpath)
    info = {i.filename: i for i in z.infolist() if not i.is_dir()}
    trace = json.load(open(tpath))
    if not trace.get('on'):
        sys.exit('site-trace-report: the trace was not recorded with FILE_TRACE=on')
    reqs = trace['requests']
    def site_reads(r):
        out = []
        for k, _ in r['reads']:
            if k.startswith('site:/'):
                n = k[len('site:/'):]
                if n in info:
                    out.append(n)
        return out
    warm = [r for r in reqs if not r.get('boot')]
    count = {}
    for r in warm:
        for n in set(site_reads(r)):
            count[n] = count.get(n, 0) + 1
    hot = {n for n, c in count.items() if warm and c >= share * len(warm)}
    hot_raw = sum(info[n].file_size for n in hot)
    hot_defl = sum(info[n].compress_size + 30 + len(n) for n in hot)
    # Cold-boot read order, then the rest by path; the hot files are not in these packs.
    order, seen = [], set()
    for r in sorted(reqs, key=lambda r: 0 if r.get('boot') else 1):
        for n in site_reads(r):
            if n not in seen and n not in hot:
                seen.add(n); order.append(n)
    traced = len(order)
    order += sorted(set(info) - seen - hot)
    pack_of, size, cur, acc = {}, {}, 0, 0
    for n in order:
        if acc >= pack_kib * KIB:
            cur += 1; acc = 0
        pack_of[n] = cur
        acc += info[n].compress_size + 30 + len(n)
        size[cur] = acc
    opc = None
    if ipath and os.path.isfile(ipath):
        m = re.search(r'\{.*\}', open(ipath).read(), re.S)
        if m:
            opc = json.loads(m.group(0))
    print('site.zip: %d files, %.2f MiB raw, %.2f MiB deflated; traced site files %d; site packs %d of about %d KiB' % (
        len(info), sum(i.file_size for i in info.values()) / 1048576, sum(i.compress_size for i in info.values()) / 1048576, traced, cur + 1, pack_kib))
    print('HOT set (read by >= %d%% of %d warm requests): %d files, %.1f KiB raw, %.1f KiB deflated, held across requests' % (
        share * 100, len(warm), len(hot), hot_raw / KIB, hot_defl / KIB))
    print('%3s %-26s %4s %-44s %6s %8s %8s %9s %9s %6s' % ('#', 'class', 'boot', 'path', 'sFiles', 'sRawKiB', 'sDefKiB', 'siteF/d', 'opcF/d', 'total'))
    calib = None
    for i, r in enumerate(reqs):
        s = site_reads(r)
        cold = [n for n in s if n not in hot]
        sf, sd = lru_fetches([pack_of[n] for n in cold], size, site_hold) if cold else (0, 0)
        if r.get('boot'):
            sf += 1 if hot else 0  # the hot pack, once per runtime
        of = od = 0
        if opc:
            pre = 'opcache:/internal/shared/opcache/'
            seq = [opc['files'][k[len(pre):]][0] for k, _ in r['reads'] if k.startswith(pre) and k[len(pre):] in opc['files']]
            osize = {i2: p['bytes'] for i2, p in enumerate(opc['packs'])}
            of, od = lru_fetches(seq, osize, opc_hold) if seq else (0, 0)
            if calib is None and r.get('boot') and r.get('cls') == 'front':
                calib = (i, r.get('path'), of)
        raw = sum(info[n].file_size for n in s); defl = sum(info[n].compress_size for n in s)
        print('%3d %-26s %4s %-44s %6d %8.1f %8.1f %4d/%-4d %4d/%-4d %6d' % (
            i, r.get('cls', '')[:26], 'B' if r.get('boot') else '', str(r.get('path', ''))[:44], len(s), raw / KIB, defl / KIB, sf, sd, of, od, sf + of))
    models(reqs, info, pack_kib, site_hold, share)
    if calib:
        print('CALIBRATION: simulated OPcache fetches on the first traced front boot (#%d %s): %d; measured rfN on a cold home boot at 4096 KiB (run 43603733149): 20' % calib)
    elif opc is None:
        print('CALIBRATION: no opcache-remote index given: OPcache columns are 0, could not calibrate')


def events(r, info):
    """[(kind, name)] in trace order: 'open' from "site-open:" keys (#569 step 3), 'read' from "site:"."""
    out = []
    for k, _ in r.get('reads', []):
        if k.startswith('site-open:/'):
            n = k[len('site-open:/'):]
            if n in info: out.append(('open', n))
        elif k.startswith('site:/'):
            n = k[len('site:/'):]
            if n in info: out.append(('read', n))
    return out


def model_names(evs, model):
    """The files a fetch model fetches for one request, in first-fetch order."""
    opened = {n for k, n in evs if k == 'open'}
    seen, out = set(), []
    for k, n in evs:
        php = n.endswith('.php')
        if model == 'open':
            want = k == 'open' or (k == 'read' and n not in opened)
        elif model == 'read':
            want = k == 'read'
        else:  # hybrid: .php at its read, every other file at its open
            want = (k == 'read') if php else (k == 'open' or (k == 'read' and n not in opened))
        if want and n not in seen:
            seen.add(n); out.append(n)
    return out


def models(reqs, info, pack_kib, site_hold, share):
    """#569 step 3: the same trace under the open, read and hybrid fetch models, each packed in its
    own cold-boot order with its own hot set (the event IT fetches on), replayed per request."""
    if not any(k.startswith('site-open:') for r in reqs for k, _ in r.get('reads', [])):
        print('MODELS: the trace has no "site-open:" keys (a build before #569 step 3): could not measure opens')
        return
    evs = [events(r, info) for r in reqs]
    print('OPENS vs READS per request (distinct site files):')
    for i, r in enumerate(reqs):
        o = {n for k, n in evs[i] if k == 'open'}; rd = {n for k, n in evs[i] if k == 'read'}
        nr = o - rd
        print('%3d %s %s opens %d reads %d opened-not-read %d (php %d, other %d)' % (
            i, r.get('cls', ''), 'B' if r.get('boot') else '.', len(o), len(rd), len(nr), sum(1 for n in nr if n.endswith('.php')), sum(1 for n in nr if not n.endswith('.php'))))
    warm = [i for i, r in enumerate(reqs) if not r.get('boot')]
    for model in ('open', 'read', 'hybrid'):
        names = [model_names(evs[i], model) for i in range(len(reqs))]
        count = {}
        for i in warm:
            for n in set(names[i]):
                count[n] = count.get(n, 0) + 1
        hot = {n for n, c in count.items() if warm and c >= share * len(warm)}
        order, seen = [], set(hot)
        for i in sorted(range(len(reqs)), key=lambda i: 0 if reqs[i].get('boot') else 1):
            for n in names[i]:
                if n not in seen:
                    seen.add(n); order.append(n)
        order += sorted(set(info) - seen)
        pack_of, size, cur, acc = {}, {}, 0, 0
        for n in order:
            if acc >= pack_kib * KIB:
                cur += 1; acc = 0
            pack_of[n] = cur
            acc += info[n].compress_size + 30 + len(n)
            size[cur] = acc
        print('MODEL %s (hot %d files, %.1f KiB deflated):' % (model, len(hot), sum(info[n].compress_size for n in hot) / KIB))
        for i, r in enumerate(reqs):
            cold = [n for n in names[i] if n not in hot]
            f, d = lru_fetches([pack_of[n] for n in cold], size, site_hold) if cold else (0, 0)
            if r.get('boot') and hot:
                f += 1
            print('%3d %s %s site fetches %d distinct %d' % (i, r.get('cls', ''), 'B' if r.get('boot') else '.', f, d))


if __name__ == '__main__':
    main()
