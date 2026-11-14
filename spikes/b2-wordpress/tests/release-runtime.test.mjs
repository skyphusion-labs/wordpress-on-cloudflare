// node --test spikes/b2-wordpress/tests/release-runtime.test.mjs (#394 (b))
// index.js cannot be imported under node (it loads php-wasm), so this reads its source, as
// site-lock.test.mjs does: a recycled runtime must be RELEASED (lastBootedPhp cleared, exit() called),
// and only after the response for its last request is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('releaseRuntime clears lastBootedPhp and exits the runtime, never throwing', () => {
	const start = src.indexOf('function releaseRuntime(php) {');
	assert.ok(start >= 0, 'releaseRuntime not found');
	const body = src.slice(start, src.indexOf('\n}\n', start));
	assert.match(body, /if \(lastBootedPhp === php\) lastBootedPhp = null;/);
	assert.match(body, /try \{\s*php\.exit\(0\);\s*\} catch/);
});

test('the memory recycle marks the runtime, and drops it through dropRuntime (released after this run settles)', () => {
	// #566: every drop goes through dropRuntime, which releases only once the PHP queue at the drop has
	// settled. The recycle drops inside its own run, so the release comes after that run returned its
	// response: the old "build, release, return" order, now enforced by the wait (drop-runtime.test.mjs).
	const rec = src.indexOf("if (crashed || (wasmBytes > RECYCLE_WASM_BYTES && env.PHP_RECYCLE !== 'off')) {");
	assert.ok(rec >= 0, 'recycle block not found');
	const block = src.slice(rec, src.indexOf('\n\t\t\t}', rec));
	assert.match(block, /\n\t+dropRuntime\(\);/);
	assert.match(block, /recycled = php;/);
	assert.ok(!src.includes('if (recycled) releaseRuntime(recycled);'), 'no second, direct release of the recycled runtime');
});
