// node --test spikes/b2-wordpress/tests/remote-perf-boot.test.mjs (#569). On pf570m (#570
// issuecomment-6880689593) x-perf read rsN 13 against rsPacks 14 on a booting request. The start
// snapshot of the counters was taken AFTER boot(), so the fetches the boot itself made (the site
// self-check reads its hot pack) fell outside the rsN delta, while rsPacks (per request) counted them.
// The remote counters must be snapshotted BEFORE the request awaits the boot, and x-perf's rf* and rs*
// deltas must use that snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('the remote counters are snapshotted before the request awaits boot()', () => {
	const boot = src.indexOf('			bootPromise ??= boot(origin);\n			const { php, handler, bootMs } = await bootPromise;');
	assert.ok(boot > 0, 'the main request path awaits the boot');
	const pre = src.lastIndexOf('const remote0 = remoteCounters();', boot);
	assert.ok(pre > 0 && boot - pre < 1200, 'remote0 is taken just before the boot');
});

test('x-perf rf* and rs* deltas use the pre-boot snapshot, not the post-boot start', () => {
	for (const k of ['rfN', 'rfFail', 'rfCapped', 'rsN', 'rsFail', 'rsRetry', 'rsCapped']) {
		assert.match(src, new RegExp(k + ': stats\\.' + k + ' - remote0\\.' + k + '\\b'), k + ' counts from before the boot');
		assert.doesNotMatch(src, new RegExp(k + ': stats\\.' + k + ' - start\\.' + k + '\\b'), k + ' no longer counts from after the boot');
	}
});
