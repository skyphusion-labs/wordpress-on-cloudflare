// node --test spikes/b2-wordpress/tests/opcache-remote.test.mjs (#563, #394 Gate 1). Needs npm ci and
// ./prepare.sh in spikes/b2-wordpress (vendor/php_8_3.js, vendor/php_8_3.wasm), and a Node whose V8 has
// JSPI (WebAssembly.Suspending): CI runs it on Node 24, as the other loader tests.
//
// The real loader and the real PHP. An OPcache file cache is made by one runtime from a script that
// returns "OLD". A second runtime gets the source changed to "NEW", and the cache files ONLY as remote
// files in a pack (remote-packs.mjs). With validate_timestamps 0, "OLD" can come from nowhere but the
// fetched pack, and "NEW" means OPcache compiled from source (the clean miss). So each case reads:
//   the pack fetched and checked        -> OLD
//   any failure (404, length, SHA, cap) -> NEW, never an error, never a half file
// A loader copy without the import-pattern edit must NOT give OLD (the guard can fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemotePacks } from '../remote-packs.mjs';

const B2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(B2, 'package.json'));
globalThis.require ??= require; // the loader takes the node path in node and calls require
const { loadPHPRuntime, PHP, setPhpIniEntries, __private__dont__use } = require('@php-wasm/universal');
const { zipSync, unzipSync } = require('fflate');

const PATTERN_EDIT = "(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function')";
const OC = '/internal/shared/opcache';
const dir = mkdtempSync(join(tmpdir(), 'oc563-'));
const src = readFileSync(join(B2, 'vendor/php_8_3.js'), 'utf8');
const wasm = new WebAssembly.Module(readFileSync(join(B2, 'vendor/php_8_3.wasm')));
writeFileSync(join(dir, 'fixed.mjs'), src);
writeFileSync(join(dir, 'nopattern.mjs'), src.split(PATTERN_EDIT).join('false'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const INI = {
	'opcache.enable': '1',
	'opcache.enable_cli': '1',
	'opcache.file_cache': OC,
	'opcache.file_cache_only': '1',
	'opcache.validate_timestamps': '0',
	'opcache.file_update_protection': '0',
};

async function boot(file, hook, seen) {
	const loader = await import(join(dir, file));
	const id = await loadPHPRuntime(loader, {
		ENV: { USE_ZEND_ALLOC: '0' },
		...(hook ? { pagefeatherOpen: hook } : {}),
		instantiateWasm(imports, done) {
			if (seen) seen.openatSuspending = imports.env.__syscall_openat instanceof WebAssembly.Suspending;
			const inst = new WebAssembly.Instance(wasm, imports);
			done(inst, wasm);
			return inst.exports;
		},
	});
	const php = new PHP(id);
	await setPhpIniEntries(php, INI);
	php.mkdir('/src');
	return php;
}

function walk(FS, d, out = []) {
	for (const n of FS.readdir(d)) {
		if (n === '.' || n === '..') continue;
		const p = d + '/' + n;
		if (FS.isDir(FS.stat(p).mode)) walk(FS, p, out);
		else out.push(p);
	}
	return out;
}

// The OPcache file cache of a script returning "OLD", as a pack and its index.
async function makeCache() {
	const php = await boot('fixed.mjs');
	php.writeFile('/src/t.php', '<?php return "OLD";');
	const r = await php.run({ code: '<?php echo require "/src/t.php";' });
	assert.equal(r.text, 'OLD');
	const FS = php[__private__dont__use].FS;
	const files = {};
	for (const p of walk(FS, OC)) files[p.slice(OC.length + 1)] = FS.readFile(p);
	assert.ok(Object.keys(files).some((n) => n.endsWith('/src/t.php.bin')), 'the first runtime wrote a file cache entry: ' + Object.keys(files));
	const pack = zipSync(files, { level: 6 });
	const index = {
		id: 'test',
		packs: [{ name: 'warm-0.zip', bytes: pack.length, sha256: createHash('sha256').update(pack).digest('hex') }],
		files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, [0, b.length]])),
	};
	return { pack, index };
}

// zip entries in the shape of index.js zipEntries (name, data(out)), from fflate.
const parse = (bytes) => Object.entries(unzipSync(bytes)).map(([name, b]) => ({ name, data: () => b }));

// A second runtime: source now says NEW, the cache files are remote nodes. Returns what PHP printed.
async function runRemote({ file = 'fixed.mjs', index, fetchPack, cap, holdBytes, requests = 1, sources = { '/src/t.php': '<?php return "NEW";' }, code = '<?php echo require "/src/t.php";' }) {
	const stats = {};
	const remote = createRemotePacks({ index, fetchPack, parse, stats, cap, holdBytes });
	const hook = (path) => (path.startsWith(OC + '/') ? remote.open(path.slice(OC.length + 1)) : null);
	const php = await boot(file, hook);
	const FS = php[__private__dont__use].FS;
	for (const [p, body] of Object.entries(sources)) php.writeFile(p, body);
	for (const [name, [, size]] of Object.entries(index.files)) {
		const full = OC + '/' + name;
		php.mkdir(full.slice(0, full.lastIndexOf('/')));
		FS.writeFile(full, new Uint8Array(0));
		const node = FS.lookupPath(full).node;
		Object.defineProperty(node, 'contents', {
			configurable: true,
			get() {
				const b = remote.data(name);
				if (!b) throw new FS.ErrnoError(29);
				return b;
			},
			set() {},
		});
		Object.defineProperty(node, 'usedBytes', { configurable: true, get: () => size, set() {} });
	}
	const outs = [];
	for (let i = 0; i < requests; i++) {
		try {
			const r = await php.run({ code });
			outs.push(r.text);
		} catch (e) {
			outs.push('threw: ' + String(e.message).slice(0, 120));
		}
		remote.endRequest();
		stats.heldMax = Math.max(stats.heldMax || 0, remote.lastHeldMax());
	}
	return { outs, stats };
}

const { pack, index } = await makeCache();
const good = async () => pack.slice();

test('the fetched and checked pack is used: OLD, one fetch', async () => {
	const { outs, stats } = await runRemote({ index, fetchPack: good });
	assert.deepEqual(outs, ['OLD']);
	assert.equal(stats.rfN, 1);
	assert.equal(stats.rfFail, 0);
	assert.equal(stats.rfBytes, pack.length);
});

test('a pack that answers 404 is a clean miss: NEW, counted as a failure', async () => {
	const { outs, stats } = await runRemote({ index, fetchPack: async () => { throw new Error('warm-0.zip answered 404'); } });
	assert.deepEqual(outs, ['NEW']);
	assert.equal(stats.rfFail, 1);
});

test('a short pack (length mismatch) is never used: NEW', async () => {
	const { outs, stats } = await runRemote({ index, fetchPack: async () => pack.slice(0, pack.length - 7) });
	assert.deepEqual(outs, ['NEW']);
	assert.equal(stats.rfFail, 1);
});

test('a pack with the right length but other bytes (SHA-256 mismatch) is never used: NEW', async () => {
	const bad = pack.slice();
	bad[bad.length >> 1] ^= 0xff;
	const { outs, stats } = await runRemote({ index, fetchPack: async () => bad });
	assert.deepEqual(outs, ['NEW']);
	assert.equal(stats.rfFail, 1);
});

test('the fetch cap fails clean before the subrequest limit: NEW, no fetch made', async () => {
	let calls = 0;
	const { outs, stats } = await runRemote({ index, cap: 0, fetchPack: async () => { calls++; return pack.slice(); } });
	assert.deepEqual(outs, ['NEW']);
	assert.equal(calls, 0);
	assert.equal(stats.rfN, 0);
	assert.ok(stats.rfCapped >= 1);
});

test('a failed pack is retried on the NEXT request, not the same one', async () => {
	let calls = 0;
	const fetchPack = async () => { if (calls++ === 0) throw new Error('first fetch fails'); return pack.slice(); };
	const { outs, stats } = await runRemote({ index, fetchPack, requests: 2 });
	assert.deepEqual(outs, ['NEW', 'OLD']);
	assert.equal(calls, 2);
	assert.equal(stats.rfFail, 1);
});

test('the guard can fail: without the import-pattern edit the pack is NOT used', async () => {
	const { outs } = await runRemote({ file: 'nopattern.mjs', index, fetchPack: good });
	assert.notEqual(outs[0], 'OLD', 'a loader without the edit must not read the remote cache');
});

test('default OFF: with no pagefeatherOpen hook, open() is not wrapped at all', async () => {
	const off = {};
	await boot('fixed.mjs', null, off);
	assert.equal(off.openatSuspending, false);
	const on = {};
	await boot('fixed.mjs', () => null, on);
	assert.equal(on.openatSuspending, true);
});

// Two scripts, each in its OWN pack, the second pack evicting the first (a budget of 1 byte keeps only
// the pack being opened). A cold boot streams: both come from the cache (OLD), two fetches, and the
// request never held more than one pack.
test('a cold boot streams through packs under the held budget: OLD and OLD, one pack held at a time', async () => {
	const php = await boot('fixed.mjs');
	php.writeFile('/src/t1.php', '<?php return "OLD1";');
	php.writeFile('/src/t2.php', '<?php return "OLD2";');
	assert.equal((await php.run({ code: '<?php echo require "/src/t1.php", require "/src/t2.php";' })).text, 'OLD1OLD2');
	const FS = php[__private__dont__use].FS;
	const all = {};
	for (const p of walk(FS, OC)) all[p.slice(OC.length + 1)] = FS.readFile(p);
	const groups = [{}, {}];
	for (const [n, b] of Object.entries(all)) groups[n.endsWith('/src/t2.php.bin') ? 1 : 0][n] = b;
	assert.ok(Object.keys(groups[1]).length === 1, 'one cache file for t2');
	const packs = groups.map((g) => zipSync(g, { level: 6 }));
	const idx = {
		id: 'test2',
		packs: packs.map((p, i) => ({ name: 'oc-' + i + '.zip', bytes: p.length, sha256: createHash('sha256').update(p).digest('hex') })),
		files: Object.fromEntries(groups.flatMap((g, i) => Object.entries(g).map(([n, b]) => [n, [i, b.length]]))),
	};
	const { outs, stats } = await runRemote({
		index: idx,
		holdBytes: 1,
		fetchPack: async (name) => packs[Number(name.slice(3, 4))].slice(),
		sources: { '/src/t1.php': '<?php return "NEW1";', '/src/t2.php': '<?php return "NEW2";' },
		code: '<?php echo require "/src/t1.php", require "/src/t2.php";',
	});
	assert.deepEqual(outs, ['OLD1OLD2']);
	assert.equal(stats.rfN, 2);
	assert.equal(stats.rfFail, 0);
	assert.equal(stats.heldMax, Math.max(...packs.map((p) => p.length)), 'never more than one pack held');
});
