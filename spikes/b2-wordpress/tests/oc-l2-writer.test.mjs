// node --test spikes/b2-wordpress/tests/oc-l2-writer.test.mjs (#500)
// The object-cache L2 KV writer against a stand-in KV that answers 429 past 1 write per second per
// key, as KV does. A fake clock; sleep() advances it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createL2Writer } from '../oc-l2-writer.mjs';

function rig(opts = {}) {
	let t = 1_000_000;
	const store = new Map();
	const writesAt = new Map(); // key -> last accepted write time
	const log = { puts: 0, ok: 0, r429: 0, dels: 0 };
	const kvPut = async (k, v) => {
		log.puts++;
		if (t - (writesAt.get(k) ?? -Infinity) < 1000) { log.r429++; throw new Error('KV PUT failed: 429 Too Many Requests'); }
		writesAt.set(k, t); store.set(k, v); log.ok++;
	};
	const kvDel = async (k) => { log.dels++; store.delete(k); };
	const clock = { now: () => t, advance: (ms) => { t += ms; } };
	const w = createL2Writer({ put: kvPut, del: kvDel, now: clock.now, sleep: async (ms) => { t += ms; }, ...opts });
	return { w, store, log, clock, kvPut };
}

test('THE LOAD-RUN CASE: 50 identical sets of one key within a second make ONE put, no 429', async () => {
	const { w, log } = rig({ capPerRequest: 1000 });
	const ps = [];
	for (let i = 0; i < 50; i++) { const p = w.set('oc:terms', 'same', 60); if (p) ps.push(p); }
	await Promise.all(ps);
	assert.equal(log.puts, 1);
	assert.equal(log.r429, 0);
	assert.equal(w.counts.skipped, 49);
});

test('control: a naive write-through (the code before #500) gets 429s from the same stand-in', async () => {
	const { log, kvPut } = rig();
	await Promise.all(Array.from({ length: 50 }, () => kvPut('oc:terms', 'same').catch(() => {})));
	assert.equal(log.r429, 49, 'the stand-in really limits, so the test can see the storm');
});

test('a changed value inside the gap is written once, after the gap, with the LATEST value', async () => {
	const { w, store, log } = rig();
	await w.set('k', 'v1', 60);
	const a = w.set('k', 'v2', 60);
	const b = w.set('k', 'v3', 60); // newer, inside the same gap
	await Promise.all([a, b].filter(Boolean));
	assert.equal(store.get('k'), 'v3', 'KV ends on the newest value, never an older one');
	assert.equal(log.puts, 2);
	assert.equal(log.r429, 0);
	assert.equal(w.counts.coalesced, 2);
});

test('a value read from KV is not written back unchanged; one near KV expiry is refreshed', async () => {
	const { w, log, clock } = rig({ refreshAfterMs: 45000 });
	w.noteRead('k', 'kv');
	assert.equal(w.set('k', 'kv', 60), null);
	assert.equal(log.puts, 0);
	clock.advance(46000);
	await w.set('k', 'kv', 60);
	assert.equal(log.puts, 1, 'after refreshAfterMs the same value is written again, so the KV copy does not expire');
});

test('the per-request cap holds, and a new request starts it again', async () => {
	const { w, log } = rig({ capPerRequest: 3 });
	for (let i = 0; i < 6; i++) await w.set('k' + i, 'v', 60);
	assert.equal(log.puts, 3);
	assert.equal(w.counts.capped, 3);
	w.beginRequest();
	await w.set('k9', 'v', 60);
	assert.equal(log.puts, 4);
});

test('a delete always goes through, and cancels a pending write of the same key', async () => {
	const { w, store, log } = rig();
	await w.set('k', 'v1', 60);
	const pend = w.set('k', 'v2', 60); // inside the gap: pending
	await w.del('k');
	await pend;
	assert.equal(log.dels, 1);
	assert.equal(store.has('k'), false, 'the deleted key is not written back by the pending write');
});

test('a 429 is counted, not thrown (no unhandled rejection)', async () => {
	let t = 0;
	const w = createL2Writer({ put: async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); }, del: async () => {}, now: () => t, sleep: async (ms) => { t += ms; } });
	await w.set('k', 'v', 60);
	assert.equal(w.counts.throttled, 1);
	assert.equal(w.counts.failed, 0);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: every KV put and delete goes through the writer; reads are noted; the cap resets per request', () => {
	assert.ok(!/ENV\.OC_KV\.put\(ocKvKey/.test(src), 'no direct KV put is left in objectCacheOp');
	assert.ok(!/waitUntil\(ENV\.OC_KV\.delete\(/.test(src), 'no direct KV delete is left');
	// #352: the set still goes through the writer, inside doSet, which a request frame holds until it is kept.
	assert.match(src, /const k2 = ocKvKey\(op\.k\), v2 = op\.v, c2 = ocCtx; const doSet = \(\) => \{ try \{ const w = ocL2Writer\(\)\.set\(k2, v2, ttl\); if \(w\) c2\.waitUntil\(w\); \} catch \{\} \};/);
	assert.match(src, /if \(!\(undoLog && undoLog\.defer\(doSet\)\)\) doSet\(\);/);
	assert.match(src, /ocL2Writer\(\)\.noteRead\(ocKvKey\(k\), kv\);/);
	assert.match(src, /ocCtx\.waitUntil\(ocL2Writer\(\)\.del\(ocKvKey\(k\)\)\)/);
	assert.match(src, /if \(ocL2W\) ocL2W\.beginRequest\(\);/);
	assert.match(src, /l2w: \{ \.\.\.ocL2W\.counts \}/);
});
