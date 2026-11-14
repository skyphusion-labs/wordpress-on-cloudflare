// node --test spikes/b2-wordpress/tests/frame-probe.test.mjs (#352). The lead's ruling (iii): never claim
// "nothing saved" without the /_frame probe's proof. Only a frame that is rolled-back with NO commit point
// proves it; anything else (unknown, still open, kept, rolled back after a commit point) keeps today's
// "some changes may have been saved" answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameProvesRollback, rolledBackResponse, writeLossResponse, ROLLED_BACK_MESSAGE, WRITE_LOSS_MESSAGE } from '../write-loss.mjs';

test('only rolled-back with 0 commit points proves nothing was kept', () => {
	assert.equal(frameProvesRollback({ state: 'rolled-back', points: 0 }), true);
	for (const f of [null, undefined, {}, { state: 'open', points: 0 }, { state: 'kept', points: 0 }, { state: 'rolled-back', points: 1 }, { state: 'rolled-back', points: '2' }]) {
		assert.equal(frameProvesRollback(f), false, JSON.stringify(f));
	}
});

test('the rolled-back answer is still a 500, says nothing was saved, and is never cached', () => {
	const t = rolledBackResponse(false, 'memory', 7);
	assert.equal(t.status, 500);
	assert.equal(t.headers['x-write-loss'], 'rolled-back');
	assert.equal(t.headers['x-write-undone'], '7');
	assert.equal(t.headers['cache-control'], 'no-store');
	assert.equal(t.body, ROLLED_BACK_MESSAGE + '\n');
	const j = rolledBackResponse(true, 'storage');
	assert.equal(j.headers['x-isolate-reset'], 'storage');
	assert.deepEqual(JSON.parse(j.body).data, { status: 500, rolledBack: true });
	assert.notEqual(ROLLED_BACK_MESSAGE, WRITE_LOSS_MESSAGE);
	assert.equal(writeLossResponse(3).headers['x-write-loss'], '3', "today's answer is unchanged");
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: both write-loss paths answer "rolled back" ONLY behind frameProvesRollback, and /_frame is refused to clients', () => {
	const uses = [...src.matchAll(/rolledBackResponse\(/g)].length;
	assert.equal(uses, 2, 'two answer sites: the killed request and the object-answered one');
	assert.equal([...src.matchAll(/frameProvesRollback\(fr\) \? rolledBackResponse\(/g)].length + [...src.matchAll(/if \(frameProvesRollback\(fr\)\) \{\n\t\t\tconst rb = rolledBackResponse\(/g)].length, 2, 'each one gated on the proof');
	assert.match(src, /if \(url\.pathname === '\/_frame'\) return new Response\('Not Found', \{ status: 404 \}\);/);
});

// The forced-reset proof route (#352, run on the lead's throwaway): it KILLS the isolate, so it must be
// spike-gated AND allowed only with HEADROOM_PROBE=on (the same gate as the /_headroom kill probe).
test('index.js: /_frame-probe is spike-gated and needs HEADROOM_PROBE=on; plain, point (a DDL) and check modes', () => {
	assert.match(src, /if \(url\.pathname === '\/_frame-probe' && spikeOk && env\.HEADROOM_PROBE === 'on'\) \{/);
	assert.match(src, /mode === 'point' \? "\$wpdb->query\('CREATE TABLE IF NOT EXISTS pf352_probe_ddl \(a INTEGER\)'\);" : ''/);
	assert.match(src, /if \(mode === 'check'\)/);
});
