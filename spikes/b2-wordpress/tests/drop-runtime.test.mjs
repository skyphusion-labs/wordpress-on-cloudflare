// node --expose-gc --test spikes/b2-wordpress/tests/drop-runtime.test.mjs (#566)
// A dropped PHP runtime must be RELEASED, and only once nothing can still be using it. Measured on
// pf394a (#394 issuecomment-6878609371): after /_evict dropped a runtime, the ledger still read live 1,
// collected 0, through a memory-pressure loop up to the isolate kill, because lastBootedPhp pinned it
// and only the recycle path released. dropAndRelease (runtime-drop.mjs) waits for `after` (the PHP
// queue at the drop), then releases the dropped boot's runtime and the one lastBootedPhp held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dropAndRelease } from '../runtime-drop.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const fakePhp = (name) => ({ name, exited: false });

test('the release waits for in-flight PHP work: nothing is released before `after` settles', async () => {
	const php = fakePhp('a');
	const released = [];
	const gate = deferred();
	const done = dropAndRelease({ boot: Promise.resolve({ php }), held: php, after: gate.promise, release: (p) => released.push(p.name) });
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(released, [], 'still in use: not released yet');
	gate.resolve();
	await done;
	assert.deepEqual(released, ['a'], 'released once, after the queue settled');
});

test('a held runtime other than the dropped boot (a boot that failed after lastBootedPhp was set) is released too', async () => {
	const held = fakePhp('held');
	const released = [];
	await dropAndRelease({ boot: Promise.reject(new Error('boot failed')), held, after: Promise.resolve(), release: (p) => released.push(p.name) });
	assert.deepEqual(released, ['held']);
});

test('nothing to drop is a no-op; a failing release never throws out of the drop', async () => {
	assert.equal(await dropAndRelease({ boot: null, held: null, after: Promise.resolve(), release: () => { throw new Error('x'); } }), undefined);
	const php = fakePhp('b');
	await dropAndRelease({ boot: Promise.resolve({ php }), held: php, after: Promise.resolve(), release: () => { throw new Error('exit threw'); } });
});

test('after the drop, the runtime is UNREACHABLE from the drop (it is collected)', async () => {
	assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc');
	let ref;
	await (async () => {
		const php = fakePhp('c');
		php.heap = new ArrayBuffer(8 * 1048576); // stands in for the WebAssembly.Memory
		ref = new WeakRef(php);
		await dropAndRelease({ boot: Promise.resolve({ php }), held: php, after: Promise.resolve(), release: (p) => { p.exited = true; } });
	})();
	// deref() keeps its target alive for the rest of the current job, so collect across several ticks
	// first and read it once at the end.
	for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 10)); globalThis.gc(); }
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(ref.deref(), undefined, 'collected');
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
test('index.js: no runtime is dropped without a release (every drop goes through dropRuntime)', () => {
	const bare = [...code.matchAll(/bootPromise = null/g)].length;
	assert.equal(bare, 1, `exactly one "bootPromise = null", inside dropRuntime, found ${bare}`);
	assert.match(code, /function dropRuntime\(after\) \{\n\tconst boot = bootPromise;\n\tconst held = lastBootedPhp;\n\tbootPromise = null;\n\treturn dropAndRelease\(\{ boot, held, after: after \|\| phpQueue, release: releaseRuntime \}\);\n\}/);
	assert.ok(!/if \(recycled\) releaseRuntime\(recycled\);/.test(code), 'the recycle path goes through dropRuntime too');
	assert.match(code, /if \(stale\) dropRuntime\(Promise\.all\(\[prev, phpQueue\]\)\);/, 'a stale lock waits for the stale run as well');
});
