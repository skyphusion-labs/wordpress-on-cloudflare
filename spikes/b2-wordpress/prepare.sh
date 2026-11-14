#!/bin/bash
# Build vendor/php_8_3.js from the pinned @php-wasm/web-8-3 JSPI loader.
# workerd has no import.meta.url, so the first statement (two lines) that
# builds the wasm URL from it is replaced. The Worker passes the wasm module
# itself through instantiateWasm, so the file name is never fetched.
set -euo pipefail
cd "$(dirname "$0")"
src=node_modules/@php-wasm/web-8-3/jspi/php_8_3.js
mkdir -p vendor
{ echo "const dependencyFilename = 'php_8_3.wasm';"; tail -n +3 "$src"; } > vendor/php_8_3.js
head -1 vendor/php_8_3.js

# A Worker does not advance Date.now() while code runs (the clock moves only at
# I/O). PHP's uniqid() polls gettimeofday() until the microsecond changes, so
# a second uniqid() in one request spun until the CPU limit (measured
# 2026-11-05: wp-admin/plugins.php, themes.php, and every request with Contact
# Form 7 active used 32 s of CPU, exceededCpu; 0.1 s locally, where the clock
# moves). gettimeofday() reads emscripten_date_now(). Each read now returns at
# least 1 microsecond more than the last: still monotonic, and within
# microseconds of the real time.
python3 - <<'PY2'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = "	var _emscripten_date_now = () => Date.now();"
new = "	var dateLast = 0;\n	var _emscripten_date_now = () => { var t = Date.now(); if (t <= dateLast) t = dateLast + 0.001; dateLast = t; return t; };"
assert s.count(old) == 1, 'emscripten_date_now patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY2

# Heap growth (#394, rank 1 of Joan's admin memory profile, PR #445): Emscripten grows the PHP heap
# to max(requested, old * 1.2), retrying at 1.1 and 1.05. At 100 MiB that is a 20 MiB step for a
# request of a few KiB, and the memory grows in big stairs (92, 99, 104, 111, 133 MiB on pf394a).
# On an isolate near its limit the next 1.2x step is the one that cannot be allocated: in Joan's
# pass Z window 53 requests died with "RangeError: Invalid array buffer length", with no isolate
# reset. Grow to what was asked plus 2 MiB of slack (then 1 and 0.5 MiB if that fails), never a
# fraction of the old size. The same loader runs approach a.
python3 - <<'PY3'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = """			var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
			overGrownHeapSize = Math.min(
				overGrownHeapSize,
				requestedSize + 100663296
			);"""
new = """			// Pagefeather (#394): the need plus a small slack, not 20 percent of the old size.
			var overGrownHeapSize = requestedSize + 2097152 / cutDown;"""
assert s.count(old) == 1, 'heap growth patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY3

# Heap views past 128 MiB (#518). In production workerd an ArrayBuffer is at most 128 MiB (2^27
# bytes, measured 2026-11-14 on a workers.dev probe), but the wasm memory grows past that (200 MiB
# grew). V8's %TypedArray%.prototype.subarray refuses a begin offset above that limit with
# "RangeError: Invalid array buffer length" (typed-array-subarray.tq step 17), so every
# HEAPU8.subarray(ptr, ...) with ptr above 128 MiB throws: the string read of js_module_onMessage
# (wp/v2 REST 500s with USE_ZEND_ALLOC=1), and the same way the FS writes and randomFill. The
# TypedArray(buffer, byteOffset, length) constructor does not cap the offset, so each heap view gets
# its own subarray that keeps the spec's index rules and builds the view that way. The constructor
# does cap a length argument at 128 MiB (probe v2: a 136 MiB view threw "Invalid typed array length:
# 142606336"), so a view to the end of the buffer is built with no length argument.
python3 - <<'PY4'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = """		HEAPU64 = new BigUint64Array(b);
	}"""
new = """		HEAPU64 = new BigUint64Array(b);
		// Pagefeather (#518): a subarray past the 128 MiB ArrayBuffer limit of workerd.
		[HEAP8, HEAP16, HEAPU8, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64, HEAP64, HEAPU64].forEach(
			(v) => Object.defineProperty(v, 'subarray', { value: pagefeatherHeapSubarray, configurable: true, writable: true })
		);
	}
	// %TypedArray%.prototype.subarray (begin and end: ToIntegerOrInfinity, negative from the end,
	// clamped to the length), through the constructor, which has no limit on the offset (#518).
	function pagefeatherHeapSubarray(begin, end) {
		var len = this.length;
		var b = begin === undefined ? 0 : Math.trunc(Number(begin)) || 0;
		b = b < 0 ? Math.max(len + b, 0) : Math.min(b, len);
		var e = end === undefined ? len : Math.trunc(Number(end)) || 0;
		e = e < 0 ? Math.max(len + e, 0) : Math.min(e, len);
		var off = this.byteOffset + b * this.BYTES_PER_ELEMENT, n = Math.max(e - b, 0);
		// The constructor caps a LENGTH argument at the same 128 MiB, but not a length it derives
		// from the buffer: a view that reaches the end of the buffer is built without one. A longer
		// span that ends before the end cannot be a view in workerd at all, and throws as the native does.
		if (off + n * this.BYTES_PER_ELEMENT === this.buffer.byteLength) return new this.constructor(this.buffer, off);
		return new this.constructor(this.buffer, off, n);
	}"""
assert s.count(old) == 1, 'heap subarray patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY4

# PHP pauses in open() while the Worker fetches a file (#563, #394 Gate 1, Path A). Under JSPI an import
# may suspend only if the loader wraps it in WebAssembly.Suspending, and the loader picks those imports
# in JS, by name (Asyncify.instrumentWasmImports): the wasm needs no change. Two edits:
# 1. __syscall_openat is wrapped, ONLY when the runtime was given a pagefeatherOpen hook (the
#    OPCACHE_REMOTE build). Without the hook nothing is wrapped, so a default build runs as before.
# 2. ___syscall_openat asks the hook first. A promise means the bytes are not here yet: PHP waits, then
#    the open runs as usual. A rejected promise fails the open with EIO (29), never a half file.
# Measured 2026-11-14 on production workerd (#394 issuecomment-6878010968): require, require_once from an
# autoloader, require inside try and file_get_contents all paused and resumed; a copy without edit 1 failed.
python3 - <<'PY5'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = "\t\t\t\t\tlet isAsyncifyImport =\n\t\t\t\t\t\toriginal.isAsync || importPattern.test(x);\n"
new = ("\t\t\t\t\tlet isAsyncifyImport =\n\t\t\t\t\t\toriginal.isAsync || importPattern.test(x) ||\n"
       "\t\t\t\t\t\t// Pagefeather (#563): open() may pause, only when a pagefeatherOpen hook is set.\n"
       "\t\t\t\t\t\t(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function');\n")
assert s.count(old) == 1, 'openat import pattern patch did not apply'
s = s.replace(old, new)
old = "\t\t\tvar mode = varargs ? syscallGetVarargI() : 0;\n\t\t\treturn FS.open(path, flags, mode).fd;\n"
new = """\t\t\tvar mode = varargs ? syscallGetVarargI() : 0;
\t\t\t// Pagefeather (#563): a promise from the hook means the file's bytes are being fetched.
\t\t\tvar pfWait = Module['pagefeatherOpen'] ? Module['pagefeatherOpen'](path) : null;
\t\t\tif (pfWait) {
\t\t\t\treturn pfWait.then(
\t\t\t\t\t() => {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\treturn FS.open(path, flags, mode).fd;
\t\t\t\t\t\t} catch (e) {
\t\t\t\t\t\t\tif (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
\t\t\t\t\t\t\treturn -e.errno;
\t\t\t\t\t\t}
\t\t\t\t\t},
\t\t\t\t\t() => -29
\t\t\t\t);
\t\t\t}
\t\t\treturn FS.open(path, flags, mode).fd;
"""
assert s.count(old) == 1, 'openat hook patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY5

# PHP pauses in a READ while the Worker fetches a site .php (#569, #394 Gate 2, the hybrid). OPcache
# opens a source it then serves from its cache without reading it (step 3: 37,721 of 37,721
# opened-but-unread site files were .php), so a .php is fetched at its FIRST READ, not its open.
# PHP's read() goes through php-wasm's own js_fd_read import, which is ALREADY Suspending in the stock
# importPattern; WASI fd_read and _mmap_js (readfile, copy, fpassthru use mmap) are made Suspending only
# when a pagefeatherRead hook is set. Each asks the hook first: a promise means wait, a rejection
# fails the read with EIO before any byte is delivered. There is no fd_pread import in this wasm.
# Proven on production workerd (Gate 0b, #394 issuecomment-6879785529, 9 of 9 cases x3).
python3 - <<'PY6'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = "(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function');"
new = ("(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function') ||\n"
       "\t\t\t\t\t\t// Pagefeather (#569): reads may pause, only when a pagefeatherRead hook is set.\n"
       "\t\t\t\t\t\t((x === 'fd_read' || x === '_mmap_js') && typeof Module['pagefeatherRead'] == 'function');")
assert s.count(old) == 1, 'read import pattern patch did not apply'
s = s.replace(old, new)
old = """			var stream = SYSCALLS.getStreamFromFD(fd);
			var num = doReadv(stream, iov, iovcnt);
			HEAPU32[pnum >> 2] = num;
			return 0;"""
new = """			var stream = SYSCALLS.getStreamFromFD(fd);
			// Pagefeather (#569): a .php whose pack is not held yet: wait for it, then read.
			var pfR = Module['pagefeatherRead'] ? Module['pagefeatherRead'](stream, 'read') : null;
			if (pfR) {
				return pfR.then(() => {
					try {
						var n2 = doReadv(stream, iov, iovcnt);
						HEAPU32[pnum >> 2] = n2;
						return 0;
					} catch (e) {
						if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
						return e.errno;
					}
				}, () => 29);
			}
			var num = doReadv(stream, iov, iovcnt);
			HEAPU32[pnum >> 2] = num;
			return 0;"""
assert s.count(old) == 1, 'fd_read hook patch did not apply'
s = s.replace(old, new)
old = """			var stream = SYSCALLS.getStreamFromFD(fd);
			var res = FS.mmap(stream, len, offset, prot, flags);"""
new = """			var stream = SYSCALLS.getStreamFromFD(fd);
			// Pagefeather (#569): the same for an mmap of a .php.
			var pfM = Module['pagefeatherRead'] ? Module['pagefeatherRead'](stream, 'mmap') : null;
			if (pfM) {
				return pfM.then(() => {
					try {
						var r2 = FS.mmap(stream, len, offset, prot, flags);
						HEAP32[allocated >> 2] = r2.allocated;
						HEAPU32[addr >> 2] = r2.ptr;
						return 0;
					} catch (e) {
						if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
						return -e.errno;
					}
				}, () => -29);
			}
			var res = FS.mmap(stream, len, offset, prot, flags);"""
assert s.count(old) == 1, 'mmap hook patch did not apply'
s = s.replace(old, new)
old = """			var stream;
			try {
				stream = SYSCALLS.getStreamFromFD(fd);
				HEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);
				return 0;"""
new = """			var stream;
			try {
				stream = SYSCALLS.getStreamFromFD(fd);
				// Pagefeather (#569): js_fd_read is PHP's read(); already Suspending in the stock pattern.
				var pfJ = Module['pagefeatherRead'] ? Module['pagefeatherRead'](stream, 'read') : null;
				if (pfJ) {
					return pfJ.then(() => {
						try {
							HEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);
							return 0;
						} catch (e2) {
							if (typeof FS == 'undefined' || !(e2.name === 'ErrnoError')) throw e2;
							return e2.errno;
						}
					}, () => 29);
				}
				HEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);
				return 0;"""
assert s.count(old) == 1, 'js_fd_read hook patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY6

# The module reserves 64 MiB (1024 pages) at start. A Worker isolate has 128 MB
# for everything, so start at 24 MiB (384 pages) and let it grow on demand.
# Its static data ends at 12.4 MiB. Both values are 2-byte LEB128, so the patch
# keeps every offset.
python3 - <<'PY'
src = 'node_modules/@php-wasm/web-8-3/jspi/8_3_36/php_8_3.wasm'
dst = 'vendor/php_8_3.wasm'
b = bytearray(open(src, 'rb').read())
def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i
i = 8; done = False
while i < len(b):
    sid = b[i]; i += 1; size, i = leb(b, i); start = i
    if sid == 5:
        n, j = leb(b, i); flags = b[j]; j += 1; k = j
        initial, j = leb(b, j)
        assert initial == 1024 and j - k == 2, (initial, j - k)
        b[k:j] = bytes([0x80, 0x03])  # 384
        done = True
    i = start + size
assert done, 'memory section not found'
# OPcache runs only under the SAPIs in its own list (Apache, FPM, FastCGI,
# FrankenPHP, LiteSpeed, uWSGI). php-wasm's SAPI is "wasm", so OPcache was off
# (measured 2026-11-04: opcache_compile_file() returned false). Change the
# list entry "frankenphp" to "wasm". Only the first 5 bytes change, to
# "wasm\0", so a string that shares the tail ("php", "enphp") is not touched.
old = b'\x00frankenphp\x00'
assert b.count(old) == 1, b.count(old)
i = b.find(old)
b[i + 1:i + 6] = b'wasm\x00'
open(dst, 'wb').write(b)
print('patched initial memory: 1024 -> 384 pages; OPcache SAPI list: frankenphp -> wasm')
PY
