#!/usr/bin/env python3
"""The per-site rollback artifact of a deploy/wfp site, keyed by build id (#466).

`site update` rolls a failed update back to the code that was live. Before #466 the only
artifact was build/, which is what this clone built LAST: often another site's build (#464), so
the update had no code rollback. Now a good `site update` or `site add` stores what it deployed
in the site's own media bucket (private outside uploads/, emptied by `site remove`), beside
_build/inputs.json (#379):

    _build/artifact/<build id>.tar.gz
        build/build-id.js      the build id (the #465 guard reads it)
        build/<imported>       each file a root source imports as ./build/<path> (site.zip,
                               opcache.zip, opcache-boot-index.js, opcache-remote-index.js,
                               build-id.js today)
        build/public/          the static assets (with the _pf/ OPcache boot packs, #394)
        vendor/                the PHP wasm and its loader
        *.js *.mjs package.json package-lock.json   the Worker sources at the app root

Only what the deploy uploads (#507): the bundle is index.js and what it imports, plus the assets
directory. The rest of build/ (the unpacked WordPress tree, build/cache, the logs) never reaches
the Worker, and it made the artifact about 3.7 times the bundle (124428180 bytes on pf466).

    rollback_artifact.py pack <app dir> <build id> <out.tar.gz>
    rollback_artifact.py put <bucket> <build id> <tar.gz>     write, then read back the size
    rollback_artifact.py get <bucket> <build id> <out dir>    exit 0 with the tree in <out dir>,
                                                              3 when there is none, 1 on an
                                                              error or a refused artifact
    rollback_artifact.py prune <bucket> <keep id>...          delete every other artifact

A build id must be a plain id ([A-Za-z0-9._-], no "..") and must not be -dirty (a dirty id does
not name its code, #464): such an id is never written or read. `get` checks that the tree's own
build/build-id.js names the build id asked for (the #465 guard): a wrong artifact is refused,
never returned. Extraction takes only regular files and directories under the names above.
The S3 calls are snapshot.py's (the key in a curl config on stdin, never in argv); the body is
streamed from and to a file, never held in argv (a store build is about 60 MiB).
"""
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True  # no __pycache__: it would make the tree dirty (#377)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snapshot  # noqa: E402

PREFIX = "_build/artifact/"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DIRS = ("build", "vendor")
# A static import or a dynamic import() of ./build/<path> in a root source.
BUILD_IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]\./build/([^'"]+)['"]""")
TOP_RE = re.compile(r"^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|mjs)|package\.json|package-lock\.json)$")


def id_ok(bid):
    """None when the id may key an artifact, else the reason."""
    if not bid or not ID_RE.match(bid) or ".." in bid:
        return "the build id %r is not a plain id" % bid
    if "-dirty" in bid:
        return "the build id %s is from a dirty tree, so it does not name its code" % bid
    return None


def key(bid):
    return PREFIX + bid + ".tar.gz"


def build_id_of(tree):
    try:
        s = open(os.path.join(tree, "build", "build-id.js")).read()
    except OSError:
        return ""
    m = re.search(r'export default "(.*)";', s)
    return m.group(1) if m else ""


def s3_file(method, path, infile=None, outfile=None):
    """snapshot.s3, with the body streamed from infile or to outfile. Returns the HTTP status."""
    kid, sec = snapshot.s3_creds()
    ep = snapshot.ENV.get("WFP_S3_ENDPOINT") or "https://%s.r2.cloudflarestorage.com" % snapshot.ENV["CLOUDFLARE_ACCOUNT_ID"]
    args = ["curl", "-s", "-m", "900", "-K", "-", "--aws-sigv4", "aws:amz:auto:s3", "-X", method, "-w", "%{http_code}"]
    if infile:
        args += ["--data-binary", "@" + infile]
    args += ["-o", outfile or os.devnull, ep + path]
    r = subprocess.run(args, input=('user = "%s:%s"\n' % (kid, sec)).encode(), capture_output=True)
    code = r.stdout.decode("ascii", "replace").strip()[-3:]
    return int(code) if code.isdigit() else 0


def listing(bucket):
    """{key: size} of every artifact in the bucket, or None when the list fails."""
    out, token = {}, None
    while True:
        q = "list-type=2&prefix=" + urllib.parse.quote(PREFIX, safe="")
        if token:
            q += "&continuation-token=" + urllib.parse.quote(token, safe="")
        st, b = snapshot.s3("GET", "/%s?%s" % (bucket, q))
        if st != 200:
            print("rollback artifact: the list of %s answered %s" % (bucket, st), file=sys.stderr)
            return None
        root = ET.fromstring(b)
        token = None
        for c in root:
            tag = c.tag.rsplit("}", 1)[-1]
            if tag == "Contents":
                get = lambda t: next((x.text for x in c if x.tag.rsplit("}", 1)[-1] == t), None)
                out[get("Key")] = int(get("Size") or 0)
            elif tag == "NextContinuationToken":
                token = c.text
        if not token:
            return out


def build_imports(app, tops):
    """The build/ paths the root sources import, sorted. A path with .. or a glob is refused."""
    out = set()
    for n in tops:
        if not n.endswith((".js", ".mjs")):
            continue
        for m in BUILD_IMPORT_RE.finditer(open(os.path.join(app, n), encoding="utf-8", errors="replace").read()):
            rel = m.group(1)
            if rel.startswith("/") or ".." in rel.split("/") or any(c in rel for c in "*?$`{"):
                raise SystemExit("rollback artifact: not packed: %s imports an odd build path %r" % (n, rel))
            out.add(rel)
    return sorted(out)


def pack(app, bid, outp):
    why = id_ok(bid)
    if why:
        raise SystemExit("rollback artifact: not packed: " + why)
    have = build_id_of(app)
    if have != bid:
        raise SystemExit("rollback artifact: not packed: build/ holds %s, not %s" % (have or "no build", bid))
    tops = sorted(n for n in os.listdir(app) if TOP_RE.match(n) and os.path.isfile(os.path.join(app, n)))
    want = ["build/" + r for r in sorted(set(build_imports(app, tops)) | {"build-id.js"})]
    for d in DIRS:
        if not os.path.isdir(os.path.join(app, d)):
            raise SystemExit("rollback artifact: not packed: %s has no %s/" % (app, d))
    for w in want:
        if not os.path.isfile(os.path.join(app, w)):
            raise SystemExit("rollback artifact: not packed: a source imports %s, which the build did not make" % w)
    with tarfile.open(outp, "w:gz", dereference=True) as t:
        t.add(os.path.join(app, "build"), arcname="build", recursive=False)
        for w in want:
            t.add(os.path.join(app, w), arcname=w)
        if os.path.isdir(os.path.join(app, "build", "public")):
            t.add(os.path.join(app, "build", "public"), arcname="build/public")
        t.add(os.path.join(app, "vendor"), arcname="vendor")
        for n in tops:
            t.add(os.path.join(app, n), arcname=n)
    return len(tops), want


def member_ok(m):
    n = m.name
    if not (m.isfile() or m.isdir()):
        return "%s is not a file or a directory" % n
    parts = n.split("/")
    if n.startswith("/") or ".." in parts or "" in parts[:-1]:
        return "%s is not a plain relative path" % n
    if parts[0] in DIRS:
        return None
    if len(parts) == 1 and m.isfile() and TOP_RE.match(n):
        return None
    return "%s is not under build/, vendor/ or a Worker source at the root" % n


def safe_extract(tgz, outdir):
    with tarfile.open(tgz, "r:gz") as t:
        members = t.getmembers()
        for m in members:
            why = member_ok(m)
            if why:
                raise SystemExit("rollback artifact: refused: the tree holds " + why)
        for m in members:
            if hasattr(tarfile, "data_filter"):
                t.extract(m, outdir, filter="data")
            else:
                t.extract(m, outdir)
    return len(members)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "pack" and len(argv) == 5:
        n, want = pack(argv[2], argv[3], argv[4])
        print("rollback artifact: packed %s (%s, build/public/, vendor/, %d source file(s)), %d bytes" % (argv[3], " ".join(want), n, os.path.getsize(argv[4])))
        return 0
    if cmd == "put" and len(argv) == 5:
        b, bid, f = argv[2], argv[3], argv[4]
        why = id_ok(bid)
        if why:
            print("rollback artifact: not stored: " + why, file=sys.stderr); return 1
        size = os.path.getsize(f)
        st = s3_file("PUT", "/%s/%s" % (b, key(bid)), infile=f)
        got = (listing(b) or {}).get(key(bid))
        if st not in (200, 201) or got != size:
            print("rollback artifact: %s/%s did not store (PUT %s, listed size %s of %d)" % (b, key(bid), st, got, size), file=sys.stderr)
            return 1
        print("rollback artifact: stored %s/%s (%d bytes, read back)" % (b, key(bid), size))
        return 0
    if cmd == "get" and len(argv) == 5:
        b, bid, out = argv[2], argv[3], argv[4]
        why = id_ok(bid)
        if why:
            print("rollback artifact: not read: " + why, file=sys.stderr); return 1
        tmp = tempfile.mkdtemp(prefix="wfp-art-")
        try:
            f = os.path.join(tmp, "a.tar.gz")
            st = s3_file("GET", "/%s/%s" % (b, key(bid)), outfile=f)
            if st == 404:
                return 3
            if st != 200:
                print("rollback artifact: GET %s/%s answered %s" % (b, key(bid), st), file=sys.stderr); return 1
            x = os.path.join(tmp, "x")
            os.mkdir(x)
            try:
                n = safe_extract(f, x)
            except (tarfile.TarError, OSError, EOFError) as e:
                print("rollback artifact: %s/%s does not extract: %s" % (b, key(bid), e), file=sys.stderr); return 1
            have = build_id_of(x)
            if have != bid:
                # The #465 guard: an artifact that does not hold the build it is named for is never
                # used; nothing of it reaches <out dir>.
                print("rollback artifact: refused: %s/%s holds build %s, not %s" % (b, key(bid), have or "no build", bid), file=sys.stderr)
                return 1
            for name in os.listdir(x):
                shutil.move(os.path.join(x, name), os.path.join(out, name))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        print("rollback artifact: fetched %s (%d entries)" % (bid, n))
        return 0
    if cmd == "prune" and len(argv) >= 3:
        b = argv[2]
        keep = {key(k) for k in argv[3:] if k and not id_ok(k)}
        if not keep:
            print("rollback artifact: no plain build id to keep; nothing is pruned", file=sys.stderr); return 1
        have = listing(b)
        if have is None:
            return 1
        bad = 0
        for k in sorted(have):
            if k in keep:
                continue
            st, _ = snapshot.s3("DELETE", "/%s/%s" % (b, urllib.parse.quote(k)))
            if st in (200, 204):
                print("rollback artifact: pruned %s/%s" % (b, k))
            else:
                print("rollback artifact: the delete of %s/%s answered %s" % (b, k, st), file=sys.stderr); bad = 1
        return bad
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
