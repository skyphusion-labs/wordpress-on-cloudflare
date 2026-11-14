// node --test spikes/b2-wordpress/tests/site-remote.test.mjs (#569, #394 Gate 2). Needs npm ci and
// ./prepare.sh (vendor/php_8_3.js, vendor/php_8_3.wasm), on a Node with JSPI (CI: Node 24).
//
// The real loader, the real PHP, the REAL attachLazyContents (cut out of index.js, as
// lazy-write.test.mjs does) and remote-packs.mjs. Site files live only in packs. The evictor drops
// every earlier inflated copy as soon as another file inflates, the most aggressive the 2 MiB cap
// can be, and the held budget keeps one pack. So any read that is not protected by the PIN finds
// both its bytes and its pack gone. Cases:
//   - require, include and file_get_contents of remote site files work;
//   - one failed pack fetch is retried once and the page is whole (rsRetry 1);
//   - two failures: include returns false, require is a fatal (exit 255), never the text after it;
//   - a file_exists / is_file / is_readable / filesize / scandir storm makes 0 fetches;
//   - an OPEN file read half, then other packs, then the rest: every byte, exactly (the pin);
//     the same with the pin turned off must NOT give the whole file (the guard can fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemotePacks, createFetchBudget } from '../remote-packs.mjs';
import { createArena } from '../inflate-arena.mjs';

const B2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(B2, 'package.json'));
globalThis.require ??= require;
const { loadPHPRuntime, PHP, __private__dont__use } = require('@php-wasm/universal');
const { zipSync, unzipSync } = require('fflate');

const dir = mkdtempSync(join(tmpdir(), 'site569-'));
writeFileSync(join(dir, 'fixed.mjs'), readFileSync(join(B2, 'vendor/php_8_3.js'), 'utf8'));
const wasm = new WebAssembly.Module(readFileSync(join(B2, 'vendor/php_8_3.wasm')));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const indexSrc = readFileSync(join(B2, 'index.js'), 'utf8');
function cut(src, header) {
	const i = src.indexOf(header);
	assert.ok(i >= 0, 'not found: ' + header);
	let depth = 0;
	for (let j = src.indexOf('{', i); j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
	}
	throw new Error('unbalanced: ' + header);
}
// attachLazyContents from index.js. noteInflated drops EVERY earlier copy at once (the evictor).
function attacher(arena) {
	const stats = { reinflates: 0, inflates: 0, inflateBytes: 0, lazyWrites: 0 };
	let noted = [];
	const noteInflated = (drop) => { for (const d of noted) if (d !== drop) d(); noted = [drop]; };
	return new Function('stats', 'tracing', 'fileTrace', 'arenaOn', 'getArena', 'noteInflated',
		cut(indexSrc, 'function attachLazyContents(node, size, dataFn, tag) {') + '\nreturn attachLazyContents;')(
		stats, () => false, null, () => !!arena, () => arena, noteInflated);
}

// The site: four packs, one file group each, plus a hot pack. big.txt is 200,000 bytes, so PHP
// reads it in 8 KiB chunks: a read past the first chunk needs the bytes again.
const enc = (s) => new TextEncoder().encode(s);
const BIG = enc(Array.from({ length: 20000 }, (_, i) => String(i % 10).repeat(9) + '\n').join(''));
const groups = [
	{ 'wordpress/big.txt': BIG, 'wordpress/a.php': enc('<?php return "A";') },
	{ 'wordpress/b.php': enc('<?php return "B";') },
	{ 'wordpress/c.php': enc('<?php return "C";') },
	{ 'wordpress/d.json': enc('{"d":4}') },
];
const hotFiles = { 'wordpress/theme.json': enc('{"hot":1}') };
const zips = groups.map((g) => zipSync(g, { level: 6 }));
const hotZip = zipSync(hotFiles, { level: 6 });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const INDEX = {
	id: 't',
	hot: { name: 'site-hot.zip', bytes: hotZip.length, sha256: sha(hotZip) },
	packs: zips.map((z, i) => ({ name: 'st-' + i + '.zip', bytes: z.length, sha256: sha(z) })),
	files: Object.fromEntries([
		...groups.flatMap((g, i) => Object.entries(g).map(([n, b]) => [n, [i, b.length]])),
		...Object.entries(hotFiles).map(([n, b]) => [n, [-1, b.length]]),
	]),
	dirs: ['wordpress', 'wordpress/empty'],
};
const parse = (bytes) => Object.entries(unzipSync(bytes)).map(([name, b]) => ({ name, data: () => b }));

async function site({ fail = () => false, pin = true, arena = null } = {}) {
	const stats = {};
	const fetched = [];
	const remote = createRemotePacks({
		index: INDEX, parse, stats, prefix: 'rs', budget: createFetchBudget({ soft: 64, hard: 96 }), limit: 'hard',
		holdBytes: 1, retries: 1, retryDelayMs: 1,
		fetchPack: async (name) => {
			fetched.push(name);
			if (fail(name, fetched.filter((n) => n === name).length)) throw new Error(name + ' answered 503');
			return name === 'site-hot.zip' ? hotZip.slice() : zips[Number(name.slice(3, 4))].slice();
		},
	});
	const loader = await import(join(dir, 'fixed.mjs'));
	const id = await loadPHPRuntime(loader, {
		ENV: { USE_ZEND_ALLOC: '0' },
		pagefeatherOpen: (path) => (path.startsWith('/wordpress/') ? remote.open(path.slice(1)) : null),
		instantiateWasm(imports, done) { const inst = new WebAssembly.Instance(wasm, imports); done(inst, wasm); return inst.exports; },
	});
	const php = new PHP(id);
	const FS = php[__private__dont__use].FS;
	const attach = attacher(arena);
	for (const d of INDEX.dirs) php.mkdir('/' + d);
	for (const [name, [, size]] of Object.entries(INDEX.files)) {
		const full = '/' + name;
		FS.writeFile(full, new Uint8Array(0));
		attach(FS.lookupPath(full).node, size, (out) => {
			const b = remote.data(name, out);
			if (!b) throw new FS.ErrnoError(29);
			return b;
		}, { src: 'site', path: full, pin });
	}
	const run = async (code) => {
		try {
			const r = await php.run({ code });
			return r.text;
		} catch (e) {
			return 'threw: ' + String(e.message).slice(0, 300);
		} finally {
			remote.endRequest();
		}
	};
	return { run, stats, fetched };
}

test('require, include and file_get_contents of remote site files work, and the hot file too', async () => {
	const s = await site();
	assert.equal(await s.run('<?php echo require "/wordpress/a.php", include "/wordpress/b.php", file_get_contents("/wordpress/d.json"), file_get_contents("/wordpress/theme.json");'), 'AB{"d":4}{"hot":1}');
	assert.equal(s.stats.rsFail, 0);
});

test('one failed pack fetch is retried once: the page is whole, rsRetry 1', async () => {
	const s = await site({ fail: (name, nth) => name === 'st-1.zip' && nth === 1 });
	assert.equal(await s.run('<?php echo require "/wordpress/b.php";'), 'B');
	assert.equal(s.stats.rsRetry, 1);
	assert.equal(s.stats.rsFail, 0);
});

test('two failures: include returns false, require is a fatal, never the text after it', async () => {
	const s = await site({ fail: (name) => name === 'st-2.zip' });
	assert.equal(await s.run('<?php echo (@include "/wordpress/c.php") === false ? "clean" : "WRONG";'), 'clean');
	const out = await s.run('<?php echo "before|"; require "/wordpress/c.php"; echo "AFTER";');
	assert.match(out, /exit code 255/);
	assert.match(out, /before\|/);
	assert.doesNotMatch(out, /AFTER/);
	assert.equal(s.stats.rsRetry, 2, 'one retry per request');
	assert.equal(s.stats.rsFail, 2);
});

test('a stat storm makes 0 fetches: file_exists, is_file, is_readable, filesize, scandir', async () => {
	const s = await site();
	const out = await s.run(`<?php $n = 0; for ($i = 0; $i < 2500; $i++) { foreach (array("a.php", "b.php", "c.php", "d.json") as $f) {
		$p = "/wordpress/" . $f; $n += file_exists($p) + is_file($p) + is_readable($p) + (filesize($p) > 0); } }
		echo $n, "|", count(scandir("/wordpress")), "|", is_dir("/wordpress/empty") ? "dir" : "no";`);
	assert.equal(out, '40000|9|dir');
	assert.deepEqual(s.fetched, [], 'no pack was fetched');
});

const HALF_OPEN = `<?php $f = fopen("/wordpress/big.txt", "rb"); $head = fread($f, 10);
	$x = require "/wordpress/b.php"; $y = require "/wordpress/c.php"; $z = file_get_contents("/wordpress/d.json");
	$rest = stream_get_contents($f); fclose($f);
	echo strlen($head . $rest), "|", md5($head . $rest), "|", $x, $y, $z;`;
const WANT = BIG.length + '|' + createHash('md5').update(BIG).digest('hex') + '|BC{"d":4}';

test('the PIN: an open file read half, then three other packs, then the rest: every byte, exactly', async () => {
	const s = await site();
	assert.equal(await s.run(HALF_OPEN), WANT);
});

test('the PIN with the inflate arena on: the same, exactly', async () => {
	const s = await site({ arena: createArena(64 * 1024) });
	assert.equal(await s.run(HALF_OPEN), WANT);
});

test('the guard can fail: with the pin OFF the same read does NOT give the whole file', async () => {
	const s = await site({ pin: false });
	assert.notEqual(await s.run(HALF_OPEN), WANT);
});
