// Test of the /_build and /_evict operator endpoints (issue #35 slice 5) in
// spikes/b2-wordpress/index.js, as source invariants (index.js cannot be
// imported without a build; a full run is the measure-first live step):
//   node spikes/b2-wordpress/tests/build-evict-test.mjs [index.js]
// - both endpoints exist and are /_-prefixed;
// - each is handled AFTER a spike-token gate ("startsWith('/_') && !spikeOk ...
//   403"), so an unauthenticated /_* is refused;
// - the page-cache exclusion PAGE_CACHE_NO_PATH matches /_build and /_evict,
//   so neither is ever served from the cache;
// - /_evict guards on typeof ctx.abort (a clean 501 on an older compat date).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || resolve(here, '..', 'index.js');
const src = readFileSync(path, 'utf8');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const gate = src.indexOf("startsWith('/_') && !spikeOk");
ok('a spike-token gate for /_* exists', gate >= 0);
for (const ep of ['/_build', '/_evict']) {
	const at = src.indexOf(`url.pathname === '${ep}'`);
	ok(`${ep} is handled`, at >= 0);
	ok(`${ep} is /_-prefixed (gate and cache cover it)`, ep.startsWith('/_'));
	ok(`${ep} is handled after a spike-token gate`, at >= 0 && gate >= 0 && at > gate);
}
// PAGE_CACHE_NO_PATH must exclude /_ paths.
const m = src.match(/const PAGE_CACHE_NO_PATH = (\/\^[^;]+\/);/);
ok('PAGE_CACHE_NO_PATH is found', !!m);
if (m) {
	const re = eval(m[1]);
	ok('PAGE_CACHE_NO_PATH matches /_build', re.test('/_build'));
	ok('PAGE_CACHE_NO_PATH matches /_evict', re.test('/_evict'));
	ok('PAGE_CACHE_NO_PATH does not match a normal page', !re.test('/hello-world/'));
}
ok('/_evict guards on typeof this.ctx.abort', /typeof this\.ctx\.abort !== 'function'/.test(src));
// #279: /_evict drops the module-level PHP runtime, BEFORE the abort (abort resets the object only).
{
	const h = src.indexOf("if (url.pathname === '/_evict') {");
	const drop = src.indexOf('dropRuntime();', h); // #566: the drop releases the runtime too
	const abort = src.indexOf("this.ctx.abort('evict", h);
	ok('/_evict drops the runtime (dropRuntime) before it aborts the object', h >= 0 && drop > h && abort > drop);
}
console.log(`${fails} failing check(s)`);
process.exit(fails ? 1 : 0);
