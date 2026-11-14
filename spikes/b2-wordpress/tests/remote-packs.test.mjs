// node --test spikes/b2-wordpress/tests/remote-packs.test.mjs (#563). The held-pack budget of
// remote-packs.mjs with synthetic packs: a cold boot STREAMS through the packs (at most the budget
// held, least recently used out first, the pack being opened always kept), an evicted pack is
// fetched again when one of its files is opened again, nothing is held across requests, and the
// request's high-water of held bytes is reported (x-perf rfHeldKiB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRemotePacks, createFetchBudget, REMOTE_HOLD_BYTES, REMOTE_FETCH_CAP, SITE_FETCH_CAP } from '../remote-packs.mjs';

// Three packs of 1000 bytes; file fN lives in pack N. parse() gives each pack one entry.
const bytes = [0, 1, 2].map((n) => new Uint8Array(1000).fill(n + 1));
const index = {
	id: 't',
	packs: bytes.map((b, n) => ({ name: 'oc-' + n + '.zip', bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') })),
	files: { f0: [0, 4], f1: [1, 4], f2: [2, 4] },
};
const parse = (b) => [{ name: 'f' + (b[0] - 1), data: () => b.subarray(0, 4) }];
function make(holdBytes, cap) {
	const fetched = [];
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, cap, holdBytes, fetchPack: async (name) => { fetched.push(name); return bytes[Number(name.slice(3, 4))].slice(); } });
	return { r, fetched, stats };
}
const open = async (r, f) => { const p = r.open(f); if (p) await p; };

test('a cold boot streams: with a 2-pack budget, the third pack evicts the first', async () => {
	const { r, fetched, stats } = make(2000);
	await open(r, 'f0');
	await open(r, 'f1');
	assert.equal(r.heldPacks(), 2);
	await open(r, 'f2');
	assert.equal(r.heldPacks(), 2, 'never more than the budget');
	assert.equal(r.data('f0'), null, 'f0 was evicted: its bytes are gone (a read now fails with EIO)');
	assert.ok(r.data('f2'), 'the pack just opened is held');
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip', 'oc-2.zip']);
	assert.equal(stats.rfN, 3);
});

test('an evicted pack is fetched again when its file is opened again (and counted)', async () => {
	const { r, fetched, stats } = make(2000);
	for (const f of ['f0', 'f1', 'f2', 'f0']) await open(r, f);
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip', 'oc-2.zip', 'oc-0.zip']);
	assert.equal(stats.rfN, 4);
	assert.ok(r.data('f0'));
});

test('a held pack is used again without a fetch, and is the most recent after', async () => {
	const { r, fetched } = make(2000);
	for (const f of ['f0', 'f1', 'f0', 'f2']) await open(r, f);
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip', 'oc-2.zip'], 'f0 reopened while held: no fetch');
	assert.ok(r.data('f0'), 'f0 was touched last before f2, so f1 was the one evicted');
	assert.equal(r.data('f1'), null);
});

test('the pack being opened is kept even when it alone is over the budget', async () => {
	const { r } = make(1);
	await open(r, 'f0');
	assert.ok(r.data('f0'));
	assert.equal(r.heldPacks(), 1);
	await open(r, 'f1');
	assert.equal(r.heldPacks(), 1);
	assert.ok(r.data('f1'));
});

test('nothing is held across requests, and the request high-water is reported', async () => {
	const { r } = make(2000);
	await open(r, 'f0');
	await open(r, 'f1');
	await open(r, 'f2');
	r.endRequest();
	assert.equal(r.heldPacks(), 0);
	assert.equal(r.lastHeldMax(), 2000, 'the high-water of the request just ended');
	await open(r, 'f2');
	r.endRequest();
	assert.equal(r.lastHeldMax(), 1000, 'a new request starts from 0');
});

test('the per-request cap counts refetches too, and resets with the request', async () => {
	const { r, stats } = make(1000, 2);
	await open(r, 'f0');
	await open(r, 'f1');
	await assert.rejects(r.open('f2'), /cap 2/);
	assert.equal(stats.rfCapped, 1);
	r.endRequest();
	await open(r, 'f2');
	assert.equal(stats.rfN, 3);
});

test('distinct packs per request tell thrash from spread (x-perf rfPacks)', async () => {
	const { r, stats } = make(2000);
	for (const f of ['f0', 'f1', 'f2', 'f0']) await open(r, f);
	r.endRequest();
	assert.equal(stats.rfN, 4, 'four fetches');
	assert.equal(r.lastDistinct(), 3, 'of three distinct packs: one refetch, the thrash');
	await open(r, 'f1');
	r.endRequest();
	assert.equal(r.lastDistinct(), 1, 'a new request counts from 0');
});

test('the defaults are the measured choice: 4 MiB held (3 packs of about 1.1 MiB), cap 64', () => {
	// opcache-build run 43603733149: 2 MiB held ONE pack and thrashed (86 fetches over 4 pages);
	// 4 MiB held three (39 fetches, 20 on the cold boot, peak 3,270 KiB). The lead chose 4 MiB.
	assert.equal(REMOTE_HOLD_BYTES, 4096 * 1024);
	assert.equal(REMOTE_FETCH_CAP, 64);
});

// #569 (Gate 2): site packs, a budget shared with OPcache, one retry, and a hot pack.
const hotBytes = new Uint8Array(500).fill(9);
const sidx = {
	id: 's',
	hot: { name: 'site-hot.zip', bytes: hotBytes.length, sha256: createHash('sha256').update(hotBytes).digest('hex') },
	packs: index.packs.map((p, n) => ({ ...p, name: 'st-' + n + '.zip' })),
	files: { f0: [0, 4], f1: [1, 4], f2: [2, 4], h: [-1, 4] },
};
const sparse = (b) => (b[0] === 9 ? [{ name: 'h', data: () => b.subarray(0, 4) }] : parse(b));
function site({ budget, retries = 1, failFirst = 0, holdBytes = 2000 } = {}) {
	const fetched = [];
	const waits = [];
	const stats = {};
	let fails = failFirst;
	const r = createRemotePacks({
		index: sidx, parse: sparse, stats, prefix: 'rs', budget, limit: 'hard', retries, retryDelayMs: 25,
		sleep: async (ms) => { waits.push(ms); }, holdBytes,
		fetchPack: async (name) => {
			fetched.push(name);
			if (fails > 0) { fails--; throw new Error(name + ' answered 503'); }
			return name === 'site-hot.zip' ? hotBytes.slice() : bytes[Number(name.slice(3, 4))].slice();
		},
	});
	return { r, fetched, waits, stats };
}

test('#569 the site counters have their own prefix, rs*, and leave rf* alone', async () => {
	const { r, stats } = site();
	await open(r, 'f0');
	assert.equal(stats.rsN, 1);
	assert.equal(stats.rfN, undefined);
});

test('#569 one retry of a failed site pack, after the fixed delay, and it is counted', async () => {
	const { r, fetched, waits, stats } = site({ failFirst: 1 });
	await open(r, 'f1');
	assert.deepEqual(fetched, ['st-1.zip', 'st-1.zip']);
	assert.deepEqual(waits, [25]);
	assert.equal(stats.rsRetry, 1);
	assert.equal(stats.rsFail, 0);
	assert.equal(stats.rsN, 2, 'the retry is a fetch, and a subrequest');
	assert.ok(r.data('f1'));
});

test('#569 a second failure fails the open: ONE retry only, counted as a failure', async () => {
	const { r, fetched, stats } = site({ failFirst: 2 });
	await assert.rejects(r.open('f1'), /503/);
	assert.equal(fetched.length, 2);
	assert.equal(stats.rsRetry, 1);
	assert.equal(stats.rsFail, 1);
});

test('#569 the budget is shared: OPcache stops at the soft cap, site may go on to the hard cap', async () => {
	const budget = createFetchBudget({ soft: 2, hard: 3 });
	const ostats = {};
	const opc = createRemotePacks({ index, parse, stats: ostats, budget, limit: 'soft', holdBytes: 1, fetchPack: async (name) => bytes[Number(name.slice(3, 4))].slice() });
	await open(opc, 'f0');
	await open(opc, 'f1');
	await assert.rejects(opc.open('f2'), /cap/);
	assert.equal(ostats.rfCapped, 1, 'OPcache refused at the soft cap (a compile)');
	const s = site({ budget });
	await open(s.r, 'f0');
	assert.equal(s.stats.rsN, 1, 'site took the third, under the hard cap');
	await assert.rejects(s.r.open('f1'), /cap/);
	assert.equal(s.stats.rsCapped, 1);
	budget.reset();
	await open(opc, 'f2');
	assert.equal(ostats.rfN, 3, 'a new request starts from 0');
});

test('#569 a retry needs budget too: at the hard cap the retry is refused and the open fails', async () => {
	const budget = createFetchBudget({ soft: 1, hard: 1 });
	const { r, fetched, stats } = site({ budget, failFirst: 1 });
	await assert.rejects(r.open('f0'));
	assert.equal(fetched.length, 1, 'no second fetch past the cap');
	assert.equal(stats.rsCapped, 1);
});

test('#569 the hot pack is fetched once per runtime and held across requests, outside the LRU', async () => {
	const { r, fetched } = site({ holdBytes: 1 });
	await open(r, 'h');
	await open(r, 'f0');
	await open(r, 'f1');
	assert.ok(r.data('h'), 'the hot file is still held: the LRU never evicts the hot pack');
	r.endRequest();
	await open(r, 'h');
	assert.ok(r.data('h'));
	assert.deepEqual(fetched.filter((n) => n === 'site-hot.zip'), ['site-hot.zip'], 'fetched ONCE');
	assert.equal(r.heldPacks(), 0, 'the request packs are gone; the hot pack is not counted among them');
});

test('#569 the defaults: site hard cap 96', () => {
	assert.equal(SITE_FETCH_CAP, 96);
});

// #569 audit (the #568 class: a promise that outlives its request). workerd may drop work that is
// not awaited by a live request, so a fetch in flight when a request ends must not be WAITED on by
// the next request, and its late result must not land in the next request's held packs.
test('a fetch still in flight at endRequest is not waited on by the next request', async () => {
	let release;
	const hang = new Promise(() => {}); // a fetch workerd dropped: it never settles
	let calls = 0;
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, holdBytes: 2000, fetchPack: async (name) => {
		calls++;
		if (calls === 1) return hang;
		return bytes[Number(name.slice(3, 4))].slice();
	} });
	const first = r.open('f0'); // request 1 ends while this is in flight
	assert.ok(first);
	r.endRequest();
	const second = r.open('f0'); // request 2 must fetch again, not wait on request 1's promise
	assert.ok(second && second !== first, 'a NEW fetch, not the dropped one');
	await second;
	assert.ok(r.data('f0'));
	assert.equal(calls, 2);
});

test('a late result of an ended request does not land in the next request', async () => {
	let finish;
	const late = new Promise((ok) => { finish = ok; });
	let calls = 0;
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, holdBytes: 2000, fetchPack: async (name) => {
		calls++;
		return calls === 1 ? late : bytes[Number(name.slice(3, 4))].slice();
	} });
	const first = r.open('f1');
	r.endRequest();
	finish(bytes[1].slice()); // request 1's fetch settles AFTER its request ended
	await first.catch(() => {});
	assert.equal(r.data('f1'), null, 'not held in request 2');
	assert.equal(r.heldPacks(), 0);
});
