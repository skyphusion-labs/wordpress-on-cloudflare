#!/usr/bin/env python3
"""Summarize build/file-trace.json (#394 M0): what each route class reads, at boot and warm.

Usage: python3 file-trace-report.py build/file-trace.json [--json out.json]
Bytes are the files' UNCOMPRESSED sizes (what an inflate makes)."""
import collections, json, sys

M = 1048576


def ext(path):
    name = path.rsplit('/', 1)[-1]
    if name.endswith('.php.bin'):
        return 'php.bin'
    return name.rsplit('.', 1)[-1] if '.' in name else '(none)'


def main():
    d = json.load(open(sys.argv[1]))
    reqs = d['requests']
    # #569: a trace may also hold OPEN events ("site-open:", "opcache-open:"). This report is about
    # bytes READ, so it drops them (site-trace-report.py reads both).
    for r in reqs:
        r['reads'] = [x for x in r['reads'] if '-open:' not in x[0].split('/', 1)[0]]
    by_cls = collections.defaultdict(list)
    for r in reqs:
        by_cls[r['cls']].append(r)
    print('requests %d, dropped %d' % (len(reqs), d['dropped']))
    print('%-22s %4s %5s %10s %10s %10s %10s' % ('class', 'n', 'boot', 'warm MiB', 'site MiB', 'opc MiB', 'union MiB'))
    union = {}
    for cls in sorted(by_cls):
        rs = by_cls[cls]
        warm = [r for r in rs if not r['boot']]
        u = {}
        for r in rs:
            for k, b in r['reads']:
                u[k] = b
        union[cls] = u
        wavg = sum(sum(b for _, b in r['reads']) for r in warm) / len(warm) / M if warm else 0
        site = sum(b for k, b in u.items() if k.startswith('site:')) / M
        opc = sum(b for k, b in u.items() if k.startswith('opcache:')) / M
        print('%-22s %4d %5d %10.2f %10.2f %10.2f %10.2f' % (cls, len(rs), len(rs) - len(warm), wavg, site, opc, site + opc))
    # Warm reads by source and extension: why does a warm request inflate anything?
    agg = collections.Counter(); cnt = collections.Counter(); nwarm = 0
    for r in reqs:
        if r['boot']:
            continue
        nwarm += 1
        for k, b in r['reads']:
            src, path = k.split(':', 1)
            agg[(src, ext(path))] += b; cnt[(src, ext(path))] += 1
    print('\nwarm reads per warm request (%d warm requests), by source and extension:' % nwarm)
    for (src, e), b in agg.most_common(12):
        print('  %-8s %-8s %8.2f MiB %7.1f files' % (src, e, b / nwarm / M, cnt[(src, e)] / nwarm))
    boots = [r for r in reqs if r['boot']]
    for r in boots:
        b = collections.Counter()
        for k, n in r['reads']:
            b[k.split(':', 1)[0]] += n
        print('\nboot request %s %s: %s' % (r['cls'], r['path'], ', '.join('%s %.2f MiB' % (s, n / M) for s, n in b.items())))
    every = set.intersection(*(set(u) for u in union.values())) if union else set()
    print('\nfiles read by EVERY class: %d, %.2f MiB' % (len(every), sum(union[next(iter(union))][k] for k in every) / M))
    allr = {}
    for u in union.values():
        allr.update(u)
    print('files read by ANY class: %d, %.2f MiB (site %.2f, opcache %.2f)' % (
        len(allr), sum(allr.values()) / M,
        sum(b for k, b in allr.items() if k.startswith('site:')) / M,
        sum(b for k, b in allr.items() if k.startswith('opcache:')) / M))
    if '--json' in sys.argv:
        out = sys.argv[sys.argv.index('--json') + 1]
        json.dump({cls: sorted(u) for cls, u in union.items()}, open(out, 'w'), indent=0)


if __name__ == '__main__':
    main()
