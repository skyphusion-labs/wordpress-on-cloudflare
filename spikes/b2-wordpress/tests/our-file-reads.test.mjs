// node --test spikes/b2-wordpress/tests/our-file-reads.test.mjs (#569). With SITE_REMOTE a .php is
// fetched at its first READ, and a failed read gives PHP "" from @file_get_contents, not false (Gate
// 0b). WordPress core copes (its include fails loudly). OUR code must never read a site .php directly and
// take "" for an empty file. Today it does not: every direct file read in our PHP and in index.js is
// listed here with why it is safe. A NEW one goes red until it is reviewed and listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const B2 = new URL('..', import.meta.url);
const READ = /\b(file_get_contents|fopen|readfile|fpassthru|file|get_file_data|php_strip_whitespace|highlight_file|show_source|parse_ini_file)\s*\(/g;
// file:function-or-call -> why it never reads a remote site .php
const ALLOWED = {
	'php/r2-uploads.php:file_get_contents': 'skyphusion_r2_staged reads an UPLOAD temp file (at most 4 KiB, R2STAGED header checked), never a site file',
};
function phpReads() {
	const out = [];
	for (const f of readdirSync(new URL('php/', B2))) {
		if (!f.endsWith('.php')) continue;
		const src = readFileSync(new URL('php/' + f, B2), 'utf8').split('\n');
		src.forEach((line, i) => {
			// Strip comments, but not the // of a php:// URL (a first draft did, and so missed the php:// rule).
			const code = line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/^\s*\*.*$|^\s*\/\*.*$/, '');
			for (const m of code.matchAll(READ)) {
				if (/^\s*(function|->|::)/.test(code.slice(Math.max(0, m.index - 10), m.index))) continue;
				if (/['"]$/.test(code.slice(0, m.index))) continue; // the NAME in a string ('fopen()' in a message), not a call
				if (/['"]php:\/\//.test(code.slice(m.index))) continue; // php://input, php://memory: streams, not files
				if (/\$\w+->/.test(code.slice(Math.max(0, m.index - 2), m.index))) continue; // a method of the same name
				out.push({ key: 'php/' + f + ':' + m[1], at: 'php/' + f + ':' + (i + 1) });
			}
		});
	}
	return out;
}

test('every direct file read in our mu-plugins is reviewed and listed (none reads a remote site .php)', () => {
	const bad = phpReads().filter((r) => !ALLOWED[r.key]);
	assert.deepEqual(bad, [], 'review each new read: can it be a remote site .php, where "" means a FAILED read?');
});

test('index.js reads files from JS only under the OPcache dir (a JS read of a remote file throws, never returns "")', () => {
	const src = readFileSync(new URL('index.js', B2), 'utf8');
	const calls = [...src.matchAll(/(readFileAs(?:Text|Buffer)|FS\.readFile)\(([^)]*)\)/g)].map((m) => m[0]);
	assert.deepEqual(calls, ['readFileAsBuffer(p)'], 'one JS read: the OPcache dump, of OPCACHE_DIR paths');
	assert.match(src, /p\.startsWith\(OPCACHE_DIR|OPCACHE_DIR \+ '\/'/);
});

test('the guard can fail: a new direct read of a .php in our PHP is caught', () => {
	const line = '$src = file_get_contents( ABSPATH . "wp-includes/version.php" );';
	assert.ok([...line.matchAll(READ)].some((m) => m[1] === 'file_get_contents'));
});
