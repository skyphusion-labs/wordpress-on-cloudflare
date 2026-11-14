// node --test spikes/b2-wordpress/tests/site-remote.test.mjs (#569, #394 Gate 2, the HYBRID). Needs npm
// ci and ./prepare.sh (vendor/php_8_3.js with PY5 and PY6), on a Node with JSPI (CI: Node 24).
//
// The real loader, PHP, attachLazyContents (cut from index.js) and remote-packs.mjs createSiteHooks.
// The hybrid (Gate 0b and step 3, #394 issuecomment-6879785529 and -6879862441): a .php is fetched at
// its FIRST READ (OPcache opens sources it never reads: 37,721 of 37,721 opened-not-read files were
// .php); every other site file at its OPEN (a failure stays a clean false). The evictor drops every
// other copy after each inflate and the held budget keeps one pack, so only the pin keeps bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemotePacks, createFetchBudget, createSiteHooks } from '../remote-packs.mjs';
import { createArena } from '../inflate-arena.mjs';

const B2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(B2, 'package.json'));
globalThis.require ??= require;
const { loadPHPRuntime, PHP, setPhpIniEntries, __private__dont__use } = require('@php-wasm/universal');
const { zipSync, unzipSync } = require('fflate');

const dir = mkdtempSync(join(tmpdir(), 'site569-'));
const loaderSrc = readFileSync(join(B2, 'vendor/php_8_3.js'), 'utf8');
writeFileSync(join(dir, 'fixed.mjs'), loaderSrc);
// The red control: no read path may suspend (PY6's pattern edit undone, js_fd_read out of the stock list).
const PY6_PAT = "((x === 'fd_read' || x === '_mmap_js') && typeof Module['pagefeatherRead'] == 'function')";
assert.ok(loaderSrc.includes(PY6_PAT), 'prepare.sh PY6 is in the loader');
writeFileSync(join(dir, 'noread.mjs'), loaderSrc.split(PY6_PAT).join('false').replace('/^(js_open_process|js_fd_read|', '/^(js_open_process|'));
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
// noPin: the REAL attachLazyContents with only its pin COUNT removed (every "pins++;" deleted). The fetch
// modes stay as they are, so the control isolates the pin itself.
function attacher(arena, { noPin = false } = {}) {
	const stats = { reinflates: 0, inflates: 0, inflateBytes: 0, lazyWrites: 0 };
	let noted = [];
	const noteInflated = (drop) => { for (const d of noted) if (d !== drop) d(); noted = [drop]; };
	let src = cut(indexSrc, 'function attachLazyContents(node, size, dataFn, tag) {');
	if (noPin) {
		assert.ok(src.includes('pins++;'), 'the pin count is in attachLazyContents');
		src = src.split('pins++;').join('');
	}
	return new Function('stats', 'tracing', 'fileTrace', 'arenaOn', 'getArena', 'noteInflated',
		src + '\nreturn attachLazyContents;')(
		stats, () => false, null, () => !!arena, () => arena, noteInflated);
}

const enc = (s) => new TextEncoder().encode(s);
const BIG = enc(Array.from({ length: 20000 }, (_, i) => String(i % 10).repeat(9) + '\n').join(''));
const BIGJ = enc('{"x":"' + 'j'.repeat(150000) + '"}');
const groups = [
	{ 'wordpress/big.php': enc('<?php /*' + new TextDecoder().decode(BIG) + '*/ return "BIG";'), 'wordpress/a.php': enc('<?php return "A";') },
	{ 'wordpress/b.php': enc('<?php return "B";') },
	{ 'wordpress/c.json': enc('{"c":3}'), 'wordpress/big.json': BIGJ },
	{ 'wordpress/t.php': enc('<?php return "NEW";') },
	{ 'wordpress/e.php': enc('<?php return "E";'), 'wordpress/e.json': enc('{"e":5}') },
	{ 'wordpress/f.php': enc('<?php return "F";'), 'wordpress/f.json': enc('{"f":6}') },
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
	dirs: ['wordpress'],
};
const parse = (bytes) => Object.entries(unzipSync(bytes)).map(([name, b]) => ({ name, data: () => b }));
const OC = '/internal/shared/opcache';
const INI = { 'opcache.enable': '1', 'opcache.enable_cli': '1', 'opcache.file_cache': OC, 'opcache.file_cache_only': '1', 'opcache.validate_timestamps': '0', 'opcache.file_update_protection': '0' };

async function bootPHP(file, hooks) {
	const loader = await import(join(dir, file));
	const id = await loadPHPRuntime(loader, {
		ENV: { USE_ZEND_ALLOC: '0' }, ...hooks,
		instantiateWasm(imports, done) { const inst = new WebAssembly.Instance(wasm, imports); done(inst, wasm); return inst.exports; },
	});
	return new PHP(id);
}

async function site({ fail = () => false, noPin = false, arena = null, file = 'fixed.mjs', opcache = null } = {}) {
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
	const hooks = createSiteHooks(remote);
	const php = await bootPHP(file, { pagefeatherOpen: hooks.open, pagefeatherRead: hooks.read });
	const FS = php[__private__dont__use].FS;
	const attach = attacher(arena, { noPin });
	for (const d of INDEX.dirs) php.mkdir('/' + d);
	for (const [name, [, size]] of Object.entries(INDEX.files)) {
		const full = '/' + name;
		FS.writeFile(full, new Uint8Array(0));
		attach(FS.lookupPath(full).node, size, (out) => {
			const b = remote.data(name, out);
			if (!b) throw new FS.ErrnoError(29);
			return b;
		}, { src: 'site', path: full, pin: hooks.pinMode(name) });
	}
	if (opcache) {
		await setPhpIniEntries(php, INI);
		for (const [p, b] of Object.entries(opcache)) { php.mkdir(p.slice(0, p.lastIndexOf('/'))); FS.writeFile(p, b); }
	}
	const run = async (code) => {
		try { return (await php.run({ code })).text; }
		catch (e) { return 'threw: ' + String(e.message).slice(0, 300); }
		finally { remote.endRequest(); }
	};
	return { run, stats, fetched, php, FS };
}

test('the hybrid: a .php is fetched at its read, a data file at its open; both work, and the hot file', async () => {
	const s = await site();
	assert.equal(await s.run('<?php echo require "/wordpress/a.php", include "/wordpress/b.php", file_get_contents("/wordpress/c.json"), file_get_contents("/wordpress/theme.json");'), 'AB{"c":3}{"hot":1}');
	assert.equal(s.stats.rsFail, 0);
});

test('open a .php with no read: 0 fetches (fopen, fstat, fclose, file_exists, is_file, filesize, scandir)', async () => {
	const s = await site();
	const out = await s.run(`<?php $f = fopen("/wordpress/e.php", "rb"); $st = fstat($f); fclose($f);
		$n = 0; for ($i = 0; $i < 2500; $i++) { foreach (array("a.php", "b.php", "c.json", "t.php") as $x) { $p = "/wordpress/" . $x;
		$n += file_exists($p) + is_file($p) + is_readable($p) + (filesize($p) > 0); } }
		echo $st["size"], "|", $n, "|", count(scandir("/wordpress"));`);
	assert.match(out, /^17\|40000\|\d+$/);
	assert.deepEqual(s.fetched, [], 'no pack was fetched');
});

test('the OPcache source-resolve path: the compiled form from the cache, the remote source fetched 0 times', async () => {
	const a = await bootPHP('fixed.mjs', {});
	await setPhpIniEntries(a, INI);
	a.mkdir('/wordpress');
	a.writeFile('/wordpress/t.php', '<?php return "OLD";');
	assert.equal((await a.run({ code: '<?php echo require "/wordpress/t.php";' })).text, 'OLD');
	const AF = a[__private__dont__use].FS;
	const cache = {};
	(function walk(d) { for (const n of AF.readdir(d)) { if (n === '.' || n === '..') continue; const p = d + '/' + n; if (AF.isDir(AF.stat(p).mode)) walk(p); else cache[p] = AF.readFile(p); } })(OC);
	const s = await site({ opcache: cache });
	assert.equal(await s.run('<?php echo require "/wordpress/t.php";'), 'OLD');
	assert.equal(s.fetched.filter((n) => n === 'st-3.zip').length, 0, 'the source pack was never fetched');
});

test('one failed fetch is retried once, for a .php (read) and a data file (open): whole, rsRetry 2', async () => {
	const s = await site({ fail: (name, nth) => (name === 'st-1.zip' || name === 'st-2.zip') && nth === 1 });
	assert.equal(await s.run('<?php echo require "/wordpress/b.php", file_get_contents("/wordpress/c.json");'), 'B{"c":3}');
	assert.equal(s.stats.rsRetry, 2);
	assert.equal(s.stats.rsFail, 0);
});

test('a failed .php: include false, require fatal, nothing after; a failed DATA file: file_get_contents is FALSE, never ""', async () => {
	const s = await site({ fail: (name) => name === 'st-5.zip' });
	assert.equal(await s.run('<?php echo (@include "/wordpress/f.php") === false ? "inc-false" : "WRONG";'), 'inc-false');
	const req = await s.run('<?php echo "before|"; require "/wordpress/f.php"; echo "AFTER";');
	assert.match(req, /exit code 255/);
	assert.doesNotMatch(req, /AFTER/);
	assert.equal(await s.run('<?php $c = @file_get_contents("/wordpress/f.json"); echo $c === false ? "fgc-false" : "fgc-WRONG:" . strlen($c);'), 'fgc-false');
});

const HALF = (f) => `<?php $h = fopen("${f}", "rb"); $head = fread($h, 10);
	$x = require "/wordpress/b.php"; $y = file_get_contents("/wordpress/c.json"); $z = require "/wordpress/e.php";
	$rest = ""; while (!feof($h)) { $rest .= fread($h, 4096); } fclose($h);
	echo strlen($head . $rest), "|", md5($head . $rest), "|", $x, $y, $z;`;
const want = (b) => b.length + '|' + createHash('md5').update(b).digest('hex') + '|B{"c":3}E';

for (const [label, path, bytes] of [['a .php (pinned at its first READ)', '/wordpress/big.php', groups[0]['wordpress/big.php']], ['a data file (pinned at its OPEN)', '/wordpress/big.json', BIGJ]]) {
	test(`the PIN, ${label}: read half, three other packs, then the rest: every byte`, async () => {
		const s = await site();
		assert.equal(await s.run(HALF(path)), want(bytes));
	});
	test(`the PIN with the inflate arena on, ${label}: the same`, async () => {
		const s = await site({ arena: createArena(64 * 1024) });
		assert.equal(await s.run(HALF(path)), want(bytes));
	});
	test(`the guard can fail, ${label}: with the pin count removed, a read in the middle fails with EIO and the file is short`, async () => {
		const s = await site({ noPin: true });
		const out = await s.run(HALF(path));
		assert.match(out, /Read of \d+ bytes failed with errno=29/);
		// The length is the number before "|<md5>|" (a match, not a tag strip: CodeQL flagged the strip).
		const lm = out.match(/(\d+)\|[0-9a-f]{32}\|/);
		const got = lm ? Number(lm[1]) : NaN;
		assert.ok(Number.isFinite(got) && got > 0 && got < bytes.length, 'a short read: ' + got);
	});
}

test('the red control: no read path Suspending, the same hooks: a .php is NOT served (it read empty: Gate 0b)', async () => {
	const s = await site({ file: 'noread.mjs' });
	assert.notEqual(await s.run('<?php echo require "/wordpress/a.php";'), 'A');
});

test('our JS never takes a failed .php read for empty: a JS-side read of an unfetched remote .php THROWS', async () => {
	const s = await site();
	assert.throws(() => s.FS.readFile('/wordpress/a.php'), (e) => e.name === 'ErrnoError' && e.errno === 29);
});

// The BOOT SELF-CHECK (the lead's ask after Gate 0b's silent control): a known remote .php is read
// through PHP at boot and compared with its recorded size and SHA-256. Empty or different: the boot
// fails LOUDLY, never a site whose files read as empty.
import { selfCheckCode, checkSelfCheck } from '../remote-packs.mjs';
const SC = ['wordpress/a.php', groups[0]['wordpress/a.php'].length, sha(groups[0]['wordpress/a.php'])];
test('the boot self-check passes on the real read path', async () => {
	const s = await site();
	const out = await s.run(selfCheckCode(SC));
	assert.doesNotThrow(() => checkSelfCheck(out, SC));
});
test('the boot self-check FAILS LOUDLY when reads come back empty (the red control loader)', async () => {
	const s = await site({ file: 'noread.mjs' });
	const out = await s.run(selfCheckCode(SC));
	assert.throws(() => checkSelfCheck(out, SC), /self-check/);
});
