// node --expose-gc --test spikes/b2-wordpress/tests/drop-runtime.test.mjs (#566)
// A dropped PHP runtime must be RELEASED, never mid-use, and the release must not depend on a promise
// continuation. #568 chained the release on the PHP queue and registered it nowhere: on pf394a the ledger
// then still read wasmMiB 86.7 (lastBootedPhp set) after /_evict, so releaseRuntime never ran. workerd
// drops the continuations of a finished or aborted request, and Node runs every continuation, so the
// old test passed. These checks assert each release SYNCHRONOUSLY (no await between the call and the
// assertion): a release that waits for a later turn reads as a FAIL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRetirer } from '../runtime-drop.mjs';

const fakePhp = (name) => ({ name });

test('idle: retire() releases at once, in the same call (no continuation)', () => {
	const released = [];
	const r = createRetirer((p) => released.push(p.name));
	r.retire(fakePhp('a'));
	assert.deepEqual(released, ['a'], 'released synchronously');
	assert.equal(r.pending, 0);
});

test('during a run: not released mid-use; released synchronously when the run ends', () => {
	const released = [];
	const r = createRetirer((p) => released.push(p.name));
	r.runStart();
	r.retire(fakePhp('b'));
	assert.deepEqual(released, [], 'a run executes: the runtime may be in use');
	r.runEnd();
	assert.deepEqual(released, ['b'], 'released inside runEnd(), with no later turn');
});

test('a stale lock (two runs at once): released only when the LAST run ends', () => {
	const released = [];
	const r = createRetirer((p) => released.push(p.name));
	r.runStart(); r.runStart();
	r.retire(fakePhp('c'));
	r.runEnd();
	assert.deepEqual(released, [], 'one run still executes');
	r.runEnd();
	assert.deepEqual(released, ['c']);
});

test('retire(php, true) only queues (a caller may still await that boot); the next run end releases it', () => {
	const released = [];
	const r = createRetirer((p) => released.push(p.name));
	r.retire(fakePhp('orphan'), true);
	assert.deepEqual(released, [], 'not released on the spot, even when idle');
	r.runStart(); r.runEnd();
	assert.deepEqual(released, ['orphan']);
});

test('null is ignored, a throwing release never escapes, and each runtime is released once', () => {
	let n = 0;
	const r = createRetirer(() => { n++; throw new Error('exit threw'); });
	r.retire(null);
	const p = fakePhp('d');
	r.runStart(); r.retire(p); r.retire(p); r.runEnd();
	assert.equal(n, 1);
	assert.equal(r.pending, 0);
});

test('after the release, the retirer keeps no reference: the runtime is collected', async () => {
	assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc');
	const r = createRetirer(() => {});
	let ref;
	(() => {
		const php = fakePhp('e');
		php.heap = new ArrayBuffer(8 * 1048576); // stands in for the WebAssembly.Memory
		ref = new WeakRef(php);
		r.runStart(); r.retire(php); r.runEnd();
	})();
	// deref() keeps its target alive for the rest of the job: collect across ticks, read once.
	for (let i = 0; i < 5; i++) { await new Promise((ok) => setTimeout(ok, 10)); globalThis.gc(); }
	await new Promise((ok) => setTimeout(ok, 10));
	assert.equal(ref.deref(), undefined, 'collected');
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
test('index.js: every drop retires synchronously, and every PHP run reaps in its own finally', () => {
	assert.equal([...code.matchAll(/bootPromise = null/g)].length, 1, 'exactly one, inside dropRuntime');
	const drop = code.slice(code.indexOf('function dropRuntime() {'), code.indexOf('\n}\n', code.indexOf('function dropRuntime() {')));
	assert.ok(drop.length > 0, 'dropRuntime() takes no argument');
	assert.match(drop, /retirer\.retire\(held\)/);
	assert.doesNotMatch(drop, /\bawait\b|\.then\(|waitUntil|\bPromise\./, 'no continuation in the drop');
	assert.match(code, /retirer\.runStart\(\);\n\t+try \{\n\t+return await fn\(\);\n\t+\} finally \{\n\t+retirer\.runEnd\(\);/, 'withPhp brackets every run');
	assert.match(code, /if \(gen !== bootGen\) retirer\.retire\(php, true\);/, 'a boot that finished after a drop is queued, never released on the spot');
	assert.ok(!/dropAndRelease/.test(code), 'the continuation-based release is gone');
	const ev = code.indexOf("if (url.pathname === '/_evict') {");
	assert.ok(code.indexOf('dropRuntime();', ev) < code.indexOf("this.ctx.abort('evict", ev), '/_evict drops (and so releases, when idle) before it schedules the abort');
	assert.match(code, /const forceRecycle = spikeOk && req\.headers\.get\('x-runtime-recycle'\) === 'force';/, 'the forced recycle is spike-gated');
	assert.match(code, /if \(crashed \|\| forceRecycle \|\| \(wasmBytes > RECYCLE_WASM_BYTES && env\.PHP_RECYCLE !== 'off'\)\) \{/);
});
