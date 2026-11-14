// node --test spikes/b2-wordpress/tests/inflate-arena.test.mjs (#394 step 2, LAZY_ARENA)
// The arena with real deflated data and a lazy getter shaped as index.js attachLazyContents: every
// read's bytes must equal the file's (sha256), across ring reuse, eviction, re-inflate and two
// interleaved requests. A mutation that skips the eviction turns it red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createArena } from '../inflate-arena.mjs';

const require = createRequire(import.meta.url);
const { deflateSync, inflateSync } = require('fflate');
const sha = (u8) => createHash('sha256').update(u8).digest('hex');

// A deterministic pseudo-random generator, so a failure repeats.
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Files of 1 KiB to 760 KiB (the largest OPcache entry in the build) with mixed content.
function makeFiles(n, rnd) {
	const files = [];
	for (let i = 0; i < n; i++) {
		const size = 1024 + Math.floor(rnd() * 760 * 1024);
		const raw = new Uint8Array(size);
		for (let j = 0; j < size; j++) raw[j] = (j % 97) ^ ((i * 31) & 255) ^ (rnd() < 0.05 ? Math.floor(rnd() * 256) : 0);
		files.push({ raw, packed: deflateSync(raw), sum: sha(raw) });
	}
	return files;
}

// The lazy node as attachLazyContents makes it (inflate on first read, drop() nulls it), with the
// arena as index.js passes it. counts.reinflates counts a second inflate of one file.
function lazyNode(file, arena, counts) {
	let contents = null;
	let inflations = 0;
	const drop = () => { contents = null; };
	return {
		read() {
			if (contents === null) {
				if (inflations++ > 0) counts.reinflates++;
				const out = arena ? arena.alloc(file.raw.length, drop) : null;
				contents = inflateSync(file.packed, { out: out || new Uint8Array(file.raw.length) });
			}
			return contents.slice(); // MEMFS copies out of contents into the WASM heap
		},
	};
}

test('ring: regions wrap, overlaps are evicted, a file larger than the arena gets null', () => {
	const a = createArena(100);
	let dropped = [];
	const d = (name) => () => dropped.push(name);
	assert.equal(a.alloc(40, d('a')).length, 40);
	assert.equal(a.alloc(40, d('b')).length, 40);
	assert.equal(a.alloc(40, d('c')).length, 40); // does not fit at 80: wraps to 0, evicts a
	assert.deepEqual(dropped, ['a']);
	assert.equal(a.alloc(30, d('d')).length, 30); // 40..70: overlaps b
	assert.deepEqual(dropped, ['a', 'b']);
	assert.equal(a.alloc(101, d('big')), null);
	assert.equal(a.counts.over, 1);
	a.evictAll();
	assert.deepEqual(dropped.sort(), ['a', 'b', 'c', 'd']);
	assert.equal(a.liveCount(), 0);
});

test('every read returns the file\'s exact bytes across ring reuse and re-inflate (2 MiB arena, 120 files)', () => {
	const rnd = rng(7);
	const files = makeFiles(120, rnd);
	const arena = createArena(2 * 1048576);
	const counts = { reinflates: 0 };
	const nodes = files.map((f) => lazyNode(f, arena, counts));
	let reads = 0;
	for (let k = 0; k < 1500; k++) {
		const i = Math.floor(rnd() * nodes.length);
		assert.equal(sha(nodes[i].read()), files[i].sum, `file ${i} read ${k}`);
		reads++;
	}
	assert.ok(arena.counts.evicts > 0, 'the ring was reused, so the test exercised eviction');
	assert.ok(counts.reinflates > 0);
	assert.equal(reads, 1500);
});

test('two interleaved requests with an evictAll between them: bytes stay exact; re-inflates are counted', () => {
	const rnd = rng(11);
	const files = makeFiles(60, rnd);
	const arena = createArena(2 * 1048576);
	const counts = { reinflates: 0 };
	const nodes = files.map((f) => lazyNode(f, arena, counts));
	const reqA = Array.from({ length: 200 }, () => Math.floor(rnd() * 30)); // A reads files 0..29
	const reqB = Array.from({ length: 200 }, () => 30 + Math.floor(rnd() * 30)); // B reads 30..59
	for (let k = 0; k < 200; k++) {
		assert.equal(sha(nodes[reqA[k]].read()), files[reqA[k]].sum);
		assert.equal(sha(nodes[reqB[k]].read()), files[reqB[k]].sum);
		if (k === 99) arena.evictAll(); // one request ends while the other is still running (evictLazy)
	}
	assert.ok(counts.reinflates > 0, 'files evicted by the other request re-inflate, and the count shows it');
});

test('control: without the eviction, a reused region hands a stale view to a node (the guard matters)', () => {
	const rnd = rng(3);
	const files = makeFiles(40, rnd);
	const a = createArena(2 * 1048576);
	const noEvict = { alloc: (n) => a.alloc(n, () => {}), evictAll() {}, counts: a.counts }; // drop() never called
	const nodes = files.map((f) => lazyNode(f, noEvict, { reinflates: 0 }));
	let bad = 0;
	for (let k = 0; k < 600; k++) {
		const i = Math.floor(rnd() * nodes.length);
		if (sha(nodes[i].read()) !== files[i].sum) bad++;
	}
	assert.ok(bad > 0, `with no eviction some reads return another file's bytes (bad ${bad})`);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: off by default; both inflate sites take the arena; evictLazy empties it; counts reach perf and the ledger', () => {
	assert.match(src, /function arenaOn\(\) \{ return !!\(ENV && ENV\.LAZY_ARENA === 'on'\); \}/);
	assert.equal((src.match(/inflateSync\(raw, \{ out: \(out && out\(size\)\) \|\| new Uint8Array\(size\) \}\)/g) || []).length, 2, 'zipEntries.data and lazyEntryData');
	assert.ok(!/inflateSync\(raw, \{ out: new Uint8Array\(size\) \}\)/.test(src), 'no inflate site left outside the arena path');
	// #569: a PINNED file (a remote site file) never inflates into the arena; every other one does.
	assert.match(src, /const out = arenaOn\(\) && !pin \? \(n\) => \{ const v = getArena\(\)\.alloc\(n, drop\); inArena = !!v; return v; \} : null;/);
	assert.match(src, /if \(inflateArena\) inflateArena\.evictAll\(\);/);
	assert.match(src, /reinflates: stats\.reinflates - start\.reinflates/);
	assert.match(src, /arenaEvict: inflateArena\.counts\.evicts - ledgerInfl0\.ae/);
});
