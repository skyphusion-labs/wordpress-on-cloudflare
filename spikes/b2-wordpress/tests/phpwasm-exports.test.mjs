// node --test spikes/b2-wordpress/tests/phpwasm-exports.test.mjs (#569). A read inside a wasm export
// that is NOT in the loader's exportPattern cannot suspend: Gate 0b measured a named SuspendError
// ("trying to suspend without WebAssembly.promising"). php-wasm's JS calls exports with ccall. Today
// those are 3 promising ones and 12 setters that touch no file. A php-wasm bump that calls any OTHER
// export must go red here, before it can reach a remote file read in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const universal = readFileSync(new URL('../node_modules/@php-wasm/universal/index.js', import.meta.url), 'utf8');
const loader = readFileSync(new URL('../node_modules/@php-wasm/web-8-3/jspi/php_8_3.js', import.meta.url), 'utf8');
export const SETTERS = ['wasm_add_ENV_entry', 'wasm_add_SERVER_entry', 'wasm_add_cli_arg', 'wasm_set_content_length', 'wasm_set_path_translated', 'wasm_set_phpini_path',
	'wasm_set_request_body', 'wasm_set_request_host', 'wasm_set_request_method', 'wasm_set_request_port', 'wasm_set_request_uri', 'wasm_set_sapi_name', 'wasm_set_skip_shebang',
	'wasm_set_content_type', 'wasm_set_cookies', 'wasm_set_query_string', 'wasm_set_request_cookies'];
export function ccalled(src) {
	return [...new Set([...src.matchAll(/ccall\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]))].sort();
}
export function promising(src) {
	const m = /var exportPattern =\s*\/\^\(([^)]*)\)\$\//.exec(src);
	assert.ok(m, 'the loader has an exportPattern');
	return new Set(m[1].split('|'));
}
export function unsafe(src, loaderSrc) {
	const p = promising(loaderSrc);
	return ccalled(src).filter((n) => !p.has(n) && !SETTERS.includes(n));
}

test('every export php-wasm calls is promising (it may suspend) or a setter that touches no file', () => {
	assert.ok(ccalled(universal).length >= 15, 'the ccall scan found the calls: ' + ccalled(universal).length);
	assert.deepEqual(unsafe(universal, loader), []);
	for (const n of ['php_wasm_init', 'wasm_sapi_handle_request', 'run_cli']) assert.ok(promising(loader).has(n), n + ' is promising');
});

test('the guard can fail: a php-wasm that ccalls a new reading export goes red', () => {
	const bumped = universal + '\nthis.x.ccall("php_execute_script", "number", [], []);';
	assert.deepEqual(unsafe(bumped, loader), ['php_execute_script']);
});
