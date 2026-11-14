// Spike B2: WordPress in a Worker, database on D1.
import { sqlImport } from './sql-import.js';
import { sender, replyTo, deliverableRecipients } from './mail-from.mjs';
import { emailQueueEnabled, emailBackoffDelay, chunkBatch, isDeadLetterQueue, handleQueuedEmail } from './email-queue.mjs';
import { boundedWait, TIMED_OUT } from './promise-bound.mjs';
import { httpHostAllowed, resolveHttpAllowHosts } from './http-allow.mjs';
import { purgeZoneBody, cfPurgeEndpoint, cachePurgeEnabled, ownPurgeHost } from './purge-zone.mjs';
import { armBeforeRun, rearm, recordAlarmFatal, ALARM_FATAL_KEY } from './alarm-arm.mjs';
import { classifyObjectError, objectErrorHeaders, fetchWithMemoryRetry, isResetKind, objectErrorOutcome } from './object-error.mjs';
import { IMPORT_HOLD_KEY, IMPORT_HOLD_MS, cronHeld } from './import-hold.mjs';
import { MOVE_HOLD_KEY, moveHoldRequest } from './move-hold.mjs';
import { SNAPSHOT_PATH, snapshotGate, gateResponse, takeSnapshot } from './db-snapshot.mjs';
import { cronBounds, cronCleanDue, cronLegDue } from './cron-bound.mjs';
import { CRON_RUN_KEY, cronBackoff, cronRunStart, cronRunDone, cronMarkOf, cronFatalOf } from './cron-health.mjs';
import { pdfInvoiceEnabled, renderOpPlan, invoiceKey, bytesToHex, signDownload, verifyDownload, invoiceDownloadPath, parseDownloadQuery } from './pdf-invoice.mjs';
import { turnstileEnabled, turnstileForms, sanitizeSiteKey, verifyToken, siteHost, TURNSTILE_ACTION, setResultHeader, takeResultHeader, turnstileRoute, readGatedToken, encodeResult, TurnstileSlot, turnstileTimeoutMs, retryAfterFor } from './turnstile.mjs';
import { analyticsEnabled, recordPageview } from './analytics.mjs';
import { cfBridgeEnabled, aiEmbedOp, vectorizeOp } from './cf-bridge.mjs';
import { demoLocked, lockDefines } from './site-lock.mjs';
import { exportRequest } from './mysql-export.mjs';
import { perfHeadersAllowed, scrubPerfHeaders, isOperatorRequest, noStoreAnywhere, operatorNoStore } from './perf-headers.mjs';
import { resetFailures, writeLossResponse, wantsJson, heldRequestMail, sqlShape } from './write-loss.mjs';
import { MEMORY_RESET } from './object-error.mjs';
import { createL2Writer } from './oc-l2-writer.mjs';
import { createLedger, memfsBytes, createSqlMeter, ledgerOn, LEDGER_MIB } from './mem-ledger.mjs';
import { createTickMail, DEDUPE_PREFIX } from './email-handoff.mjs';
import { routeClass, createTrace } from './file-trace.mjs';
import { refuseSocketsDecorator, parseMessage } from './runtime-guards.mjs';
import wasmModule from './vendor/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { loadPHPRuntime, PHP, PHPRequestHandler, setPhpIniEntries, __private__dont__use } from '@php-wasm/universal';
import { inflateSync } from 'fflate';
import { createArena } from './inflate-arena.mjs';
import { headroomStream } from './headroom.mjs';
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import siteZip from './build/site.zip';
// Compiled PHP (OPcache file cache) made by opcache.sh with this same PHP build.
import opcacheZip from './build/opcache.zip';
// #394 L1 (opcache-split.py): the BOOT part of the OPcache file cache is not a static module. It is
// fetched from the Assets binding when a runtime boots and dropped after that request. null when
// the build was not split (build.sh writes the default).
import OPCACHE_BOOT from './build/opcache-boot-index.js';
// #563 (#394 Gate 1, OPCACHE_REMOTE=1): the WARM OPcache files in static-asset packs, fetched when PHP
// opens one (remote-packs.mjs). null on a default build (build.sh writes it): nothing changes then.
import OPCACHE_REMOTE from './build/opcache-remote-index.js';
import { createRemotePacks, REMOTE_FETCH_CAP } from './remote-packs.mjs';
// The build id baked at build time (build.sh writes build/build-id.js), so the
// object can report which code version it runs (issue #35 slice 5).
import BUILD_ID from './build/build-id.js';

const OPCACHE_DIR = '/internal/shared/opcache';
// The scripts OPcache must never cache (#294): the eval file of php.run.
const OPCACHE_BLACKLIST = '/internal/shared/opcache-blacklist.txt';

const DOCROOT = '/wordpress';
// php-wasm's defaults keep OPcache on with a file cache in PHP's in-memory
// filesystem. That saves recompiling about 500 scripts per request (CPU), at
// the cost of JS memory. Override through PHP_INI.
const INI_DEFAULTS = {};
// WebAssembly memory never shrinks. Past this, boot a fresh runtime for the next request.
// OPcache shared memory (48 MB since #394) is part of it. Measured 2026-11-04 on Paid:
// 81 MiB after the first page with OPcache on.
const RECYCLE_WASM_BYTES = 100 * 1024 * 1024;
let ENV;
// Approach A (index-a.js) registers a MySQL handler here. B leaves it null and
// every database message goes to D1.
let dbHandler = null;
export function setDbHandler(h) {
	dbHandler = h;
}
// DB_IN_DO=on (issue #2, docs/approach-b.md 8j): the PHP object's own SQLite
// (ctx.storage.sql). The object sets it for each PHP run, under the PHP lock.
// In the Worker it is always null and every statement goes to D1.
let sqlDb = null;
// The object's storage, for transactionSync (real transactions, #60). Set with sqlDb.
let sqlStorage = null;

// Object cache across requests (php/object-cache.php, docs/perf-dosql.md), in
// the PHP object with DB_IN_DO only: one object is the only writer, so
// WordPress's own deletes keep it exact. Least recently used goes first past
// OBJECT_CACHE_BYTES (values are base64 strings; their length is counted).
const OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
const objectCache = new Map(); // key -> { v, exp, n }
let objectCacheBytes = 0;
function objectCacheClear() {
	objectCache.clear();
	objectCacheBytes = 0;
}
function objectCacheDrop(k) {
	const e = objectCache.get(k);
	if (!e) return false;
	objectCache.delete(k);
	objectCacheBytes -= e.n;
	return true;
}
const OC_SEP = String.fromCharCode(0); // the NUL that object-cache-js.php puts after the group in a pkey
function ocGroupOf(k) { const i = k.indexOf(OC_SEP); return i < 0 ? k : k.slice(0, i); }
function ocCount(k, field) { const g = ocGroupOf(k) + "." + field; stats.ocGroups[g] = (stats.ocGroups[g] || 0) + 1; }
function dbTableOf(sql) { const m = /\b(?:FROM|INTO|UPDATE|JOIN)\s+`?([A-Za-z0-9_]+)`?/i.exec(sql); if (m) return m[1].toLowerCase(); const w = /^\s*([A-Za-z]+)/.exec(sql); return w ? w[1].toLowerCase() : "?"; }
function countTable(sql) { const t = dbTableOf(sql); stats.dbTables[t] = (stats.dbTables[t] || 0) + 1; }
function diffCounts(now, was) { const o = {}; for (const k in now) { const dv = now[k] - (was[k] || 0); if (dv) o[k] = dv; } return o; }

// L2 (KV) object cache (#218), BEHIND the in-isolate Map: a cold isolate reads a
// shared KV store instead of MySQL. Only groups PHP already persists reach here (the
// OBJECT_CACHE_GROUPS allowlist and salted groups; the Woo correctness groups never
// send a bridge op), so L2 inherits that safety by construction. Off unless the OC_KV
// binding is present and OBJECT_CACHE_L2=on, so b-dosql and D1 are untouched. Staleness
// is bounded: a del writes through to KV, and an allowlisted group already tolerates the
// bounded-TTL class of staleness; KV's min 60 s expiry is the cross-isolate bound.
let ocCtx = null; // the current request ctx, for L2 write-through via waitUntil
// #500: one KV writer per isolate: skip an unchanged PUT, at most one PUT per key per second (the
// latest value), a cap per request, and 429s counted (oc-l2-writer.mjs). Made on first use.
let ocL2W = null;
function ocL2Writer() {
	if (!ocL2W) ocL2W = createL2Writer({ put: (k, v, ttl) => ENV.OC_KV.put(k, v, { expirationTtl: ttl }), del: (k) => ENV.OC_KV.delete(k) });
	return ocL2W;
}
function ocL2On() { return !!(ENV && ENV.OBJECT_CACHE_L2 === 'on' && ENV.OC_KV); }
function ocTtlMs() { const t = Math.max(0, Math.min(3600, parseInt(ENV && ENV.OBJECT_CACHE_TTL, 10) || 10)); return t * 1000; }
function ocKvKey(k) { return 'oc:' + encodeURIComponent(k); } // NUL-safe KV key from the pkey
function ocStore(k, v, exp) {
	const n = k.length + v.length;
	if (n > OBJECT_CACHE_BYTES / 4) return false;
	objectCacheDrop(k);
	objectCache.set(k, { v, exp, n });
	objectCacheBytes += n;
	for (const kk of objectCache.keys()) { if (objectCacheBytes <= OBJECT_CACHE_BYTES) break; objectCacheDrop(kk); }
	return true;
}
async function objectCacheOp(op) {
	stats.ocCalls++;
	const now = Date.now();
	const l2 = ocL2On();
	if (op.op === 'get') {
		const out = [];
		for (const k of op.k) {
			ocCount(k, "get");
			const e = objectCache.get(k);
			if (e && !(e.exp && e.exp <= now)) {
				objectCache.delete(k); objectCache.set(k, e); // most recently used goes last
				stats.ocHits++; ocCount(k, "hit"); out.push(e.v); continue;
			}
			if (e) objectCacheDrop(k); // expired
			ocCount(k, "miss");
			if (l2) {
				let kv = null;
				try { kv = await ENV.OC_KV.get(ocKvKey(k)); } catch { kv = null; }
				if (kv != null) {
					ocStore(k, kv, now + ocTtlMs()); // the shared value is now warm in this isolate
					ocL2Writer().noteRead(ocKvKey(k), kv); // #500: a set of the same value needs no PUT
					stats.ocHits++; ocCount(k, "l2hit"); out.push(kv); continue;
				}
				ocCount(k, "l2miss");
			}
			out.push(null);
		}
		return { v: out };
	}
	if (op.op === 'set') {
		ocCount(op.k, "set");
		if (txnFrames) txnTouched.add(op.k);
		const n = op.k.length + op.v.length;
		if (n > OBJECT_CACHE_BYTES / 4) return { ok: false };
		ocStore(op.k, op.v, op.ttl > 0 ? now + op.ttl * 1000 : 0);
		if (l2 && ocCtx) { const ttl = Math.max(60, op.ttl > 0 ? op.ttl : 60); try { const w = ocL2Writer().set(ocKvKey(op.k), op.v, ttl); if (w) ocCtx.waitUntil(w); } catch {} }
		return { ok: true };
	}
	if (op.op === 'del') {
		if (txnFrames) for (const k of op.k) txnTouched.add(k);
		let n = 0;
		for (const k of op.k) { ocCount(k, "del"); if (objectCacheDrop(k)) n++; if (l2 && ocCtx) { try { ocCtx.waitUntil(ocL2Writer().del(ocKvKey(k))); } catch {} } }
		return { n };
	}
	if (op.op === 'flush') {
		objectCacheClear();
		return { ok: true };
	}
	if (op.op === 'flush_group') {
		for (const k of [...objectCache.keys()]) if (k.startsWith(op.g)) objectCacheDrop(k);
		return { ok: true };
	}
	return { ok: false };
}
// Counters only grow. A request reports the difference, so a nested request
// (WordPress calling its own URL) cannot reset an outer one.
const stats = newStats();
let bootPromise;
// The most recently booted PHP, so the /_memprobe bridge (handleMessage probeMem) can
// read the live WASM heap size from JS. memory_get_usage() reports 0 under USE_ZEND_ALLOC=0.
let lastBootedPhp = null;
// Drop every hold on a runtime that will not be used again (#394 (b)), so its WebAssembly memory can
// be collected before the next boot grows a new one. exit() deletes php-wasm's Module reference; its
// errors are ignored, since the runtime is finished either way.
function releaseRuntime(php) {
	if (lastBootedPhp === php) lastBootedPhp = null;
	try {
		php.exit(0);
	} catch {
		// already exited, or exit threw: nothing more to release
	}
}
// The admin memory trace of the request now running (#434, php/mem-trace.php): set by the
// memTrace message at PHP shutdown, read once into the operator-only x-mem-trace header.
let lastMemTrace = null;
// The operator's per-request id (#434): x-perf-id, logged on the memory marks and on the reset
// lines, so a request killed by an isolate reset can be joined to its marks. Operator requests
// only (a valid spike token), and only a short safe token, so a visitor cannot write into logs.
const MEM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function memIdOf(req, env) {
	const id = req.headers.get('x-perf-id');
	return id && MEM_ID_RE.test(id) && perfHeadersAllowed(req, env) ? { id } : {};
}
// The isolate memory ledger (#394, mem-ledger.mjs): off unless MEM_LEDGER=on or an operator request
// sends x-mem-ledger: 1. ledgerActive is set per request (and per cron leg), ledgerId is its x-perf-id.
const ledger = createLedger();
const sqlMeter = createSqlMeter();
let ledgerActive = false;
let ledgerId = null;
let ledgerFailLogged = false;
// The inflate counters when this request (or cron leg) started (#394): every inflated copy is a new
// buffer, and an evicted one stays in the isolate until V8 collects it. The ledger reports what was
// inflated so far in the request and in the isolate, the upper bound on that garbage.
let ledgerInfl0 = { n: 0, b: 0, r: 0, ae: 0 };
let bootMemory = null; // the WebAssembly.Memory of the runtime being booted (instantiateWasm), for the ledger
function ledgerSnapshot(at) {
	const php = lastBootedPhp;
	const heapOf = (p) => p[__private__dont__use].HEAPU8.length;
	let memfs = null;
	try {
		memfs = php ? memfsBytes(php[__private__dont__use].FS) : null;
	} catch (e) {
		memfs = { error: String((e && e.message) || e).slice(0, 80) };
	}
	return { at, iso: ISOLATE_ID, rt: runtimeSerial, wasmMiB: php ? LEDGER_MIB(heapOf(php)) : null, runtimes: ledger.runtimes(runtimeSerial, heapOf), memfs, inflatedMiB: LEDGER_MIB(inflatedBytes), ocMiB: LEDGER_MIB(objectCacheBytes), sql: sqlMeter.read(), inflate: { reqN: stats.inflates - ledgerInfl0.n, reqMiB: LEDGER_MIB(stats.inflateBytes - ledgerInfl0.b), isoN: stats.inflates, isoMiB: LEDGER_MIB(stats.inflateBytes), reinflateN: stats.reinflates - ledgerInfl0.r, ...(inflateArena ? { arena: { mib: LEDGER_MIB(inflateArena.size), arenaEvict: inflateArena.counts.evicts - ledgerInfl0.ae, over: inflateArena.counts.over } } : {}) } };
}
// #394 /_headroom: the parts of the ledger that show memory arriving during the probe loop.
function headroomLedger() {
	const s = ledgerSnapshot('headroom-step');
	return { wasmMiB: s.wasmMiB, live: s.runtimes && s.runtimes.live, boots: s.rt, isoMiB: s.inflate && s.inflate.isoMiB, inflatedMiB: s.inflatedMiB };
}
function ledgerLog(at, extra) {
	console.log(JSON.stringify({ m: 'mem-ledger', ...(ledgerId ? { id: ledgerId } : {}), ...ledgerSnapshot(at), ...(extra || {}) }));
}
// Performance instrument (docs/perf-dosql.md), PHP object only. Counts do not
// need the clock: in a Worker or a Durable Object, Date.now() moves only at
// I/O, so a time measured across synchronous PHP and SQLite work can read 0.
const ISOLATE_ID = Math.random().toString(36).slice(2, 8);
// Set on the first request this isolate serves (#474). Date.now() reads 0 at module scope in
// Workers (time does not move outside a request), so a module-scope value made isoAgeS epoch seconds.
let isolateStart = 0;
let runtimeSerial = 0; // runtimes booted in this isolate
// Runtimes dropped without a plan (recycled for memory, crashed, a stale lock, a
// failed request, another origin). /_activate restarts on purpose and is not
// counted. opcache.sh needs 0, so one runtime compiled what the pages used.
let runtimeDrops = 0;
let runtimeServed = 0; // requests the current runtime served
let runtimeBootAt = 0;
let phpPending = 0; // object requests in the PHP queue or running
// When the last deploy-time spike long-op (/_install, /_activate) finished. The cron alarm
// skips a run within SPIKE_CRON_GRACE_MS of it, so an externally-armed alarm (a visitor to the
// public URL) cannot fire runCron in the gap between /_install and /_activate, where /_activate
// would then reuse the cron runtime and its output (#185).
let lastSpikeEndAt = 0;
// The origin the current runtime booted with (WP_HOME in wp-runtime.php).
let bootOrigin = null;

// The site's own origin, for WP_HOME and every link (issue #33): the var
// SITE_ORIGIN when it is set (deploy/deploy.sh and run.sh set it), so no first
// request can choose it: not PHP's own WebSocket (#55), not a health probe, not
// a second host name. Without SITE_ORIGIN (an unconfigured local run), the
// request's origin, as before; the runtime then reboots when that changes.
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/i;
let siteOriginWarned = false;
function siteOrigin(env, url) {
	const o = env && env.SITE_ORIGIN;
	if (typeof o === 'string' && ORIGIN_RE.test(o)) return o.toLowerCase();
	if (o && !siteOriginWarned) {
		siteOriginWarned = true;
		console.log(JSON.stringify({ m: 'site-origin-invalid', value: String(o).slice(0, 100) }));
	}
	return url.origin;
}
// One PHP runtime per isolate, and PHP is not re-entrant. Measured 2026-11-04:
// with 30 parallel requests on one isolate, about half crashed. So requests
// that use PHP run one at a time, in arrival order.
let phpQueue = Promise.resolve();
// If the request ahead never finishes, a waiter would wait forever. On Free a
// request stopped for CPU can leave the isolate alive with the lock held
// (measured 2026-11-04: 524 timeouts). After LOCK_STALE_MS a waiter goes on with
// a new PHP runtime. 60 s: the installer runs about 32 s on Paid.
const LOCK_STALE_MS = 60000;
// The cron alarm holds off this long after a deploy-time spike op finishes (#185).
const SPIKE_CRON_GRACE_MS = 2000;
// The alarm waits at most this long for the deferred-email sends, so a stuck or throttled
// env.EMAIL.send cannot hold the alarm until the DO wall-clock kills it (#194).
const SEND_TIMEOUT_MS = 5000;
function withPhp(fn) {
	const prev = phpQueue;
	const run = (async () => {
		let timer;
		const stale = await Promise.race([
			prev.then(
				() => false,
				() => false,
			),
			new Promise((ok) => (timer = setTimeout(() => ok(true), LOCK_STALE_MS))),
		]);
		clearTimeout(timer);
		if (stale && bootPromise) runtimeDrops++;
		if (stale) bootPromise = null; // the old runtime's state is unknown
		return fn();
	})();
	phpQueue = run.catch(() => {});
	return run;
}
// D1 keeps a row up to 2 MB. A larger body cannot be stored, and a 4 MB body
// ran the isolate out of memory (measured 2026-11-04). Override with MAX_BODY_BYTES.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// A media upload can be larger: the Worker stores it in R2 first, and PHP gets
// a small marker (php/r2-uploads.php). 20 MB is the Images binding input limit.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const STAGE_MIN_BYTES = 1024 * 1024;

function isMediaUpload(req, url) {
	if (req.method !== 'POST') return false;
	if (url.pathname === '/wp-admin/async-upload.php' || url.pathname === '/wp-admin/media-new.php') return true;
	const route = url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
	return /^\/wp\/v2\/media\/?$/.test(route);
}

// The type of a file from its first bytes, and whether it looks like markup or code.
function sniff(b) {
	const at = (o, str) => [...str].every((c, i) => b[o + i] === c.charCodeAt(0));
	let type = 'application/octet-stream';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) type = 'image/jpeg';
	else if (at(0, '\x89PNG')) type = 'image/png';
	else if (at(0, 'GIF8')) type = 'image/gif';
	else if (at(0, 'RIFF') && at(8, 'WEBP')) type = 'image/webp';
	else if (at(4, 'ftyp')) {
		const brand = String.fromCharCode(...b.slice(8, 12));
		type = /avif|avis/.test(brand) ? 'image/avif' : /heic|heix|mif1|msf1/.test(brand) ? 'image/heic' : 'video/mp4';
	} else if (at(0, '%PDF')) type = 'application/pdf';
	const head = new TextDecoder().decode(b.slice(0, 1024)).toLowerCase();
	return { type, dangerous: /<\?php|<script|<html|<!doctype html|<svg/.test(head) };
}

async function stageFile(env, bytes, contentType) {
	const key = 'staging/' + crypto.randomUUID();
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: contentType || 'application/octet-stream' } });
	const s = sniff(bytes);
	return new TextEncoder().encode('R2STAGED\n' + JSON.stringify({ key, size: bytes.length, sniffed: s.type, dangerous: s.dangerous }));
}

// Store the file part(s) of a large media upload in R2. Returns the body and
// content type PHP gets instead.
async function stageUpload(req, env) {
	const ct = req.headers.get('content-type') || '';
	if (/^multipart\/form-data/i.test(ct)) {
		const form = await req.formData();
		const out = new FormData();
		for (const [k, v] of form) {
			if (typeof v !== 'string' && v.size > 0) {
				const marker = await stageFile(env, new Uint8Array(await v.arrayBuffer()), v.type);
				out.append(k, new File([marker], v.name, { type: v.type }));
			} else {
				out.append(k, v);
			}
		}
		const res = new Response(out);
		return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
	}
	const marker = await stageFile(env, new Uint8Array(await req.arrayBuffer()), ct);
	return { body: marker, contentType: ct };
}

function newStats() {
	return { calls: 0, ms: 0, failures: [], log: [], r2: {}, rowsRead: 0, rowsWritten: 0, inflates: 0, inflateBytes: 0, reinflates: 0, lazyWrites: 0, rfN: 0, rfBytes: 0, rfMs: 0, rfFail: 0, rfCapped: 0, dbTables: {}, ocGroups: {}, ocCalls: 0, ocHits: 0, httpCalls: 0, httpMs: 0, txnOps: 0, undoRows: 0 };
}

// Every statement failure goes through here. resetFailTotal counts the isolate memory resets among
// them and only grows, so a cron tick can read how many writes it has lost so far (#362) even when
// trimStats cuts the list.
let resetFailTotal = 0;
function noteFailure(f) {
	stats.failures.push(f);
	resetFailTotal += resetFailures([f]);
}

// The log and failure lists live as long as the isolate. Keep the newest only.
function trimStats() {
	if (stats.log.length > 2000) stats.log.splice(0, stats.log.length - 1000);
	if (stats.failures.length > 500) stats.failures.splice(0, stats.failures.length - 250);
}

// Entries of a zip, from its central directory. data() returns the file
// bytes: a view for a stored entry, an inflated copy for a deflated one.
function zipEntries(zip) {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = zip.length - 22;
	while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
	if (eocd < 0) return [];
	const total = dv.getUint16(eocd + 10, true);
	let p = dv.getUint32(eocd + 16, true);
	const dec = new TextDecoder();
	const out = [];
	for (let n = 0; n < total; n++) {
		if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
		const method = dv.getUint16(p + 10, true);
		const csize = dv.getUint32(p + 20, true);
		const size = dv.getUint32(p + 24, true);
		const nlen = dv.getUint16(p + 28, true);
		const xlen = dv.getUint16(p + 30, true);
		const clen = dv.getUint16(p + 32, true);
		const local = dv.getUint32(p + 42, true);
		const name = dec.decode(zip.subarray(p + 46, p + 46 + nlen));
		p += 46 + nlen + xlen + clen;
		out.push({
			name,
			method,
			size,
			data(out) {
				const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
				const raw = zip.subarray(start, start + csize);
				return method === 0 ? raw : inflateSync(raw, { out: (out && out(size)) || new Uint8Array(size) });
			},
		});
	}
	return out;
}

// A MEMFS file whose contents are made on first read. Its size is known at
// once, so stat() does not inflate it. A write replaces the lazy contents.
// Lazy files whose contents are inflated now. evictLazy() drops them after a
// request: OPcache holds the compiled code, and a file can be inflated again.
// Measured 2026-11-04: with WooCommerce, keeping them hit "Worker exceeded
// memory limit".
// Within a request too: the inflated copies are capped at LAZY_CACHE_BYTES,
// oldest dropped first. A WooCommerce checkout reads about 1,500 compiled files.
// 2 MiB since #394 (was 8). At every failing post-new INSERT on pf394a the cache sat at its cap; at 2
// post-new died 60 of 100 rounds against 82 of 100 at 8, with boot time and inflates per boot unchanged
// (repeat pair, 2026-11-13/14, #394 issuecomment-6868335297). LAZY_CACHE_MB overrides (#218).
let LAZY_CACHE_BYTES = 2 * 1024 * 1024;
// #394 step 2 (LAZY_ARENA=on, off by default): inflate into ONE reused arena per isolate instead of a
// new buffer per file (inflate-arena.mjs). LAZY_ARENA_MB sizes it (default: LAZY_CACHE_BYTES).
let inflateArena = null;
function arenaOn() { return !!(ENV && ENV.LAZY_ARENA === 'on'); }
function getArena() {
	if (!inflateArena) {
		const mb = Number(ENV && ENV.LAZY_ARENA_MB);
		inflateArena = createArena(Number.isFinite(mb) && mb >= 1 && mb <= 64 ? Math.round(mb) * 1048576 : LAZY_CACHE_BYTES);
	}
	return inflateArena;
}
const inflated = new Map(); // drop function -> bytes
// FILE_TRACE=on (#394 M0): record which bundle files each request reads (file-trace.mjs, GET /_trace).
// Off by default; it changes no behavior, only notes the path of each read.
const fileTrace = createTrace();
const tracing = () => Boolean(ENV && ENV.FILE_TRACE === 'on');
let inflatedBytes = 0;
// #394 L1: the boot pack's file nodes, mounted for one request when a runtime boots.
let bootPackPaths = null;
// #563: the remote OPcache packs of the runtime booted last (null: none), and what its boot did with
// them, for x-perf (remote): 'packs <n> files', 'off', 'fallback:no-assets-binding', or 'none'.
let remotePacks = null;
let remoteState = 'none';
const remoteOn = () => Boolean(OPCACHE_REMOTE && ENV && ENV.OPCACHE_REMOTE !== 'off');
// The loader's open() asks this first (prepare.sh, #563). null: open now. A promise: PHP waits for the
// pack; if it rejects, the open fails with EIO and OPcache compiles the script from source.
function remoteOpenHook(path) {
	if (!remotePacks || path.length <= OPCACHE_DIR.length + 1 || !path.startsWith(OPCACHE_DIR + '/')) return null;
	return remotePacks.open(path.slice(OPCACHE_DIR.length + 1));
}
async function fetchRemotePack(name) {
	const r = await ENV.ASSETS.fetch(new Request('https://assets.local/_pf/' + OPCACHE_REMOTE.id + '/' + name));
	if (!r.ok) throw new Error(name + ' answered ' + r.status);
	return new Uint8Array(await r.arrayBuffer());
}
// A node per remote file: its size is known at once (stat needs no bytes), its contents come from
// the held pack. A read with the pack not held fails with EIO (the open fetches it first).
function remoteFile(FS, path, name, size) {
	FS.writeFile(path, new Uint8Array(0));
	attachLazyContents(FS.lookupPath(path).node, size, (out) => {
		const b = remotePacks && remotePacks.data(name, out);
		if (!b) throw new FS.ErrnoError(29);
		return b;
	}, { src: 'opcache', path });
}
// What the last boot did with the boot pack, for x-perf (l1): 'assets', 'fallback:<why>', or 'none'.
let l1State = 'none';
async function loadBootPacks() {
	const t = Date.now();
	const base = 'https://assets.local/_pf/' + OPCACHE_BOOT.id + '/';
	// OPCACHE_BOOT_SOURCE=none forces the no-pack path (a test of it; see tests/l1-e2e.sh).
	if (ENV && ENV.ASSETS && ENV.OPCACHE_BOOT_SOURCE !== 'none') {
		try {
			const packs = await Promise.all(
				OPCACHE_BOOT.chunks.map(async (c) => {
					const r = await ENV.ASSETS.fetch(new Request(base + c));
					if (!r.ok) throw new Error(c + ' answered ' + r.status);
					return new Uint8Array(await r.arrayBuffer());
				}),
			);
			const kib = Math.round(packs.reduce((n, p) => n + p.length, 0) / 1024);
			console.log(JSON.stringify({ m: 'l1', source: 'assets', chunks: packs.length, kib, ms: Date.now() - t }));
			l1State = `assets ${kib}KiB ${Date.now() - t}ms`;
			return packs;
		} catch (e) {
			l1State = 'fallback:compile:assets-failed';
			console.error(JSON.stringify({ m: 'l1', fallback: 'compile', why: 'assets failed: ' + String((e && e.message) || e).slice(0, 160) }));
			return [];
		}
	}
	// No boot pack: this boot compiles the boot-only scripts from source (OPcache's normal path).
	// There is NO in-memory fallback on purpose: #411 measured that a data module costs isolate memory
	// even when it is never imported (p411-lazy, 144 MiB, 3 of 3), so a fallback module would cost
	// exactly the memory L1 saves. Said loudly, every time.
	l1State = ENV && ENV.ASSETS ? 'fallback:compile:forced' : 'fallback:compile:no-assets-binding';
	console.error(JSON.stringify({ m: 'l1', fallback: 'compile', why: ENV && ENV.ASSETS ? 'OPCACHE_BOOT_SOURCE=none' : 'no ASSETS binding' }));
	return [];
}
function dropBootPack(FS) {
	if (!bootPackPaths) return;
	for (const p of bootPackPaths) {
		try {
			FS.unlink(p);
		} catch {
			// already gone
		}
	}
	bootPackPaths = null;
}
function evictLazy() {
	for (const drop of inflated.keys()) drop();
	if (inflateArena) inflateArena.evictAll(); // #394: the arena's entries too; the arena itself stays
	inflated.clear();
	inflatedBytes = 0;
}
function noteInflated(drop, bytes) {
	stats.inflates++;
	stats.inflateBytes += bytes;
	inflated.set(drop, bytes);
	inflatedBytes += bytes;
	for (const [old, n] of inflated) {
		if (inflatedBytes <= LAZY_CACHE_BYTES || old === drop) break;
		old();
		inflated.delete(old);
		inflatedBytes -= n;
	}
}

// Set the lazy contents getter on an already-created MEMFS file node: inflate on
// first read, cap+evict the inflated copies (noteInflated). Shared by lazyFile
// (eager node) and the lazy-node mount (node created on lookup).
function attachLazyContents(node, size, dataFn, tag) {
	let contents = null;
	let written = false;
	let used = size;
	let inflations = 0; // #394: a second inflate of this file is a RE-inflate (its copy was evicted)
	const drop = () => {
		if (!written) contents = null;
	};
	Object.defineProperty(node, 'contents', {
		configurable: true,
		get() {
			if (tag && tracing()) fileTrace.read(tag.src, tag.path, size);
			if (contents === null) {
				if (inflations++ > 0) stats.reinflates++;
				// #394 step 2: with LAZY_ARENA=on, a deflated file inflates into the arena (a stored one is a view
				// of the bundle and needs no buffer; a file larger than the arena gets its own, as before).
				let inArena = false;
				const out = arenaOn() ? (n) => { const v = getArena().alloc(n, drop); inArena = !!v; return v; } : null;
				contents = dataFn(out);
				if (inArena) {
					stats.inflates++;
					stats.inflateBytes += contents.length;
				} else {
					noteInflated(drop, contents.length);
				}
			}
			return contents;
		},
		set(v) {
			contents = v;
			written = true; // PHP wrote this file. Keep it.
		},
	});
	Object.defineProperty(node, 'usedBytes', {
		configurable: true,
		get() {
			return used;
		},
		set(v) {
			used = v;
		},
	});
	// #530: MEMFS.write overwrites in place (contents.set) when a write fits inside usedBytes, and
	// never assigns node.contents, so the setter above never saw it: the file stayed unwritten and
	// drop() threw the edit away at the next evict (or, with LAZY_ARENA, the next ring overlap).
	// Every PHP write goes through stream.stream_ops.write, which FS.open copies from node.stream_ops,
	// so this node gets its own ops: before ANY write, take a private copy of the contents (never a
	// view into the bundle, the inflate cache or the arena) and mark the file written. msync calls
	// MEMFS.stream_ops.write directly, so it is wrapped too.
	const base = node.stream_ops;
	if (base && typeof base.write === 'function') {
		const own = () => {
			if (written) return;
			const c = node.contents; // inflates if it was dropped
			contents = c ? c.slice() : null;
			written = true;
			stats.lazyWrites++;
		};
		node.stream_ops = Object.assign(Object.create(base), {
			write(stream, buffer, offset, length, position, canOwn) {
				own();
				return base.write(stream, buffer, offset, length, position, canOwn);
			},
			...(typeof base.msync === 'function' ? { msync(stream, buffer, offset, length, flags) { own(); return base.msync(stream, buffer, offset, length, flags); } } : {}),
		});
	}
}

function lazyFile(FS, path, entry, src) {
	FS.writeFile(path, new Uint8Array(0));
	attachLazyContents(FS.lookupPath(path).node, entry.size, (out) => entry.data(out), src ? { src, path } : null);
}

// Lazy MEMFS NODE creation (issue #218, LAZY_NODES=on). Eager node creation
// (lazyFile per entry) makes a MEMFS node for every file in the tree at boot.
// Node contents are already lazy, but each NODE object costs about 1 KiB of the
// V8 JS heap, which x-wasm-mib (the PHP WASM heap only) does not measure yet
// counts against the 128 MiB isolate cap. A request touches about a quarter of
// the ~6800 files, so the other ~5000 nodes are ~5 MiB of V8 heap spent for
// nothing: the headroom approach A needs for its JS MySQL client. This mounts a
// directory INDEX onto a MEMFS dir and creates a child node only when the path
// is first looked up (or the directory is listed), adapted from HostlessWP
// (runtime/src/lazyfs.js at 739e8e7, GPL-2.0-or-later; docs/prior-art.md).
// Files inflate and evict through attachLazyContents, exactly as lazyFile.
function buildZipIndex(zip) {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = zip.length - 22;
	while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
	if (eocd < 0) throw new Error('lazy: zip end-of-central-directory not found');
	const total = dv.getUint16(eocd + 10, true);
	const dec = new TextDecoder();
	const root = { files: new Map(), dirs: new Map() };
	let p = dv.getUint32(eocd + 16, true);
	for (let n = 0; n < total; n++) {
		if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('lazy: bad central directory entry');
		const nlen = dv.getUint16(p + 28, true);
		const xlen = dv.getUint16(p + 30, true);
		const clen = dv.getUint16(p + 32, true);
		const segs = dec.decode(zip.subarray(p + 46, p + 46 + nlen)).split('/');
		const file = segs.pop();
		let idx = root;
		for (const s of segs) {
			if (!s) continue;
			let sub = idx.dirs.get(s);
			if (!sub) idx.dirs.set(s, (sub = { files: new Map(), dirs: new Map() }));
			idx = sub;
		}
		if (file) idx.files.set(file, p); // just the central-directory offset: a number, not a node
		p += 46 + nlen + xlen + clen;
	}
	return { root, zip, dv };
}
// The file bytes for one central-directory offset, inflated on demand (same as zipEntries.data()).
function lazyEntryData(zip, dv, p, out) {
	const method = dv.getUint16(p + 10, true);
	const csize = dv.getUint32(p + 20, true);
	const size = dv.getUint32(p + 24, true);
	const local = dv.getUint32(p + 42, true);
	const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
	const raw = zip.subarray(start, start + csize);
	return method === 0 ? raw : inflateSync(raw, { out: (out && out(size)) || new Uint8Array(size) });
}
function lazyEntrySize(dv, p) {
	return dv.getUint32(p + 24, true);
}
const lazyOpsCache = new WeakMap();
const isLazyOps = new WeakSet();
function lazyOpsFor(base, FS, store) {
	let ops = lazyOpsCache.get(base);
	if (ops) return ops;
	// Materialise one child node from the index on first lookup. INVARIANT: the
	// name is deleted from the index BEFORE base.mknod, so a name is in the index
	// XOR a real MEMFS child, never both; that is what keeps a later lazy lookup
	// from shadowing a file PHP has since written (its setter marks it written).
	const child = (parent, name) => {
		const idx = parent.lazyIndex;
		if (!idx) return null;
		const sub = idx.dirs.get(name);
		if (sub) {
			idx.dirs.delete(name);
			const node = base.mknod(parent, name, 0o40755, 0);
			makeLazyDir(FS, node, sub, store);
			lazyStats.nodes++;
			return node;
		}
		const p = idx.files.get(name);
		if (p === undefined) return null;
		idx.files.delete(name);
		const node = base.mknod(parent, name, 0o100644, 0);
		attachLazyContents(node, lazyEntrySize(store.dv, p), (out) => lazyEntryData(store.zip, store.dv, p, out));
		lazyStats.nodes++;
		return node;
	};
	const all = (node) => {
		const idx = node.lazyIndex;
		if (!idx) return;
		for (const name of [...idx.dirs.keys(), ...idx.files.keys()]) child(node, name);
	};
	ops = {
		...base,
		lookup(parent, name) {
			return child(parent, name) || base.lookup(parent, name);
		},
		readdir(node) {
			all(node);
			return base.readdir(node);
		},
		rmdir(parent, name) {
			all(FS.lookupNode(parent, name));
			return base.rmdir(parent, name);
		},
		rename(oldNode, newDir, newName) {
			try {
				all(FS.lookupNode(newDir, newName));
			} catch {}
			return base.rename(oldNode, newDir, newName);
		},
	};
	lazyOpsCache.set(base, ops);
	isLazyOps.add(ops);
	return ops;
}
const lazyStats = { nodes: 0 };
function makeLazyDir(FS, node, index, store) {
	node.lazyIndex = index;
	if (!isLazyOps.has(node.node_ops)) node.node_ops = lazyOpsFor(node.node_ops, FS, store);
}
// Mount a whole zip's tree lazily under a MEMFS directory (default root). The
// zip's own top-level directory (e.g. "wordpress") materialises on first lookup.
function mountLazyZip(FS, mountPath, zip) {
	const store = buildZipIndex(zip);
	makeLazyDir(FS, FS.lookupPath(mountPath).node, store.root, store);
}

// One message from PHP: a D1 statement, an R2 or Images operation, a cache
// purge, or a failure report. In the Worker it comes through php.onMessage; in
// the checkout Container, through the outbound handler for worker.internal.
// Async email (issue #185): PHP's wp_mail hands the message here (the isolate has no
// mail transport). Record it fast and return so checkout never waits on the send. The
// send leg (a Queue producer, or ctx.waitUntil to the Email REST API, pending the WfP
// queue-binding decision and a verified sender domain) lands next; a consumer then
// delivers via Cloudflare Email Service.
//
// In a cron tick (tickMail set, #362, email-handoff.mjs) the op hands the message to the durable path
// and waits for that before PHP goes on, so an isolate reset later in the tick cannot lose it. A
// request still collects the messages and sends them after the response.
function emailOp(email) {
	stats.email = (stats.email || 0) + 1;
	if (tickMail) return tickMail.op(email);
	pendingEmails.push(email);
	return { ok: true, queued: true };
}

// The mail side of the cron tick that is running PHP now, or null. Set and cleared by runCron
// inside its withPhp turn, so only that tick's PHP sees it.
let tickMail = null;
// The running cron leg's record writer (#471, cron-health.mjs), set by the alarm around runCron.
let cronRunSink = null;

// A tick's handoff: one message to the durable path (sendList), bounded like the alarm drain.
// Resolves to 'bounded' when the send was still in flight at SEND_TIMEOUT_MS. storage is the PHP
// object's durable storage: the dedupe markers of #370 live there (key -> the time it was sent).
// No storage, no dedupe (a mail is never held for want of it).
function tickMailFor(env, storage) {
	const base = resetFailTotal;
	const st = storage && typeof storage.get === 'function' ? storage : null;
	return createTickMail({
		seen: st ? async (key) => (await st.get(key)) !== undefined : null,
		mark: st ? (key) => st.put(key, Date.now()) : null,
		handoff: async (email) => {
			const sp = sendList(env, [email]);
			if (!sp) return 0;
			const r = await boundedWait(sp, SEND_TIMEOUT_MS);
			return r === TIMED_OUT ? 'bounded' : r;
		},
		lostWrites: () => resetFailTotal - base,
		log: (o) => console.log(JSON.stringify(o)),
	});
}

// Send a wp_mail message through the send_email binding (issue #185). Transactional
// mail. The From address is this site's MAIL_FROM, or wordpress@<its host> when
// that host can send (mail-from.mjs). It is not a shared WooCommerce address.
// A From the message asked for, when it is a different real address, becomes
// the Reply-To. Returns [] when the site has no sender or no binding.
function sendEmail(env, email) {
	// A demo site sends no mail (site-lock.mjs).
	if (demoLocked(env)) return [];
	const from = sender(env);
	if (!from || !env || !env.EMAIL) return [];
	const { deliverable, dropped } = deliverableRecipients(email.to);
	if (dropped) {
		stats.emailDropped = (stats.emailDropped || 0) + dropped;
		console.log('email send: ' + dropped + ' undeliverable recipient(s) dropped');
	}
	if (!deliverable.length) return [];
	const body = String(email.message || '');
	const looksHtml = /<[a-z!\/]/i.test(body) || /text\/html/i.test(String(email.headers || ''));
	const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
	const html = looksHtml ? body : '<pre>' + esc(body) + '</pre>';
	const text = looksHtml ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : body;
	const subject = String(email.subject || '(no subject)');
	const msg = { to: null, from, subject, html, text };
	const rt = replyTo(from.email, email.headers);
	if (rt) msg.replyTo = rt;
	return deliverable.map((to) => env.EMAIL.send({ ...msg, to }).then((r) => ((stats.emailSent = (stats.emailSent || 0) + 1), r)));
}

// Drain the queued wp_mail messages (emailOp) and send them through the send_email binding.
// Both the request path and the DO alarm call this, so the deferred WC order emails are actually
// SENT even when no request follows on a low-traffic store (#185): emailOp only enqueues into the
// pendingEmails module global, so without a drain the queued mails were lost on the next isolate
// recycle. Returns a promise resolving to the count sent, or null when nothing is queued; the
// caller waitUntil's it (request/alarm, non-blocking) or awaits it (a manual /_runcron).
function sendPending(env) {
	if (!pendingEmails.length) return null;
	const toSend = pendingEmails;
	pendingEmails = [];
	return sendList(env, toSend);
}

// Send a list of wp_mail messages: to the durable queue when it is on (#190), else straight
// through the send_email binding. Returns a promise of the count, or null for an empty list.
function sendList(env, toSend) {
	if (!toSend.length) return null;
	if (!env || !env.EMAIL || !sender(env)) {
		console.log('email send: ' + toSend.length + ' dropped, MAIL_FROM or the send_email binding is not set');
		return Promise.resolve(0);
	}
	// Durable path (#190): hand the drain to the queue; the consumer delivers with retry.
	if (emailQueueEnabled(env)) return enqueueEmails(env, toSend);
	return Promise.allSettled(toSend.flatMap((e) => sendEmail(env, e))).then((rs) => {
		const failed = rs.filter((x) => x.status === 'rejected').length;
		if (failed) console.log('email send: ' + failed + ' of ' + rs.length + ' failed');
		return rs.length - failed;
	});
}

// Producer: hand the drained wp_mail messages to the durable queue (#190). The
// consumer (the queue() export) delivers them with retry + backoff + dead-letter.
// On a queue outage, fall back to a best-effort direct send so a transient Queues
// failure does not lose the mail; the fallback is the v1 path.
async function enqueueEmails(env, emails) {
	try {
		for (const chunk of chunkBatch(emails, 100)) {
			await env.EMAIL_QUEUE.sendBatch(chunk.map((body) => ({ body })));
		}
		stats.emailQueued = (stats.emailQueued || 0) + emails.length;
		return emails.length;
	} catch (e) {
		console.log('email queue: enqueue failed (' + String((e && e.message) || e).slice(0, 120) + '), direct send fallback');
		const rs = await Promise.allSettled(emails.flatMap((em) => sendEmail(env, em)));
		return rs.filter((x) => x.status === 'fulfilled').length;
	}
}

// Consumer: deliver one queued wp_mail message. Ack on success (or when there is
// nothing deliverable), retry with backoff on a send failure. After the consumer's
// max_retries the runtime routes the message to the dead-letter queue (#190). The
// ack/retry/backoff control flow is handleQueuedEmail (email-queue.mjs), unit-tested.
async function deliverQueuedEmail(msg, env) {
	return handleQueuedEmail(
		msg,
		async (email) => {
			if (!env || !env.EMAIL || !sender(env)) return { attempted: 0, failed: 0 };
			const results = sendEmail(env, email);
			if (!results.length) return { attempted: 0, failed: 0 };
			const rs = await Promise.allSettled(results);
			const failed = rs.filter((x) => x.status === 'rejected').length;
			if (failed) stats.emailQueueFailed = (stats.emailQueueFailed || 0) + 1;
			else stats.emailQueueSent = (stats.emailQueueSent || 0) + rs.length;
			return { attempted: rs.length, failed };
		},
		{ onRetry: (delaySeconds) => console.log(JSON.stringify({ m: 'email-queue-retry', attempts: msg.attempts, delaySeconds })) }
	);
}

// A dead-lettered message has exhausted its retries. Log and meter it for operator
// visibility, then ack so it does not loop.
function deadLetterEmail(msg) {
	stats.emailDead = (stats.emailDead || 0) + 1;
	const to = msg.body && msg.body.to;
	// A recipient count, never an address: Workers Logs is not a mail log.
	console.log(JSON.stringify({ m: 'email-dead-letter', recipients: (Array.isArray(to) ? to : [to]).filter(Boolean).length, subject: String((msg.body && msg.body.subject) || '').slice(0, 80) || null }));
	msg.ack();
}

// The queue() consumer. One handler serves both the email queue and its dead-letter
// queue (the "-dlq" suffix). b-dosql only; harmless when no consumer is configured,
// since the runtime never calls it then.
async function consumeEmailQueue(batch, env) {
	ENV = env;
	if (isDeadLetterQueue(batch && batch.queue)) {
		for (const msg of batch.messages) deadLetterEmail(msg);
		return;
	}
	for (const msg of batch.messages) await deliverQueuedEmail(msg, env);
}

// Caption an uploaded image for alt text (php/ai-alt-text.php). PHP sends the
// public URL and the R2 key of a rendition that has no alt text; the Worker asks
// the AI binding for a one-line description and returns it. Fail safe: any error
// or timeout returns ok:true with a degraded reason and no alt, so the upload is
// never blocked.
// Model: box-tested 2026-11-08 on a live b-dosql deploy. @cf/llava-hf/llava-1.5-7b-hf
// with the bytes+prompt input returns { description }; @cf/moondream/moondream3.1-9B-A2B
// returned {} for every input shape tried (URL, base64 caption, base64 prompt) and
// @cf/unum/uform-gen2-qwen-500m is 410-deprecated, so llava-hf is the only working
// image-to-text model on the account. NOTE: its model page shows a planned deprecation
// of 2026-11-20; when Cloudflare retires it, repoint AI_ALT_MODEL (the feature degrades
// safely to empty alt until then, never blocking an upload).
// Memory (issue #189): the op fires AFTER the attachment is stored (off the insert
// critical path) and reads only the small RENDITION the plugin chose, not the original,
// so the byte array is a few hundred KB on an isolate at ~mib 58 (media-write-trim
// wcskips WooCommerce on the upload request). Ample headroom.
// Billing: Workers AI runs on Unified Billing (the Cloudflare credit balance). An
// AI Gateway wrapper (caching, rate limits, analytics) could sit in front later;
// this uses the direct env.AI binding to start.
const AI_ALT_DEFAULT_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';
function captionLength() {
	return ENV.AI_ALT_LENGTH === 'normal' || ENV.AI_ALT_LENGTH === 'long' ? ENV.AI_ALT_LENGTH : 'short';
}
// Tidy a model caption into alt text: one line, no wrapping quotes, no boilerplate
// opener ("This image shows ...", "A photo of ..."), capped at a sane length on a
// word boundary. WordPress sanitizes it again before it is stored.
function cleanAlt(text, cap) {
	let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
	s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
	s = s.replace(/^(the|this|an?)\s+(image|picture|photo|photograph)\s+(of|showing|shows|depicting|depicts|is of|is|featuring|features|containing|contains|portraying|portrays)\s+/i, '');
	s = s.replace(/^(image|picture|photo|photograph)\s+of\s+/i, '');
	s = s.replace(/^in\s+(this|the)\s+(image|picture|photo|photograph)\s*,?\s+/i, '');
	if (!s) return s;
	s = s.charAt(0).toUpperCase() + s.slice(1);
	if (s.length > cap) {
		s = s.slice(0, cap);
		const sp = s.lastIndexOf(' ');
		if (sp > cap * 0.6) s = s.slice(0, sp);
		s = s.replace(/[\s,;:.\-]+$/, '');
	}
	return s;
}
async function aiAltOp(op) {
	const t0 = Date.now();
	stats.ai = stats.ai || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.ai.n++;
	const done = (r) => {
		stats.ai.ms += Date.now() - t0;
		if (r && r.alt) stats.ai.ok++;
		else stats.ai.fail++;
		return r;
	};
	try {
		if (!ENV.AI) return done({ ok: true, degraded: 'no AI binding' });
		const model = typeof ENV.AI_ALT_MODEL === 'string' && ENV.AI_ALT_MODEL ? ENV.AI_ALT_MODEL : AI_ALT_DEFAULT_MODEL;
		const flavor = ENV.AI_ALT_INPUT === 'caption' ? 'caption' : 'prompt';
		const cap = Math.max(16, Math.min(300, Number(ENV.AI_ALT_MAX_CHARS || 160)));
		const timeoutMs = Math.max(1000, Math.min(60000, Number(ENV.AI_ALT_TIMEOUT_MS || 12000)));

		// Build the model input. prompt flavor (default; llava/llama): image is an array
		// of bytes from the rendition with a text prompt, returning { description } or
		// { response }. caption flavor (opt-in AI_ALT_INPUT=caption, for a caption model
		// that supports it): image is a public URL or base64 data URI with task "caption",
		// returning { caption }; the URL path reads no bytes into the isolate.
		let input;
		if (flavor === 'caption' && op.url) {
			input = { image: op.url, task: 'caption', caption_length: captionLength() };
		} else {
			if (!op.key || !ENV.MEDIA) return done({ ok: true, degraded: 'no image source' });
			const o = await ENV.MEDIA.get(op.key);
			if (!o) return done({ ok: true, degraded: 'image not found' });
			const bytes = new Uint8Array(await o.arrayBuffer());
			if (flavor === 'caption') {
				const mime = op.mime || (o.httpMetadata && o.httpMetadata.contentType) || 'image/jpeg';
				input = { image: 'data:' + mime + ';base64,' + b64encode(bytes), task: 'caption', caption_length: captionLength() };
			} else {
				const prompt = typeof ENV.AI_ALT_PROMPT === 'string' && ENV.AI_ALT_PROMPT ? ENV.AI_ALT_PROMPT : 'Describe this image in one short, factual sentence for use as alt text. Do not begin with "an image of" or "a picture of".';
				input = { image: [...bytes], prompt, max_tokens: 128 };
			}
		}

		const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
		const r = await Promise.race([ENV.AI.run(model, input), timeout]);
		if (r && r.__timeout) return done({ ok: true, degraded: 'ai timeout' });
		const raw = r && (r.caption != null ? r.caption : r.description != null ? r.description : r.response != null ? r.response : r.text != null ? r.text : typeof r === 'string' ? r : '');
		const alt = cleanAlt(raw, cap);
		if (!alt) return done({ ok: true, degraded: 'empty caption' });
		return done({ ok: true, alt });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

async function purgeZoneOp(op) {
	const t0 = Date.now();
	stats.purgeZone = stats.purgeZone || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.purgeZone.n++;
	const done = (r) => {
		stats.purgeZone.ms += Date.now() - t0;
		if (r && r.purged) stats.purgeZone.ok++;
		else stats.purgeZone.fail++;
		return r;
	};
	try {
		// The token and zone stay in the Worker (like the AI binding): PHP sends
		// only the URLs. No binding means the gate should not have injected the
		// define, so this is belt and braces.
		if (!ENV.PURGE_TOKEN || !ENV.PURGE_ZONE) return done({ ok: true, degraded: 'no purge binding' });
		// A purge covers this site's own host only (purge-zone.mjs), never the zone.
		const body = purgeZoneBody(op, ownPurgeHost(ENV.SITE_ORIGIN));
		if (!body) return done({ ok: true, degraded: 'nothing to purge' });
		const timeoutMs = Math.max(1000, Math.min(30000, Number(ENV.PURGE_TIMEOUT_MS || 10000)));
		const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
		const r = await Promise.race([
			fetch(cfPurgeEndpoint(ENV.PURGE_ZONE), {
				method: 'POST',
				headers: { authorization: `Bearer ${ENV.PURGE_TOKEN}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			timeout,
		]);
		if (r && r.__timeout) return done({ ok: true, degraded: 'purge timeout' });
		let j = null;
		try { j = await r.json(); } catch (_) {}
		const purged = !!(r && r.ok && j && j.success);
		// One line per purge sent, so a run can count them (wrangler tail). The
		// token is never logged.
		console.log(JSON.stringify({ m: 'purge_zone', sent: 1, host: !!body.hosts, files: body.files ? body.files.length : 0, status: r ? r.status : 0, ok: purged, errors: (j && j.errors) || [] }));
		return done({ ok: true, purged, status: r ? r.status : 0, errors: (j && j.errors) || [] });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

// Render an order to a PDF invoice (issue #227). Build the HTML with renderOpPlan,
// render it with the Browser Rendering binding, store the PDF in the MEDIA bucket under
// a private invoices/ prefix, and return a signed, expiring download URL. The signing
// secret (INVOICE_TOKEN) stays in the Worker; PHP relays the URL and never sees it, as
// with the AI binding and the purge token. Fail safe: any failure returns
// { ok: true, degraded } and the order is untouched.
async function browserRenderOp(op) {
	const t0 = Date.now();
	stats.browserRender = stats.browserRender || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.browserRender.n++;
	const done = (r) => {
		stats.browserRender.ms += Date.now() - t0;
		if (r && r.url) stats.browserRender.ok++;
		else stats.browserRender.fail++;
		return r;
	};
	try {
		if (!ENV.BROWSER || !ENV.MEDIA) return done({ ok: true, degraded: 'no browser binding' });
		const plan = renderOpPlan(op);
		if (!plan.ok) return done({ ok: true, degraded: plan.error });
		const key = invoiceKey(plan.orderId, bytesToHex(crypto.getRandomValues(new Uint8Array(16))));
		const timeoutMs = Math.max(2000, Math.min(60000, Number(ENV.PDF_INVOICE_TIMEOUT_MS || 20000)));
		let bytes;
		try {
			// Dynamic import so index.js still loads where @cloudflare/puppeteer is not
			// installed (local dev, the pure-helper tests); the real render needs the Browser
			// Rendering binding on a Paid deploy.
			const puppeteer = (await import('@cloudflare/puppeteer')).default;
			const render = (async () => {
				const browser = await puppeteer.launch(ENV.BROWSER);
				try {
					const page = await browser.newPage();
					await page.setContent(plan.html, { waitUntil: 'load' });
					return await page.pdf({ format: 'A4', printBackground: true });
				} finally {
					await browser.close();
				}
			})();
			const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
			const r = await Promise.race([render, timeout]);
			if (r && r.__timeout) return done({ ok: true, degraded: 'render timeout' });
			bytes = r instanceof Uint8Array ? r : new Uint8Array(r);
		} catch (e) {
			return done({ ok: true, degraded: 'render: ' + String(e && e.message ? e.message : e).slice(0, 160) });
		}
		await ENV.MEDIA.put(key, bytes, { httpMetadata: { contentType: plan.contentType } });
		// Signed, expiring download URL. Without INVOICE_TOKEN the PDF is stored but no link
		// is minted, so PHP surfaces nothing (fail safe).
		let downloadUrl = null;
		if (ENV.INVOICE_TOKEN) {
			const ttl = Math.max(300, Math.min(31536000, Number(ENV.INVOICE_URL_TTL || 604800)));
			const exp = Math.floor(Date.now() / 1000) + ttl;
			const sig = await signDownload(ENV.INVOICE_TOKEN, key, exp);
			downloadUrl = invoiceDownloadPath(key, exp, sig);
		}
		console.log(JSON.stringify({ m: 'browser_render', kind: 'invoice', bytes: bytes.length, stored: true, signed: !!downloadUrl }));
		return done({ ok: true, key, url: downloadUrl, bytes: bytes.length });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}


// Verify a Turnstile token for a gated form (php/turnstile-forms.php, issue #250).
// PHP reads the token from the form POST (or the Store API extension) and sends it here; the
// secret (TURNSTILE_SECRET) stays in the Worker and PHP never sees it. The browser never calls
// siteverify.
//   - success:true  only when Cloudflare returned success:true for this token.
//   - success:false with error set means the verifier was unreachable (a timeout or a network
//     failure); PHP shows it as an outage, and a login or a checkout is still refused.
//   - success:false with no error is a missing, bad, spent or unverified token.
// In the object (PHP_IN_DO=on), the op never fetches and never waits (#351): the front Worker
// verified the request before it reached the object (preverifyTurnstile), and the op answers from
// that result (turnstileSlot), once, for the same token. A verify from inside the object waited
// at the output gate for the writes the request had made, and an isolate reset in that wait lost
// them. With PHP in the Worker there is no output gate, so the op verifies itself.
const turnstileSlot = new TurnstileSlot();
async function turnstileOp(op) {
	const t0 = Date.now();
	stats.turnstile = stats.turnstile || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.turnstile.n++;
	const done = (r) => {
		stats.turnstile.ms += Date.now() - t0;
		if (r && r.success) stats.turnstile.ok++;
		else stats.turnstile.fail++;
		return r;
	};
	try {
		// No secret means the gate should not have injected the define, so this is
		// belt and braces: fail closed (the form is rejected), never open.
		if (!ENV.TURNSTILE_SECRET) return done({ ok: true, success: false, error: 'no turnstile secret' });
		let res;
		if (ENV.PHP_IN_DO === 'on') {
			res = turnstileSlot.take(op && op.token);
		} else {
			res = await verifyToken(ENV.TURNSTILE_SECRET, op && op.token, op && op.remoteip, {
				timeoutMs: turnstileTimeoutMs(ENV),
				expect: { hostname: siteHost(ENV.SITE_ORIGIN), action: TURNSTILE_ACTION },
			});
		}
		// The token and the secret are never logged; only the outcome and the codes.
		console.log(JSON.stringify({ m: 'turnstile', where: ENV.PHP_IN_DO === 'on' ? 'object' : 'worker', success: res.success, codes: res.codes || [], error: res.error, tries: res.tries, ms: Date.now() - t0 }));
		return done({ ok: true, success: res.success, codes: res.codes || [], error: res.error });
	} catch (e) {
		return done({ ok: true, success: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

// Record one anonymized pageview (php/analytics-pageview.php, issue #201). PHP
// sends the request facts (host, path, status, country); the Worker holds the
// Analytics Engine dataset binding and does the writeDataPoint, so PHP never sees
// the binding, as with the AI binding and the purge token. Fire and forget:
// writeDataPoint returns void, so the op does not await it. Fail safe: no binding
// or any error returns { ok: true, degraded } and nothing is recorded; the
// pageview is never on the render critical path (PHP sends it on shutdown).
function analyticsOp(op) {
	const t0 = Date.now();
	stats.analytics = stats.analytics || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.analytics.n++;
	const done = (r) => {
		stats.analytics.ms += Date.now() - t0;
		if (r && r.recorded) stats.analytics.ok++;
		else stats.analytics.fail++;
		return r;
	};
	try {
		// No binding means the gate should not have injected the define, so this is
		// belt and braces: record nothing, never throw.
		if (!ENV.ANALYTICS) return done({ ok: true, degraded: 'no analytics binding' });
		recordPageview(ENV.ANALYTICS, op);
		return done({ ok: true, recorded: true });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

async function handleMessage(raw) {
	// #452: a message that is not a JSON object is refused with an error PHP can read, never a throw.
	// Only its length is logged: the content may be anything PHP sent.
	const parsed = parseMessage(raw);
	if (!parsed.ok) {
		console.log(JSON.stringify({ m: 'message', refused: parsed.error, bytes: typeof raw === 'string' ? raw.length : null }));
		return JSON.stringify({ ok: false, error: parsed.error });
	}
	const m = parsed.m;
	if (m.http) return JSON.stringify(await httpOp(m.http));
	if (m.txn) return JSON.stringify(sqlDb ? txnOp(sqlDb, sqlStorage, m.txn) : { ok: false, error: 'no database in the object' });
	if (m.oc) return JSON.stringify(await objectCacheOp(m.oc));
	if (m.probeMem) return JSON.stringify({ wasm: lastBootedPhp ? lastBootedPhp[__private__dont__use].HEAPU8.length : null });
	if (m.memTrace) { lastMemTrace = m.memTrace; return '1'; }
	// #471: the job a cron leg is about to run (sent BEFORE it runs), and PHP's own fatal error. Logged
	// at once, so a leg the isolate kills still says what it was doing; also kept in the run record.
	if (m.cronMark) {
		const mk = cronMarkOf(m.cronMark);
		console.log(JSON.stringify({ m: 'cron', mark: 'start', ...mk }));
		if (cronRunSink) await cronRunSink({ lastMark: { t: Date.now(), ...mk } });
		return '1';
	}
	if (m.cronFatal) {
		const f = cronFatalOf(m.cronFatal);
		console.log(JSON.stringify({ m: 'cron', fatal: 'php', ...f }));
		if (cronRunSink) await cronRunSink({ lastFatal: { t: Date.now(), ...f } });
		return '1';
	}
	// One trace checkpoint as it happens (#434), so a request killed by an isolate reset still
	// leaves its marks in Workers Logs. Names and numbers only; mem-trace.php runs only for an
	// operator request.
	if (m.memMark) { console.log(JSON.stringify({ m: 'mem-mark', ...(typeof m.id === 'string' && MEM_ID_RE.test(m.id) ? { id: m.id } : {}), k: m.memMark })); return '1'; }
	if (m.r2) return JSON.stringify(await r2op(m.r2));
	if (m.email) return JSON.stringify(await emailOp(m.email));
	if (m.aiAlt) return JSON.stringify(await aiAltOp(m.aiAlt));
	if (m.aiEmbed) return JSON.stringify(await aiEmbedOp(ENV && ENV.AI, m.aiEmbed));
	if (m.vectorize) return JSON.stringify(await vectorizeOp(ENV && ENV.SEARCH_INDEX, m.vectorize));
	if (m.turnstile) return JSON.stringify(await turnstileOp(m.turnstile));
	if (m.analytics) return JSON.stringify(analyticsOp(m.analytics));
	if (m.purgeZone) return JSON.stringify(await purgeZoneOp(m.purgeZone));
	if (m.browserRender) return JSON.stringify(await browserRenderOp(m.browserRender));
	if (m.cache === 'purge') {
		purgeRequested = true;
		return '{}';
	}
	if (dbHandler && (m.mysql !== undefined || m.mysql_b64 !== undefined)) {
		const t = Date.now();
		stats.calls++;
		if (m.mysql !== undefined) countTable(String(m.mysql));
		const reply = await dbHandler.query(ENV, m);
		stats.ms += Date.now() - t;
		const sql = String(m.mysql !== undefined ? m.mysql : '(binary SQL)');
		if (reply.ok) stats.log.push('ok  ' + sql.slice(0, 160).replace(/\s+/g, ' '));
		else {
			noteFailure({ sql: sql.slice(0, 400), error: reply.error });
			stats.log.push('ERR ' + sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + String(reply.error).slice(0, 120));
		}
		return JSON.stringify(reply);
	}
	if (m.report) {
		noteFailure({ sql: m.sql.slice(0, 400), error: m.error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + m.error.slice(0, 120));
		return '{}';
	}
	if (sqlDb) {
		const reply = sqlStatement(sqlDb, m);
		const out = JSON.stringify(reply);
		if (ledgerActive) {
			sqlMeter.add(out.length);
			// #394: the write that hits the isolate limit. One snapshot per request, before PHP goes on.
			if (reply && reply.ok === false && MEMORY_RESET.test(String(reply.error || '')) && !ledgerFailLogged) {
				ledgerFailLogged = true;
				ledgerLog('sql-memory-fail', { sql1: sqlShape(String(m.sql || '')) });
			}
		}
		return out;
	}
	// DB_IN_DO: the object's own SQLite is the only database; there is no D1 binding on a
	// b-dosql deploy. If a DB statement arrives with sqlDb unbound (null) we must NOT fall
	// through to ENV.DB below: ENV.DB is undefined there, so that path throws deep in the
	// driver and surfaces to the client as "Cannot escape data without an active database
	// connection" (issue #208). Fail loud and specific instead, so a future unbound path is
	// visible at once rather than masquerading as a connection fault.
	if ((m.sql !== undefined || m.mysql !== undefined || m.mysql_b64 !== undefined) && ENV && ENV.DB_IN_DO === 'on')
		return JSON.stringify({ ok: false, error: 'DB_IN_DO: object SQLite not bound (sqlDb is null) for this PHP execution' });
	const t = Date.now();
	stats.calls++;
	try {
		// A BLOB does not survive JSON. PHP sends a string that is not UTF-8 as
		// {"$b": base64}; bind it as bytes. D1 returns a BLOB as an array of
		// numbers or an ArrayBuffer; send it back to PHP as {"$b": base64}.
		// (Found 2026-11-05: Wordfence stores its settings in a BLOB column and
		// read them back as a PHP array, a fatal error on activation.)
		const params = (m.params || []).map((v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? b64decode(v.$b).buffer : v));
		const stmt = ENV.DB.prepare(m.sql).bind(...params);
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
		let reply;
		if (returnsRows) {
			const [columns, ...rows] = await stmt.raw({ columnNames: true });
			let blob = false;
			for (const row of rows)
				for (let i = 0; i < row.length; i++) {
					const v = row[i];
					if (v === null || typeof v !== 'object') continue;
					const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v);
					row[i] = { $b: b64encode(bytes) };
					blob = true;
				}
			reply = { ok: true, columns: columns || [], rows, changes: 0, last_row_id: 0, blob };
		} else {
			const r = await stmt.run();
			reply = { ok: true, columns: [], rows: [], changes: r.meta.changes || 0, last_row_id: r.meta.last_row_id || 0 };
		}
		stats.ms += Date.now() - t;
		stats.log.push('ok  ' + m.sql.slice(0, 160).replace(/\s+/g, ' '));
		return JSON.stringify(reply);
	} catch (e) {
		stats.ms += Date.now() - t;
		const error = String((e && e.message) || e);
		noteFailure({ sql: m.sql.slice(0, 400), error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + error.slice(0, 120));
		return JSON.stringify({ ok: false, error });
	}
}

async function boot(origin) {
	bootOrigin = origin;
	// The origin is WP_HOME for this runtime: log it, so a wrong one is visible.
	console.log(JSON.stringify({ m: 'boot', origin }));
	runtimeSerial++;
	runtimeServed = 0;
	runtimeBootAt = Date.now();
	const t0 = Date.now();
	const id = await loadPHPRuntime(loader, {
		// PHP_ENV (JSON) sets process environment for PHP, e.g. USE_ZEND_ALLOC.
		ENV: JSON.parse(ENV.PHP_ENV || '{"USE_ZEND_ALLOC":"0"}'),
		instantiateWasm(imports, done) {
			const inst = new WebAssembly.Instance(wasmModule, imports);
			bootMemory = inst.exports.memory || null; // #394: the ledger tracks this runtime's real memory
			done(inst, wasmModule);
			return inst.exports;
		},
		// #452: PHP's raw sockets (fsockopen, stream_socket_client) are refused: SOCKFS would turn them
		// into an outbound WebSocket that php-wasm cannot poll in workerd, and the documented contract
		// is that outbound traffic goes through the WordPress HTTP API and its host allowlist.
		websocket: { decorator: refuseSocketsDecorator((info) => console.log(JSON.stringify({ m: 'socket', refused: info }))) },
		// #563: only on an OPCACHE_REMOTE build. Without it the loader does not wrap open() at all.
		...(remoteOn() ? { pagefeatherOpen: remoteOpenHook } : {}),
	});
	const php = new PHP(id);
	lastBootedPhp = php;
	ledger.register(php, runtimeSerial, bootMemory); // #394: retired runtimes stay countable while alive, with their real memory
	bootMemory = null;
	// php.ini overrides. PHP_INI (a JSON object) lets a deploy or a test change them.
	// A deploy (WP_SALT is set) never prints PHP errors, even for a script that
	// does not load wp-config.php (measured 2026-11-04: /wp-content/db.php did).
	const deployIni = ENV.WP_SALT ? { display_errors: '0', display_startup_errors: '0' } : {};
	// OPcache. Measured 2026-11-04: it cached nothing until these were set.
	// - file_update_protection=0: OPcache skips a file changed in the last 2 s.
	//   Files are written at boot and the Worker clock barely moves, so every
	//   file looked new.
	// - validate_timestamps=0: scripts never change within a deploy, and the
	//   shipped file cache is older than the files unzipped at boot.
	// - shared memory for warm requests, the file cache (shipped by opcache.sh)
	//   for a cold isolate. Warm page locally: 220 ms -> 100 ms.
	// - memory_consumption 48 (#394), was 32. At 32 the shared memory was FULL on
	//   a WooCommerce store (2,584 bytes free, 776 scripts), so every warm request
	//   reloaded about 700 scripts from the file cache (21.3 MiB inflated). On the
	//   2,609-product sample store (pf394a, 2026-11-13, one run each, same build):
	//   32: 69 of 75 front GETs booted a new isolate, WASM 99 MiB, p50 about 4.4 s;
	//   48: 11 of 75, WASM 92 MiB, home and product p50 0.85 to 1.5 s;
	//   52: 42 of 75, WASM 98 MiB. WASM grows in steps, so the size is not a dial:
	//   locally 44 and 56 both landed at 104 MiB, over RECYCLE_WASM_BYTES. Change
	//   it only with measure394.py on the sample store; PHP_INI overrides it per site.
	// - blacklist /internal/eval.php (#294): php.run({ code }) writes its code to that ONE
	//   path on every call, so it is the one script that DOES change within a deploy. With
	//   validate_timestamps=0 OPcache kept the first compiled copy, and every later php.run
	//   ran it instead of its own code. opcache.sh then shipped it in opcache.zip, so on a
	//   deployed site every php.run (the install, the cron, an activation, /_mem) ran the
	//   priming run's last script: measured 2026-11-11, /_install answered an empty out and
	//   the shipped internal/eval.php.bin was runCron's code. This is also the cause of
	//   #185's "a reused runtime returns runCron's output in place of the activation".
	php.mkdir('/internal/shared');
	php.writeFile(OPCACHE_BLACKLIST, '/internal/eval.php\n');
	const opcacheIni = {
		'opcache.blacklist_filename': OPCACHE_BLACKLIST,
		'opcache.file_update_protection': '0',
		'opcache.validate_timestamps': '0',
		'opcache.file_cache_only': '0',
		'opcache.memory_consumption': '48',
		'opcache.interned_strings_buffer': '4',
		'opcache.max_accelerated_files': '4000',
	};
	await setPhpIniEntries(php, { ...INI_DEFAULTS, ...opcacheIni, ...deployIni, ...JSON.parse(ENV.PHP_INI || '{}') });
	const tWasm = Date.now() - t0;
	const mem = () => php[__private__dont__use].HEAPU8.length;
	const memAt = { start: mem() };

	// Files, without copying at boot (measured 2026-11-04: unzip and write cost
	// about 300 ms of a cold start locally, more on Cloudflare).
	// - site.zip (deflated): each PHP file is inflated on its first read only.
	//   A page reads about a quarter of them.
	// - opcache.zip: the same, or a view of the bundled bytes if stored.
	const FS = php[__private__dont__use].FS;
	const made = new Set();
	const mkdirp = (dir) => {
		if (made.has(dir)) return;
		php.mkdir(dir);
		made.add(dir);
	};
	let count = 0;
	let fileBytes = 0;
	if (ENV.LAZY_CACHE_MB) {
		const mb = Number(ENV.LAZY_CACHE_MB);
		if (Number.isFinite(mb)) LAZY_CACHE_BYTES = Math.max(1, mb) * 1024 * 1024; // a non-numeric value keeps the default, not NaN.
	}
	if (ENV.LAZY_NODES === 'on') {
		// Lazy MEMFS nodes (#218): mount the site tree by index; nodes are created
		// only when PHP first looks a path up, not ~6800 at boot. b-dosql default
		// off (the eager path below is unchanged) until this is proven for A.
		mountLazyZip(FS, '/', new Uint8Array(siteZip));
	} else {
		for (const e of zipEntries(new Uint8Array(siteZip))) {
			const full = '/' + e.name;
			if (e.name.endsWith('/')) {
				mkdirp(full.slice(0, -1));
				continue;
			}
			mkdirp(full.slice(0, full.lastIndexOf('/')));
			lazyFile(FS, full, e, 'site');
			count++;
			fileBytes += e.size;
		}
	}
	const tSite = Date.now() - t0 - tWasm;
	let opcacheFiles = 0;
	// #394 L1: the BOOT files of a split build, for this boot request only (dropped after it).
	bootPackPaths = null;
	l1State = OPCACHE_BOOT ? (ENV.OPCACHE_SPLIT === 'off' ? 'none:split-off' : 'none') : 'none:unsplit';
	if (OPCACHE_BOOT && ENV.OPCACHE_SPLIT !== 'off') {
		bootPackPaths = [];
		for (const pack of await loadBootPacks()) {
			for (const e of zipEntries(pack)) {
				if (e.name.endsWith('/')) continue;
				const full = OPCACHE_DIR + '/' + e.name;
				mkdirp(full.slice(0, full.lastIndexOf('/')));
				lazyFile(FS, full, e, 'opcache');
				bootPackPaths.push(full);
			}
		}
	}
	for (const e of zipEntries(new Uint8Array(opcacheZip))) {
		if (e.name.endsWith('/')) continue;
		const full = OPCACHE_DIR + '/' + e.name;
		mkdirp(full.slice(0, full.lastIndexOf('/')));
		if (e.method === 0) FS.writeFile(full, e.data(), { canOwn: true });
		else lazyFile(FS, full, e, 'opcache');
		opcacheFiles++;
	}
	// #563: the WARM OPcache files of an OPCACHE_REMOTE build, as remote nodes (opcache.zip is empty then).
	remotePacks = null;
	remoteState = OPCACHE_REMOTE ? 'none' : 'none:not-built';
	if (OPCACHE_REMOTE && ENV.OPCACHE_REMOTE === 'off') remoteState = 'off';
	else if (OPCACHE_REMOTE && !ENV.ASSETS) {
		// No pack can be fetched: the warm scripts compile from source (OPcache's normal path). Said loudly.
		remoteState = 'fallback:no-assets-binding';
		console.error(JSON.stringify({ m: 'remote', fallback: 'compile', why: 'no ASSETS binding' }));
	} else if (OPCACHE_REMOTE) {
		const capRaw = Number(ENV.REMOTE_FETCH_CAP);
		const cap = Number.isInteger(capRaw) && capRaw >= 0 && capRaw <= 1000 ? capRaw : REMOTE_FETCH_CAP;
		remotePacks = createRemotePacks({ index: OPCACHE_REMOTE, fetchPack: fetchRemotePack, parse: zipEntries, stats, cap, log: (o) => console.error(JSON.stringify(o)) });
		let n = 0;
		for (const [name, [, size]] of Object.entries(OPCACHE_REMOTE.files)) {
			const full = OPCACHE_DIR + '/' + name;
			mkdirp(full.slice(0, full.lastIndexOf('/')));
			remoteFile(FS, full, name, size);
			n++;
		}
		remoteState = `packs ${OPCACHE_REMOTE.packs.length} files ${n} cap ${cap}`;
	}
	const tFiles = Date.now() - t0 - tWasm;
	memAt.afterFiles = mem();

	// Keys from the WP_SALT secret, so a deployed site never uses the local ones.
	const lines = ['<?php'];
	if (ENV.WP_SALT) {
		for (const k of ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']) {
			const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ENV.WP_SALT + ':' + k));
			const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
			lines.push(`define('${k}', '${hex}');`);
		}
	}
	lines.push(`define('WP_HOME', ${JSON.stringify(origin)});`);
	// The R2 Uploads mu-plugin turns on when the MEDIA binding exists.
	if (ENV.MEDIA) lines.push(`define('R2_UPLOADS', true);`);
	// Image sizes come from the Images binding (php/cf-images-editor.php).
	if (ENV.MEDIA && ENV.IMAGES) lines.push(`define('CF_IMAGES', true);`);
	// A deploy (WP_SALT is set) shows no PHP errors or database errors to visitors.
	if (ENV.WP_SALT) lines.push(`define('WP_DEBUG', false);`);
	// A demo site or a one-click site cannot install, update or edit plugin or theme code (site-lock.mjs).
	lines.push(...lockDefines(ENV));
	// Outbound HTTP through fetch() (php/http-bridge.php, #26). HTTP_BRIDGE=off: no
	// bridge, and WordPress blocks external requests, as before the bridge.
	if (ENV.HTTP_BRIDGE === 'off') lines.push(`define('SKYPHUSION_HTTP_BRIDGE_OFF', true);`, `define('WP_HTTP_BLOCK_EXTERNAL', true);`);
	// Variant a on a strict MySQL (PlanetScale): the sql_mode each statement
	// carries (php/hyperdrive-sql-mode.php). Mode names and commas only.
	if (typeof ENV.HYPERDRIVE_SQL_MODE === 'string' && /^[A-Za-z_,]*$/.test(ENV.HYPERDRIVE_SQL_MODE))
		lines.push(`define('HYPERDRIVE_SQL_MODE', ${JSON.stringify(ENV.HYPERDRIVE_SQL_MODE)});`);
	// The object cache across requests (php/object-cache.php): only where one
	// object is the only writer. OBJECT_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off') lines.push(`define('JS_OBJECT_CACHE', true);`);
	// Approach A (external MySQL through Hyperdrive; dbHandler is set): the object
	// cache across requests lives in the Worker ISOLATE Map, and there are many
	// isolates each writing the shared MySQL, so a write in one isolate never purges
	// another isolate Map. OFF by default (OBJECT_CACHE=on turns it on, to measure),
	// and only an allowlist of cross-isolate-safe groups persists; everything else,
	// above all the WooCommerce correctness groups, stays per request. See issue #218
	// and docs/approach-a-objectcache.md.
	if (dbHandler && ENV.DB_IN_DO !== 'on' && ENV.OBJECT_CACHE === 'on') {
		lines.push("define('JS_OBJECT_CACHE', true);");
		// #491: options never persist on A (php/object-cache-js.php drops them even when named here). #494: terms is out of the default (a stale cross-isolate term).
		const ocPersist = (typeof ENV.OBJECT_CACHE_GROUPS === 'string' && ENV.OBJECT_CACHE_GROUPS) ? ENV.OBJECT_CACHE_GROUPS.replace(/[^A-Za-z0-9_,-]/g, '') : 'theme_json';
		lines.push("define('JS_OBJECT_CACHE_PERSIST_GROUPS', " + JSON.stringify(ocPersist) + ");");
		const ocTtl = Math.max(0, Math.min(3600, parseInt(ENV.OBJECT_CACHE_TTL, 10) || 10));
		lines.push("define('JS_OBJECT_CACHE_TTL', " + ocTtl + ");");
		if (ENV.THEME_JSON_CACHE !== 'off') lines.push("define('JS_THEME_JSON_CACHE', true);");
	}
	// Real SQL transactions (php/real-transactions.php, #60): the database in the
	// object only. REAL_TRANSACTIONS=off turns them off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.REAL_TRANSACTIONS !== 'off') lines.push(`define('JS_REAL_TRANSACTIONS', true);`);
	// The editor's theme REST routes kept across requests (php/rest-route-cache.php, #53).
	// Needs the object cache. ROUTE_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off' && ENV.ROUTE_CACHE !== 'off') lines.push(`define('JS_ROUTE_CACHE', true);`);
	// theme.json data kept across requests (php/theme-json-cache.php, #49). Needs the
	// object cache. THEME_JSON_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off' && ENV.THEME_JSON_CACHE !== 'off') lines.push(`define('JS_THEME_JSON_CACHE', true);`);
	// Async email mu-plugin (issue #185): wp_mail hands messages to the Worker. b-dosql only.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.ASYNC_EMAIL !== 'off') lines.push(`define('SKYPHUSION_ASYNC_EMAIL', true);`);
	// Bootstrap trim mu-plugin (perf): skip pure-background wc-admin features (remote-inbox,
	// marketing) that re-init every request. The trim is pure-background wc-admin and touches
	// no database engine specifics, so it is safe for approach A (external MySQL) too: with PHP
	// in a Durable Object there (dbHandler set, DB_IN_DO off), it reclaims the WASM-heap that a
	// Woo-warmed isolate otherwise spends re-initialising each request, headroom approach A needs
	// because its DB client sits in the same isolate as PHP (#218). BOOTSTRAP_TRIM=off turns it off.
	if (((ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on') || dbHandler) && ENV.BOOTSTRAP_TRIM !== 'off') lines.push(`define('SKYPHUSION_BOOTSTRAP_TRIM', true);`);
	// Media write trim mu-plugin (issue #189): free isolate memory on the rare admin
	// media-upload request so the attachment insert fits under the 128 MiB cap on a
	// WooCommerce-warmed b-dosql isolate. b-dosql + MEDIA only, and only the async-upload /
	// media-REST write path (php/media-write-trim.php). MEDIA_TRIM is the lever list;
	// MEDIA_TRIM=off turns it off. The value is sanitized to [a-z,] before it becomes a define.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.MEDIA && ENV.MEDIA_TRIM !== 'off') {
		const mediaTrimModes = (typeof ENV.MEDIA_TRIM === 'string' && ENV.MEDIA_TRIM ? ENV.MEDIA_TRIM : 'wcskip,cacheflush,gc').replace(/[^a-z,]/g, '');
		if (mediaTrimModes) lines.push(`define('SKYPHUSION_MEDIA_WRITE_TRIM', ${JSON.stringify(mediaTrimModes)});`);
	}
	// AI alt text mu-plugin (php/ai-alt-text.php): caption an uploaded image that
	// has no alt text with the Workers AI binding. b-dosql + MEDIA + the AI binding
	// only; AI_ALT=off turns it off. The model is AI_ALT_MODEL (default llava-hf).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.MEDIA && ENV.AI && ENV.AI_ALT !== 'off') lines.push(`define('SKYPHUSION_AI_ALT', true);`);
	// skyphusion-ai embeddings and Vectorize (issue #330). Both bindings, or
	// neither. The plugin reads SKYPHUSION_AI_CF_BRIDGE the way it reads
	// SKYPHUSION_AI_ALT. No gate var and no token: binding presence is the switch.
	if (cfBridgeEnabled(ENV)) lines.push(`define('SKYPHUSION_AI_CF_BRIDGE', true);`);
	// Zone cache purge-on-publish mu-plugin (php/zone-cache-purge.php, issue #205):
	// purge the Cloudflare ZONE edge cache (deploy/zone/) by URL when content
	// changes, through the scoped PURGE_TOKEN on the PURGE_ZONE zone. On only on the
	// DO profile with both bindings present; CACHE_PURGE=off turns it off. The token
	// stays in the Worker: PHP sends a purgeZone op and never sees it, as the AI
	// binding does for alt text.
	if (cachePurgeEnabled(ENV)) lines.push(`define('SKYPHUSION_CACHE_PURGE', true);`);
	// Browser Rendering PDF invoices mu-plugin (php/pdf-invoice.php, issue #227):
	// render a WooCommerce order to a PDF with the Browser Rendering binding, store it
	// in R2 and hand back a signed download URL. b-dosql + MEDIA + the BROWSER binding
	// only; PDF_INVOICE=off turns it off. The signing secret stays in the Worker, as the
	// AI binding does for alt text.
	if (pdfInvoiceEnabled(ENV)) lines.push(`define('SKYPHUSION_PDF_INVOICE', true);`);
	// Turnstile bot challenge on wp-login, comments and WooCommerce checkout
	// (php/turnstile-forms.php, issue #250). Binding based, so it needs no zone and
	// works on a workers.dev host. The site key is public (it ships in the page); the
	// secret (TURNSTILE_SECRET) stays in the Worker and PHP never sees it, as the AI
	// binding does for alt text. On only when both the secret and a valid public site
	// key are set; TURNSTILE=off is the master off switch, and TURNSTILE_LOGIN /
	// TURNSTILE_COMMENTS / TURNSTILE_WOO=off turn a single form off. The site key is
	// sanitized to a safe charset before it becomes a define.
	if (turnstileEnabled(ENV)) {
		const tsForms = turnstileForms(ENV);
		lines.push(`define('SKYPHUSION_TURNSTILE', true);`);
		lines.push(`define('SKYPHUSION_TURNSTILE_SITEKEY', ${JSON.stringify(sanitizeSiteKey(ENV.TURNSTILE_SITEKEY))});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_LOGIN', ${tsForms.login ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_COMMENTS', ${tsForms.comments ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_WOO', ${tsForms.woo ? 'true' : 'false'});`);
	}
	// Privacy-friendly pageview analytics mu-plugin (php/analytics-pageview.php,
	// issue #201 Phase 2): record one anonymized pageview per front-end request to
	// the Analytics Engine dataset binding. Binding based, so it needs no zone.
	// OPT-IN (a privacy implication): on only when PHP_IN_DO and DB_IN_DO are on,
	// the ANALYTICS binding is present, and WP_ANALYTICS is 'on' (the
	// analytics-engine descriptor sets it when the operator opts in). The dataset
	// binding stays in the Worker: PHP sends an analytics op and never sees it, as
	// the AI binding does for alt text.
	if (analyticsEnabled(ENV)) lines.push(`define('SKYPHUSION_ANALYTICS', true);`);
	php.writeFile(DOCROOT + '/wp-runtime.php', lines.join('\n') + '\n');

	php.onMessage(handleMessage);

	const handler = new PHPRequestHandler({
		php,
		documentRoot: DOCROOT,
		absoluteUrl: origin,
		cookieStore: false,
		getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
	});
	return { php, handler, bootMs: { wasm: tWasm, site: tSite, files: tFiles, fileCount: count, fileBytes, opcacheFiles, memAt } };
}

let reserveTableReady = false;

// Source from R2, transforms by the Images binding, result to R2 (if dest).
async function imageJob(B, job) {
	const o = await B.get(job.src);
	if (!o) throw new Error('source not found: ' + job.src);
	let h = ENV.IMAGES.input(o.body);
	for (const t of job.ops || []) h = h.transform(t);
	const out = await h.output({ format: job.format, ...(job.quality ? { quality: job.quality } : {}) });
	const bytes = new Uint8Array(await out.response().arrayBuffer());
	if (job.dest) await B.put(job.dest, bytes, { httpMetadata: { contentType: job.format } });
	return bytes;
}
// Set by the Edge Cache mu-plugin when content changes. Read after the request.
let purgeRequested = false;
let pendingEmails = [];
let lastOrigin = null;
// Workers Cache purges always have Free-tier limits: 5 a minute, bursts of 25,
// per account. Purge at most once per PURGE_GAP_MS per isolate; the short TTL
// with stale-while-revalidate limits staleness when a purge is refused.
const PURGE_GAP_MS = 15000;
// The object's purge state (issue #78): {pending, lastSent, retried}, in its storage.
const PURGE_STATE_KEY = 'skyphusion-purge';
const ORIGIN_KEY = 'skyphusion-origin';
const CRON_SKIP_KEY = 'cron-skip';
const CRON_CLEAN_KEY = 'cron-cleaned-at';
// The start of the last cron leg (#470, cron-bound.mjs cronLegDue).
const CRON_LAST_KEY = 'cron-last-start';
let lastPurge = 0;
// #510: dispose a JS RPC result once its fields are read. An RPC result can carry a disposer (and,
// over Cap'n Web, every object result does); left to the garbage collector it logs "An RPC result
// was not disposed properly" (wp-a-lean: 4 and 8 warns in the two load windows, 2026-11-14).
// A plain object with no disposer is left as it is. Never throws.
function disposeRpc(r) {
	try {
		if (r && typeof r[Symbol.dispose] === 'function') r[Symbol.dispose]();
	} catch {
		// a failed dispose never fails the purge
	}
}
function schedulePurge(ctx) {
	// A purge already scheduled for later covers this change too.
	const wait = Math.max(0, lastPurge + PURGE_GAP_MS - Date.now());
	const send = lastPurge <= Date.now();
	// One line per change and one per purge sent, so a run can count both (wrangler tail).
	console.log(JSON.stringify({ m: 'purge', asked: 1, coalesced: send ? 0 : 1, waitMs: send ? wait : 0 }));
	if (send) {
		lastPurge = Date.now() + wait;
		ctx.waitUntil(
			new Promise((ok) => setTimeout(ok, wait))
				.then(() => ctx.exports.Pages.purge(['wp-pages']))
				// A refused purge (Free limits: 5 a minute per account) is reported, not dropped.
				.then((r) => {
					console.log(JSON.stringify({ m: 'purge', sent: 1, ok: !!(r && r.ok), errors: (r && r.errors) || [] }));
					disposeRpc(r); // #510: after its fields are read
				})
				.catch((e) => console.log(JSON.stringify({ m: 'purge', sent: 1, ok: false, error: String(e).slice(0, 200) }))),
		);
	}
}

// Page cache (Workers Cache, issue #63). Only the Pages entrypoint is cached.
// The default entrypoint (the gateway, not cached) sends it a GET or HEAD that
// has no WordPress cookie (WP_COOKIE, by name) and is not an admin, login,
// cron or spike path, WITHOUT the Cookie header. So the cache key is the path
// and the query alone, and a cookie that is not WordPress's (analytics _ga,
// WooCommerce order attribution sbjs_*) does not split it. Before #63 the
// default entrypoint was cached with Vary: Cookie, keyed on the whole Cookie
// header: every visitor with any such cookie was a separate variant (measured
// on wp-perf-dosql, docs/approach-b.md 8c).
const WP_COOKIE = /(^|;\s*)(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|wp-settings-|woocommerce_|wp_woocommerce_session_)/;
const PAGE_CACHE_NO_PATH = /^\/(wp-admin|wp-login\.php|wp-json|wp-cron\.php|wp-comments-post\.php|cart|checkout|my-account|wc-api|skyphusion-invoice|_)/;
const PAGE_CACHE_NO_PARAM = ['rest_route', 'wc-ajax', 'add-to-cart', 'preview', 'nocache', 'customize_changeset_uuid', 'wc-api'];
function pageCacheRoute(req, url, env) {
	return (
		Number(env.PAGE_CACHE_TTL || 120) > 0 &&
		(req.method === 'GET' || req.method === 'HEAD') &&
		!WP_COOKIE.test(req.headers.get('cookie') || '') &&
		!req.headers.get('upgrade') &&
		!PAGE_CACHE_NO_PATH.test(url.pathname) &&
		!PAGE_CACHE_NO_PARAM.some((k) => url.searchParams.has(k)) &&
		!req.headers.has('authorization') &&
		// An operator request never goes to the cached entrypoint (perf-headers.mjs).
		!isOperatorRequest(req)
	);
}
function pageCacheHeaders(req, url, r, out, env) {
	const ttl = Number(env.PAGE_CACHE_TTL || 120);
	const wpCc = String([].concat(r.headers['cache-control'] || []).join(','));
	const cacheable =
		ttl > 0 &&
		(req.method === 'GET' || req.method === 'HEAD') &&
		[200, 301, 404].includes(r.httpStatusCode) &&
		!WP_COOKIE.test(req.headers.get('cookie') || '') &&
		!r.headers['set-cookie'] &&
		!/no-cache|no-store|private/i.test(wpCc) &&
		!PAGE_CACHE_NO_PATH.test(url.pathname) &&
		!PAGE_CACHE_NO_PARAM.some((k) => url.searchParams.has(k)) &&
		!req.headers.has('authorization');
	if (cacheable) {
		// The edge keeps it (cloudflare-cdn-cache-control, consumed by Cloudflare and
		// not sent on). The browser must ask again (no-cache): there is no Vary: Cookie
		// now, so a browser that kept the page would show the logged-out copy after a login.
		out.set('cloudflare-cdn-cache-control', `max-age=${ttl}, stale-while-revalidate=600`);
		out.set('cache-control', 'no-cache');
		out.set('cache-tag', 'wp-pages');
	} else {
		// Not stored at the edge, also when WordPress sent its own no-cache (which the
		// cache would store as stale).
		out.set('cloudflare-cdn-cache-control', 'no-store');
		if (!wpCc) out.set('cache-control', 'private, no-store');
	}
}

// One R2 operation for the R2 Uploads mu-plugin (php/r2-uploads.php).
// Bodies cross the PHP to JS bridge as base64.
async function r2op(op) {
	const t0 = Date.now();
	try {
		return await r2opInner(op);
	} finally {
		// Wall time advances during I/O, so these numbers are real.
		const ms = Date.now() - t0;
		stats.r2[op.op] = stats.r2[op.op] || { n: 0, ms: 0 };
		stats.r2[op.op].n++;
		stats.r2[op.op].ms += ms;
	}
}

async function r2opInner(op) {
	try {
		const B = ENV.MEDIA;
		if (op.op === 'get') {
			const o = await B.get(op.key, op.length ? { range: { offset: op.offset || 0, length: op.length } } : undefined);
			if (!o) return { ok: true, found: false };
			const bytes = new Uint8Array(await o.arrayBuffer());
			return { ok: true, found: true, body: b64encode(bytes), size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) };
		}
		if (op.op === 'head') {
			const o = await B.head(op.key);
			return o ? { ok: true, found: true, size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) } : { ok: true, found: false };
		}
		if (op.op === 'put') {
			await B.put(op.key, b64decode(op.body), { httpMetadata: { contentType: op.type || 'application/octet-stream' } });
			return { ok: true };
		}
		if (op.op === 'copy') {
			// Copy inside R2 (rename, staged uploads). The bytes never go to PHP.
			const o = await B.get(op.from);
			if (!o) return { ok: true, found: false };
			await B.put(op.to, o.body, { httpMetadata: { contentType: op.type || o.httpMetadata?.contentType || 'application/octet-stream' } });
			if (op.move) await B.delete(op.from);
			return { ok: true, found: true };
		}
		if (op.op === 'delete') {
			await B.delete(op.key);
			return { ok: true };
		}
		if (op.op === 'info') {
			const o = await B.get(op.key);
			if (!o) return { ok: true, found: false };
			const i = await ENV.IMAGES.info(o.body); // .info() is not billed
			return { ok: true, found: true, format: i.format, width: i.width, height: i.height, size: i.fileSize };
		}
		if (op.op === 'image') {
			const bytes = await imageJob(B, op);
			return { ok: true, size: bytes.length, ...(op.body ? { body: b64encode(bytes) } : {}) };
		}
		if (op.op === 'images') {
			// Several Images jobs in parallel (sub-sizes of one upload).
			const results = await Promise.allSettled((op.jobs || []).map((j) => imageJob(B, j)));
			const failed = results.filter((x) => x.status === 'rejected').map((x) => String(x.reason));
			return { ok: true, failed };
		}
		if (op.op === 'reserve' && sqlDb) {
			sqlDb.exec('CREATE TABLE IF NOT EXISTS _r2_reserved (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
			if (await B.head(op.key)) return { ok: true, reserved: false };
			return { ok: true, reserved: sqlChanges(sqlDb, () => sqlDb.exec('INSERT OR IGNORE INTO _r2_reserved (key, at) VALUES (?, ?)', op.key, Date.now())) === 1 };
		}
		if (op.op === 'reserve') {
			// Approach A has no D1: r2-uploads.php falls back to core's unique names.
			if (!ENV.DB) return { ok: false, error: 'unknown r2 op reserve' };
			// One atomic insert decides who gets a file name.
			if (!reserveTableReady) {
				await ENV.DB.prepare('CREATE TABLE IF NOT EXISTS _r2_reserved (key TEXT PRIMARY KEY, at INTEGER NOT NULL)').run();
				reserveTableReady = true;
			}
			if (await B.head(op.key)) return { ok: true, reserved: false };
			const r = await ENV.DB.prepare('INSERT OR IGNORE INTO _r2_reserved (key, at) VALUES (?, ?)').bind(op.key, Date.now()).run();
			return { ok: true, reserved: r.meta.changes === 1 };
		}
		if (op.op === 'list') {
			const l = await B.list({ prefix: op.prefix, delimiter: '/', limit: op.limit || 1000 });
			return { ok: true, keys: l.objects.map((o) => o.key), prefixes: l.delimitedPrefixes };
		}
		return { ok: false, error: 'unknown r2 op' };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}

function b64encode(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

function b64decode(str) {
	const s = atob(str);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

// GET and HEAD /wp-content/uploads/<path> come from R2, not PHP, with Range
// support (video seeking needs it). No PHP lock.
async function serveUpload(req, env, url) {
	let key;
	try {
		key = 'uploads/' + decodeURIComponent(url.pathname.slice('/wp-content/uploads/'.length));
	} catch {
		return new Response('bad path', { status: 400 });
	}
	// R2 keys are at most 1,024 bytes. A longer path cannot exist.
	if (new TextEncoder().encode(key).length > 1024) return new Response('not found', { status: 404 });
	let o;
	try {
		o = await env.MEDIA.get(key, { onlyIf: req.headers, range: req.headers });
	} catch {
		return new Response('bad range', { status: 416 });
	}
	if (o === null) return new Response('not found', { status: 404 });
	const h = new Headers();
	o.writeHttpMetadata(h);
	h.set('etag', o.httpEtag);
	// private: browsers keep it a day, the edge cache does not. A deleted upload
	// is then gone at once, with no purge. Purges are rate limited (5 a minute).
	h.set('cache-control', 'private, max-age=86400');
	h.set('accept-ranges', 'bytes');
	h.set('x-content-type-options', 'nosniff');
	if (!('body' in o) || !o.body) return new Response(null, { status: 304, headers: h });
	let status = 200;
	let length = o.size;
	if (o.range && req.headers.has('range')) {
		const offset = o.range.offset ?? (o.range.suffix !== undefined ? o.size - o.range.suffix : 0);
		length = o.range.length ?? (o.range.suffix !== undefined ? o.range.suffix : o.size - offset);
		h.set('content-range', `bytes ${offset}-${offset + length - 1}/${o.size}`);
		status = 206;
	}
	h.set('content-length', String(length));
	return new Response(req.method === 'HEAD' ? null : o.body, { status, headers: h });
}

// GET/HEAD /skyphusion-invoice?k=&e=&s= : a signed, expiring link to an order's invoice
// PDF (issue #227). verifyDownload checks the HMAC, the expiry and that the key is a
// well-formed invoices/ key, so a link cannot be edited to read another object or used
// after it expires. The secret never leaves the Worker.
async function serveInvoice(req, env, url) {
	const { key, exp, sig } = parseDownloadQuery(url.searchParams);
	const ok = await verifyDownload(env.INVOICE_TOKEN, key, exp, sig, Math.floor(Date.now() / 1000));
	if (!ok) return new Response('invalid or expired link', { status: 403 });
	let o;
	try {
		o = await env.MEDIA.get(key);
	} catch {
		return new Response('not found', { status: 404 });
	}
	if (!o) return new Response('not found', { status: 404 });
	const h = new Headers();
	o.writeHttpMetadata(h);
	if (!h.has('content-type')) h.set('content-type', 'application/pdf');
	h.set('etag', o.httpEtag);
	h.set('content-length', String(o.size));
	// An invoice is per customer: never let the edge cache keep it.
	h.set('cache-control', 'private, no-store');
	h.set('x-content-type-options', 'nosniff');
	h.set('content-disposition', 'inline; filename="invoice.pdf"');
	return new Response(req.method === 'HEAD' ? null : o.body, { status: 200, headers: h });
}


// Checkout Container (issue #20). WooCommerce needs 256 MB of PHP memory; an
// isolate has 128 MB for everything, and checkout passed it on Paid. The store
// and the cart stay in the Worker. The first item in the cart starts this
// container, so it is warm by the time the shopper checks out. It sleeps when
// idle. Its PHP reaches D1, R2 and Images through worker.internal, below.
export { ContainerProxy };
export class WooCheckout extends Container {
	defaultPort = 80;
	sleepAfter = '5m';
	enableInternet = false;
	// The health check. The default ("ping") requested "/", so every check was a
	// full WordPress page render with D1 calls; the checks filled the PHP workers
	// and the container never passed its start check (measured 2026-11-04: 524).
	// /ping is a static file.
	pingEndpoint = 'localhost/ping';
	constructor(ctx, env) {
		super(ctx, env);
		this.envVars = {
			WP_SALT: env.WP_SALT || '',
			R2_UPLOADS: env.MEDIA ? '1' : '',
			CF_IMAGES: env.MEDIA && env.IMAGES ? '1' : '',
		};
	}
}
WooCheckout.outboundByHost = {
	'worker.internal': async (request, env) => {
		ENV = env;
		const raw = await request.text();
		if (env.CONTAINER_TRACE) console.log('c>', raw.slice(0, 140));
		const reply = await handleMessage(raw);
		return new Response(reply, { headers: { 'content-type': 'application/json' } });
	},
};

const CHECKOUT_ROUTE = /^\/wc\/store(\/v1)?\/checkout\/?$/;
const ADD_TO_CART_ROUTE = /^\/wc\/store(\/v1)?\/cart\/add-item\/?$/;
function restRoute(url) {
	return url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
}
function isCheckout(url) {
	return CHECKOUT_ROUTE.test(restRoute(url)) || /^\/checkout\/?$/.test(url.pathname) || url.searchParams.get('pagename') === 'checkout';
}
// The instance name. Change CHECKOUT_INSTANCE to start a new instance on the
// current image (a running instance keeps its image).
function checkoutContainer(env) {
	return getContainer(env.WOO_CHECKOUT, env.CHECKOUT_INSTANCE || 'checkout');
}

// Spike: time N sequential D1 statements from where this code runs.
async function d1ping(req, env, url, ctx) {
	const n = Math.min(50, Number(url.searchParams.get('n') || 20));
	const ms = [];
	// Approach A: the same 20 reads through Hyperdrive (the first one opens the connection).
	let connectMs = null;
	for (let i = 0; i < n; i++) {
		const t = Date.now();
		if (dbHandler) {
			const r = await dbHandler.query(env, { mysql: "SELECT option_value FROM wp_options WHERE option_name = 'siteurl'" });
			if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
		} else await env.DB.prepare('SELECT option_value FROM wp_options WHERE option_name = ?').bind('siteurl').first();
		if (i === 0 && dbHandler) connectMs = Date.now() - t;
		else ms.push(Date.now() - t);
	}
	if (dbHandler) ctx.waitUntil(dbHandler.end());
	const n2 = ms.length;
	ms.sort((a, b) => a - b);
	return Response.json({ n: n2, first: connectMs, min: ms[0], median: ms[n2 >> 1], max: ms[n2 - 1], colo: req.cf && req.cf.colo });
}

// Outbound HTTP for PHP (php/http-bridge.php, issue #26). WordPress's wp_remote_*()
// requests come here and go out with fetch(). The design is WordPress
// Playground's; HostlessWP does the same (runtime/src/http.js).
// - timeout: one AbortSignal for the whole request, redirects included.
// - redirection: redirects are followed here, up to WordPress's count, so each
//   hop is checked like the first (loopback, allowlist). 303, and 301 or 302 on
//   a POST, become a GET without a body, as browsers do.
// - limit: the body is read up to WordPress's limit_response_size, and never
//   past HTTP_MAX_BYTES (default 8 MB): the answer crosses the bridge as base64.
// - HTTP_ALLOW_HOSTS (comma list; a host or ".suffix"): unset uses the default
//   (.wordpress.org, .woocommerce.com, .gravatar.com). Empty denies every host.
//   "*" allows every http(s) host.
// - A request to the site's own host is refused at once. The PHP object runs one
//   request at a time, so a request to itself waits behind itself (a timeout, or
//   "Durable Object is overloaded"). WordPress treats the error like any failed
//   request (Site Health's loopback check, the plugin editor's fatal check).
const HTTP_MAX_BYTES = 8 * 1024 * 1024;
function httpRefusal(url) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https';
	if (bootOrigin && url.hostname === new URL(bootOrigin).hostname) return 'a request to this site itself is refused: the PHP object runs one request at a time, so it would wait on itself';
	const raw = ENV && ENV.HTTP_ALLOW_HOSTS !== undefined ? ENV.HTTP_ALLOW_HOSTS : undefined;
	if (!httpHostAllowed(url.hostname, resolveHttpAllowHosts(raw))) return 'host not in HTTP_ALLOW_HOSTS: ' + url.hostname;
	return null;
}
async function httpOp(op) {
	stats.httpCalls++;
	const t0 = Date.now();
	let url;
	let out;
	try {
		url = new URL(op.url);
		const max = Number(ENV.HTTP_MAX_BYTES || HTTP_MAX_BYTES);
		const limit = op.limit > 0 ? Math.min(op.limit, max) : max;
		const timeoutMs = Math.max(1, Number(op.timeout) || 5) * 1000;
		const signal = AbortSignal.timeout(timeoutMs);
		let method = op.method || 'GET';
		let body = op.body ? b64decode(op.body) : undefined;
		const headers = new Headers(op.headers || {});
		let redirects = 0;
		let res;
		for (;;) {
			const why = httpRefusal(url);
			if (why) {
				out = { error: why };
				return out;
			}
			res = await fetch(url, { method, headers, body, redirect: 'manual', signal });
			const loc = res.headers.get('location');
			if ([301, 302, 303, 307, 308].includes(res.status) && loc && (op.redirection || 0) > 0) {
				// As Requests does: redirection 0 returns the redirect itself; past the count is an error.
				if (redirects >= op.redirection) {
					await res.body?.cancel().catch(() => {}); // discarding a body must not fail the request (it threw in the object)
					out = { error: 'Too many redirects' };
					return out;
				}
				await res.body?.cancel().catch(() => {}); // discarding a body must not fail the request (it threw in the object)
				url = new URL(loc, url);
				redirects++;
				if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
					method = 'GET';
					body = undefined;
					headers.delete('content-type');
					headers.delete('content-length');
				}
				continue;
			}
			break;
		}
		const chunks = [];
		let size = 0;
		let truncated = false;
		if (res.body && method !== 'HEAD') {
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const room = limit - size;
				if (value.length > room) {
					chunks.push(value.subarray(0, room));
					size += room;
					truncated = true;
					await reader.cancel().catch(() => {});
					break;
				}
				chunks.push(value);
				size += value.length;
			}
		}
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const c of chunks) {
			bytes.set(c, at);
			at += c.length;
		}
		const hdrs = [];
		for (const [k, v] of res.headers) if (k !== 'set-cookie') hdrs.push([k, v]);
		for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) hdrs.push(['set-cookie', c]);
		out = { status: res.status, statusText: res.statusText, headers: hdrs, body: b64encode(bytes), redirects, url: url.href, truncated };
		return out;
	} catch (e) {
		const name = e && e.name;
		out = { error: name === 'TimeoutError' || name === 'AbortError' ? `Operation timed out after ${Math.round(Number(op.timeout) * 1000) || 5000} milliseconds` : String((e && e.message) || e) };
		return out;
	} finally {
		stats.httpMs += Date.now() - t0;
		console.log(JSON.stringify({ m: 'http', host: url ? url.hostname : null, status: out && out.status, error: out && out.error ? String(out.error).slice(0, 120) : undefined, ms: Date.now() - t0 }));
	}
}

// Real SQL transactions for PHP with the database in the object (#60,
// php/real-transactions.php, docs/approach-b.md 8l). The object's SQL API
// refuses BEGIN and SAVEPOINT, and a storage transaction held open across
// awaits neither captures statements made outside its callback nor survives an
// outbound fetch (measured). So this uses SQLite's documented undo technique
// ("Automatic Undo/Redo Using SQLite"): while PHP has a transaction open,
// triggers write the inverse SQL of each row change to _wp_undo, and ROLLBACK
// runs it back, newest first. All writes stay ordinary statements, so awaits,
// uploads and outbound HTTP during a transaction are no problem.
// - Triggers exist per table (named by a hash of the table and its columns),
//   made at the first BEGIN and checked again only when the schema changes
//   (schemaSig). They do nothing unless _wp_undo_state.active is 1.
// - Tables WITHOUT ROWID are not covered (none in WordPress or the driver).
// - A transaction still open at the end of a request is rolled back (MySQL
//   does this when a connection closes). One left open by an isolate that
//   died is rolled back at the next request (active is stored).
// - Object cache keys written during the transaction are dropped on a
//   rollback, so no cached value outlives the rows it came from.
const UNDO_TABLES = new Set(['_wp_undo', '_wp_undo_state']);
// A signature of sqlite_master (entries and the length of their SQL): any DDL
// changes it. PRAGMA schema_version would be the direct way, but the object's
// SQLite refuses it (SQLITE_AUTH, measured 2026-11-06).
let undoSchemaSig = null;
function schemaSig(db) {
	const r = db.exec('SELECT COUNT(*) AS n, TOTAL(LENGTH(sql)) AS l FROM sqlite_master').one();
	return r.n + ':' + r.l;
}
let txnFrames = null; // [{ name, seq }]: the transaction (name null) and its savepoints
const txnTouched = new Set();
function sqlId(name) {
	return '"' + String(name).replace(/"/g, '""') + '"';
}
function sqlLit(text) {
	return "'" + String(text).replace(/'/g, "''") + "'";
}
function shortHash(text) {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, '0');
}
function undoSetup(db) {
	db.exec('CREATE TABLE IF NOT EXISTS _wp_undo (seq INTEGER PRIMARY KEY AUTOINCREMENT, sql TEXT NOT NULL)');
	db.exec('CREATE TABLE IF NOT EXISTS _wp_undo_state (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL)');
	db.exec('INSERT OR IGNORE INTO _wp_undo_state (id, active) VALUES (1, 0)');
}
function undoTriggers(db) {
	if (schemaSig(db) === undoSchemaSig) return;
	const tables = [...db.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").raw()].filter(([name, sql]) => !UNDO_TABLES.has(name) && !/WITHOUT\s+ROWID/i.test(sql || ''));
	const existing = new Set([...db.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_wp\\_undo\\_%' ESCAPE '\\'").raw()].map((r) => r[0]));
	const want = new Set();
	const when = 'WHEN (SELECT active FROM _wp_undo_state WHERE id = 1) = 1';
	for (const [table] of tables) {
		const cols = [...db.exec(`PRAGMA table_info(${sqlId(table)})`).raw()].map((r) => r[1]);
		if (!cols.length) continue;
		// The name hashes the whole trigger body, so a changed body (a new release, a new column) gets a new
		// name: the old trigger is dropped below and the new one is created. Never keep a trigger by table name alone.
		const t = sqlId(table);
		const bodies = {
			i: `AFTER INSERT ON ${t} ${when} BEGIN INSERT INTO _wp_undo (sql) VALUES (${sqlLit(`DELETE FROM ${t} WHERE rowid = `)} || new.rowid); END`,
			u: `AFTER UPDATE ON ${t} ${when} BEGIN INSERT INTO _wp_undo (sql) VALUES (${sqlLit(`UPDATE ${t} SET rowid = `)} || old.rowid || ${cols.map((c) => `${sqlLit(`, ${sqlId(c)} = `)} || quote(old.${sqlId(c)})`).join(' || ')} || ${sqlLit(' WHERE rowid = ')} || new.rowid); END`,
			d: `AFTER DELETE ON ${t} ${when} BEGIN INSERT INTO _wp_undo (sql) VALUES (${sqlLit(`INSERT INTO ${t} (rowid, ${cols.map(sqlId).join(', ')}) VALUES (`)} || old.rowid || ${cols.map((c) => `${sqlLit(', ')} || quote(old.${sqlId(c)})`).join(' || ')} || ')'); END`,
		};
		for (const [kind, body] of Object.entries(bodies)) {
			const name = `_wp_undo_${shortHash(table + '\u0000' + body)}_${kind}`;
			want.add(name);
			if (!existing.has(name)) db.exec(`CREATE TRIGGER ${name} ${body}`);
		}
	}
	for (const name of existing) if (!want.has(name)) db.exec(`DROP TRIGGER IF EXISTS ${sqlId(name)}`);
	undoSchemaSig = schemaSig(db);
}
function undoSeq(db) {
	return db.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM _wp_undo').one().s;
}
function setUndoActive(db, on) {
	db.exec('UPDATE _wp_undo_state SET active = ? WHERE id = 1', on ? 1 : 0);
}
// Undo every change after seq, newest first, in one storage transaction.
function undoTo(db, storage, seq) {
	setUndoActive(db, false);
	const rows = [...db.exec('SELECT sql FROM _wp_undo WHERE seq > ? ORDER BY seq DESC', seq).raw()];
	storage.transactionSync(() => {
		for (const [stmt] of rows) db.exec(stmt);
		db.exec('DELETE FROM _wp_undo WHERE seq > ?', seq);
	});
	stats.undoRows += rows.length;
	for (const k of txnTouched) objectCacheDrop(k);
	txnTouched.clear();
	return rows.length;
}
function txnClose(db) {
	setUndoActive(db, false);
	db.exec('DELETE FROM _wp_undo');
	txnFrames = null;
	txnTouched.clear();
}
function txnOp(db, storage, op) {
	stats.txnOps++;
	try {
		const kind = op.op;
		if (kind === 'begin') {
			if (txnFrames) txnClose(db); // MySQL commits an open transaction first
			undoSetup(db);
			undoTriggers(db);
			txnFrames = [{ name: null, seq: undoSeq(db) }];
			txnTouched.clear();
			setUndoActive(db, true);
			return { ok: true };
		}
		if (kind === 'commit' || kind === 'ddl') {
			if (txnFrames) txnClose(db); // DDL: MySQL's implicit commit
			return { ok: true };
		}
		if (kind === 'rollback') {
			if (!txnFrames) return { ok: true };
			const n = undoTo(db, storage, txnFrames[0].seq);
			txnClose(db);
			return { ok: true, undone: n };
		}
		if (!txnFrames) return { ok: true }; // a savepoint outside a transaction does nothing (MySQL autocommit)
		const at = txnFrames.findIndex((f, i) => i > 0 && f.name === op.name);
		if (kind === 'savepoint') {
			if (at > 0) txnFrames.splice(at, 1); // MySQL: the same name replaces the old savepoint
			txnFrames.push({ name: op.name, seq: undoSeq(db) });
			return { ok: true };
		}
		if (at < 0) return { ok: false, error: `SAVEPOINT ${op.name} does not exist` };
		if (kind === 'rollback_to') {
			const n = undoTo(db, storage, txnFrames[at].seq);
			txnFrames.length = at + 1; // the savepoint stays, later ones go
			setUndoActive(db, true);
			return { ok: true, undone: n };
		}
		if (kind === 'release') {
			txnFrames.length = at; // it and the later ones go; their changes stay in the transaction
			return { ok: true };
		}
		return { ok: false, error: 'unknown transaction op ' + kind };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}
// Before the first PHP run of an isolate: a transaction left open by an isolate
// that died is rolled back. Within one isolate, txnEnd() always closes it, so
// this runs once per isolate.
let txnRecovered = false;
function txnRecover(db, storage) {
	if (txnRecovered || txnFrames) return;
	txnRecovered = true;
	let active = 0;
	try {
		active = db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active;
	} catch {
		return; // no undo tables yet: no transaction was ever opened
	}
	if (active) {
		const n = undoTo(db, storage, 0);
		txnClose(db);
		console.log(JSON.stringify({ m: 'txn', recovered: true, undone: n }));
	}
}
// After a PHP run: a transaction still open is rolled back (MySQL on connection close).
function txnEnd(db, storage) {
	if (!txnFrames) return;
	const n = undoTo(db, storage, txnFrames[0].seq);
	txnClose(db);
	console.log(JSON.stringify({ m: 'txn', rolledBackAtEnd: true, undone: n }));
}

// Spike: time N statements on the object's SQLite (db=object) or on D1 (db=d1),
// from inside the object. A Worker's clock does not move during CPU work, so on
// Cloudflare the object numbers may read 0: read CPU time in wrangler tail.
async function dbping(env, url, sql) {
	const db = url.searchParams.get('db') || (sql ? 'object' : 'd1');
	const n = Math.min(5000, Number(url.searchParams.get('n') || 20));
	const q = "SELECT option_value FROM wp_options WHERE option_name = 'siteurl'";
	const t0 = Date.now();
	if (db === 'object') {
		if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
		for (let i = 0; i < n; i++) sql.exec(q).toArray();
	} else {
		if (!env.DB) return new Response('no DB binding', { status: 409 });
		for (let i = 0; i < n; i++) await env.DB.prepare(q).first();
	}
	const ms = Date.now() - t0;
	return Response.json({ db, n, totalMs: ms, perStatementMs: ms / n, databaseBytes: sql ? sql.databaseSize : null });
}

// PHP in a Durable Object (issue #28). The design is from HostlessWP
// (github.com/hostlesswp/hostlesswp, GPL-2.0-or-later, runtime/src/index.js,
// PhpRuntime and render()). On Workers Free a Worker request stops at about 2 s
// of CPU, less than a cold WordPress start. A Durable Object request may use
// 30 s. With PHP_IN_DO=on the Worker keeps static assets, R2 uploads and the
// page cache, and sends every request that needs PHP to this object. The object
// runs the same code as the Worker (handle, withPhp, handleMessage), with its
// own bindings (DB, MEDIA, IMAGES) from the same wrangler env.
// One statement on the object's SQLite, in the reply form of the D1 path
// (handleMessage). exec() is synchronous and returns a cursor. Differences from
// D1 handled here:
// - changes and last_row_id: D1 returns them in meta. Here they come from
//   changes() and last_insert_rowid(), read in the same synchronous turn.
//   total_changes() before and after tells if this statement changed rows, so
//   a statement that changes nothing reports 0, as D1 does.
// - A BLOB comes back as an ArrayBuffer; it goes to PHP as {"$b": base64}, and
//   {"$b"} parameters are bound as bytes, as on the D1 path.
// - Booleans are bound as 1 and 0.
// BEGIN, COMMIT and SAVEPOINT never reach here: d1-pdo.php answers them in PHP,
// as for D1 (sql.exec() refuses them).
function sqlChanges(db, run) {
	const before = db.exec('SELECT total_changes()').raw().next().value[0];
	run();
	const after = db.exec('SELECT total_changes()').raw().next().value[0];
	return after === before ? 0 : db.exec('SELECT changes()').raw().next().value[0];
}
function sqlParams(params) {
	return (params || []).map((v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? b64decode(v.$b).buffer : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}
function sqlRow(row) {
	let blob = false;
	for (let i = 0; i < row.length; i++) {
		const v = row[i];
		if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
			const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
			row[i] = { $b: b64encode(bytes) };
			blob = true;
		}
	}
	return blob;
}
function sqlStatement(db, m) {
	const t = Date.now();
	stats.calls++;
	try {
		const params = sqlParams(m.params);
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
		let reply;
		if (returnsRows) {
			const cur = db.exec(m.sql, ...params);
			const rows = [...cur.raw()];
			// Billed units (Durable Objects pricing): rows read and written.
			stats.rowsRead += cur.rowsRead;
			stats.rowsWritten += cur.rowsWritten;
			let blob = false;
			for (const row of rows) blob = sqlRow(row) || blob;
			reply = { ok: true, columns: cur.columnNames || [], rows, changes: 0, last_row_id: 0, blob };
		} else {
			let changes = 0;
			changes = sqlChanges(db, () => {
				const cur = db.exec(m.sql, ...params);
				cur.toArray();
				stats.rowsRead += cur.rowsRead;
				stats.rowsWritten += cur.rowsWritten;
			});
			const insert = changes > 0 && /^\s*(INSERT|REPLACE)\b/i.test(m.sql);
			reply = { ok: true, columns: [], rows: [], changes, last_row_id: insert ? db.exec('SELECT last_insert_rowid()').raw().next().value[0] : 0 };
		}
		stats.ms += Date.now() - t;
		stats.log.push('ok  ' + m.sql.slice(0, 160).replace(/\s+/g, ' '));
		return reply;
	} catch (e) {
		stats.ms += Date.now() - t;
		const error = String((e && e.message) || e);
		noteFailure({ sql: m.sql.slice(0, 400), error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + error.slice(0, 120));
		return { ok: false, error };
	}
}

// Move a site in or out (DB_IN_DO). The dump is JSON lines: {"sql"} for each
// table, then {"sql","params"} for each row, then {"sql"} for each index,
// trigger and view, then {"end":true,"rows":N}. A dump without the end line is
// incomplete. Tables of SQLite and of Cloudflare (sqlite_*, _cf_*) are left out.
// Source: the object's SQLite, or ?from=d1 for the DB binding (moving a B site
// from D1). It runs under the PHP lock, so no PHP request writes meanwhile.
const DUMP_PAGE = 500;
function quoteId(name) {
	return '"' + String(name).replace(/"/g, '""') + '"';
}
function dumpSource(env, from) {
	if (from === 'd1') {
		if (!env.DB) throw new Error('no DB binding');
		return async (sql, params = []) => {
			const [columns, ...rows] = await env.DB.prepare(sql).bind(...params).raw({ columnNames: true });
			for (const row of rows)
				for (let i = 0; i < row.length; i++) {
					const v = row[i];
					if (v !== null && typeof v === 'object') row[i] = v instanceof ArrayBuffer ? v : ArrayBuffer.isView(v) ? v : Uint8Array.from(v).buffer;
				}
			return { columns: columns || [], rows };
		};
	}
	return async (sql, params = []) => {
		const cur = sqlDb.exec(sql, ...params);
		const rows = [...cur.raw()];
		return { columns: cur.columnNames, rows };
	};
}
async function dumpTo(writer, env, from) {
	const enc = new TextEncoder();
	const line = (o) => writer.write(enc.encode(JSON.stringify(o) + '\n'));
	try {
		const q = dumpSource(env, from);
		// The undo log of real transactions (_wp_undo*: its tables and triggers) is not data:
		// the target makes its own on the first BEGIN (8l), so it is not in the dump.
		const master = await q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_wp\\_undo%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY rowid");
		const tables = master.rows.filter((r) => r[0] === 'table');
		for (const [, , sql] of tables) await line({ sql });
		let total = 0;
		for (const [, name] of tables) {
			for (let off = 0; ; off += DUMP_PAGE) {
				const page = await q(`SELECT * FROM ${quoteId(name)} LIMIT ? OFFSET ?`, [DUMP_PAGE, off]);
				const insert = `INSERT INTO ${quoteId(name)} (${page.columns.map(quoteId).join(', ')}) VALUES (${page.columns.map(() => '?').join(', ')})`;
				for (const row of page.rows) {
					sqlRow(row);
					await line({ sql: insert, params: row });
				}
				total += page.rows.length;
				if (page.rows.length < DUMP_PAGE) break;
			}
		}
		for (const [, , sql] of master.rows.filter((r) => r[0] !== 'table')) await line({ sql });
		await line({ end: true, rows: total });
	} catch (e) {
		await line({ error: String((e && e.message) || e) }).catch(() => {});
	}
	await writer.close().catch(() => {});
}
// Import a dump, or part of one, into the object's SQLite: all lines of one
// request in one transaction. A failing line rolls the request back.
// The object must hold no tables, unless replace is set: then every table,
// index, trigger and view (not sqlite_* or _cf_*) is dropped first, in the same
// transaction. Any PHP request to an empty object makes the SQLite driver
// create its own _wp_sqlite_* tables, so "empty" rarely stays true.
// append is for the second and later parts of one dump (dbmove.py): the tables
// of the first part exist, so the check and the drop are skipped. replace and
// append together are refused.
const USER_OBJECTS = "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql IS NOT NULL";
function importInto(db, storage, text, replace, append) {
	if (replace && append) throw new Error('replace=1 and append=1 together: replace is for the first part, append for the others');
	let n = 0;
	let end = null;
	storage.transactionSync(() => {
		const existing = append ? [] : [...db.exec(USER_OBJECTS).raw()];
		if (existing.length && !replace) throw new Error(existing.length + ' tables or indexes exist; import with replace=1 to drop them first');
		if (replace) for (const [type, name] of existing) if (type === 'table' || type === 'view') db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${quoteId(name)}`);
		for (const raw of text.split('\n')) {
			if (!raw.trim()) continue;
			const o = JSON.parse(raw);
			if (o.error) throw new Error('the dump has an error line: ' + o.error);
			if (o.end) {
				end = o;
				continue;
			}
			db.exec(o.sql, ...sqlParams(o.params)).toArray();
			n++;
		}
	});
	return { ok: true, statements: n, end };
}

// OPcache statistics of the runtime (php.run, not a WordPress request).
// opHits subtracts 1: this script's own compile counts as a hit or a miss.
async function opcacheStats(php) {
	try {
		const r = await php.run({ code: '<?php $s = function_exists("opcache_get_status") ? opcache_get_status(false) : false; echo json_encode($s ? array("hits" => $s["opcache_statistics"]["hits"], "misses" => $s["opcache_statistics"]["misses"], "cached" => $s["opcache_statistics"]["num_cached_scripts"], "full" => $s["cache_full"]) : null);' });
		return JSON.parse(r.text) || null;
	} catch {
		return null;
	}
}

// When the Worker sent the request (Date.now()). The object's inbox wait is its
// own Date.now() at the start of fetch minus this. With the database in the
// object, PHP never yields to the event loop (no I/O), so a second request
// cannot start until the first ends: that wait is before fetch, where no
// counter in the object can see it. On Cloudflare the two clocks are on two
// machines (skew of a few ms).
const SENT_HEADER = 'x-perf-sent';
// The visitor's origin, from the Worker. On Cloudflare the object got the URL
// as http://<host>:443/..., so WP_HOME was wrong and every logged-out page
// answered 301 to that URL (measured 2026-11-05, wp-do-free). The Worker
// always sets this header (a visitor's value is replaced), and only the
// Worker can reach the object, so the object can trust it.
const ORIGIN_HEADER = 'x-wp-public-origin';
export class PhpRuntime extends DurableObject {
	// Page cache purges for the whole site (issue #78). PHP runs in this one
	// object (PHP_DO_POOL=1), so every change of content passes here. The
	// Worker's PURGE_GAP_MS was per isolate: a burst of parallel writes reached
	// several isolates and each purged (measured on wp-perf-dosql: 20 purges in
	// 32 s). Here one alarm sends one purge for everything asked since the last
	// purge, at most one per PURGE_GAP_MS, as c1 does in its Store object. The
	// state is stored, so a purge asked for survives an evicted object. A
	// refused purge is tried once more one interval later. With a pool of more
	// than one object, each object coalesces on its own.
	async requestPurge() {
		const now = Date.now();
		const st = (await this.ctx.storage.get(PURGE_STATE_KEY)) || { lastSent: 0 };
		const coalesced = !!st.pending;
		let waitMs = 0;
		st.lastAsked = now; // so a test can check the last change is covered by a later purge
		st.pending = true;
		await this.ctx.storage.put(PURGE_STATE_KEY, st);
		if (!coalesced) {
			const at = Math.max(now, (st.lastSent || 0) + PURGE_GAP_MS);
			waitMs = at - now;
			await this.ctx.storage.setAlarm(at);
		}
		console.log(JSON.stringify({ m: 'purge', asked: 1, t: now, coalesced: coalesced ? 1 : 0, waitMs, where: 'object' }));
		return coalesced ? 'coalesced' : 'scheduled';
	}

	async alarm() {
		// The next tick is armed FIRST (#291, alarm-arm.mjs armBeforeRun): a run killed below (an
		// isolate reset) still leaves a future alarm. A purge retry sets a sooner one, which replaces it.
		await armBeforeRun(this.ctx.storage, Date.now(), Number((this.env && this.env.CRON_INTERVAL_MS) || 60000));
		// No error leaves alarm() (#291): a throw spends the platform retry budget, and an object that
		// used it up got no alarm at all afterwards. The error is stored for /_purgestate instead.
		try {
			await this.alarmRun();
		} catch (e) {
			const rec = await recordAlarmFatal(this.ctx.storage, e, Date.now());
			console.log(JSON.stringify({ m: 'alarm', fatal: rec.error, count: rec.count }));
		}
	}

	async alarmRun() {
		// Phase 2 (#185): run due background work (Action Scheduler + WP-Cron) off the request
		// path, so deferred WC order emails fire with no traffic. DISABLE_WP_CRON stays on; this
		// alarm is the only cron driver. One alarm also coalesces purges, below.
		try {
			// A hibernated DO wakes into a fresh isolate: the request-captured module globals
			// (lastOrigin, ENV) are gone and only ctx.storage survives, so an idle low-traffic site
			// would skip cron forever and its deferred WC order emails would never fire (#191). Use
			// this.env (always present on the DO) and SITE_ORIGIN (deploy.sh always emits it), with
			// the persisted origin as a fallback, and gate on the resolved values, not the globals.
			ENV = this.env;
			// A test seam (CRON_SIMULATE_COLD=1): a real Cloudflare alarm wakes a hibernated DO into a
			// fresh isolate where the module globals are gone, which no single persistent local isolate
			// reproduces. Nulling them here makes the local alarm take the same cold path, so the bind
			// below (issue #208) is exercised by tests/cron-cold.py. Off by default; prod never sets it.
			if (this.env.CRON_SIMULATE_COLD === '1') { sqlDb = null; sqlStorage = null; bootPromise = null; }
			const cronOrigin = lastOrigin || this.env.SITE_ORIGIN || (await this.ctx.storage.get(ORIGIN_KEY));
			// A database import in progress holds the cron off (import-hold.mjs): a cron run between two
			// import parts boots WordPress on a half-loaded database, in the same isolate, and the next
			// part ran out of memory (fdprobe1112a, 2026-11-12).
			const importHeld = cronHeld(await this.ctx.storage.get(IMPORT_HOLD_KEY), Date.now());
			if (importHeld) console.log(JSON.stringify({ m: 'cron', held: 'import' }));
			// A store move holds the cron for its copy (#479, move-hold.mjs).
			const moveHeld = cronHeld(await this.ctx.storage.get(MOVE_HOLD_KEY), Date.now());
			if (moveHeld) console.log(JSON.stringify({ m: 'cron', held: 'move' }));
			// A purge alarm (every PURGE_GAP_MS under writes) runs the cron leg only when the last one
			// started at least CRON_INTERVAL_MS ago (#470): the purge still goes out below either way.
			const lastCron = await this.ctx.storage.get(CRON_LAST_KEY);
			const legDue = cronLegDue(lastCron, Date.now(), Number(this.env.CRON_INTERVAL_MS || 60000));
			// A leg that keeps dying waits before it tries again (#471, cron-health.mjs): 2, 4, 8 ... min.
			const prevRun = await this.ctx.storage.get(CRON_RUN_KEY);
			const bo = cronBackoff(prevRun, Date.now());
			const cronGo = legDue && !bo.waitMs && !importHeld && !moveHeld && phpPending === 0 && Date.now() - lastSpikeEndAt > SPIKE_CRON_GRACE_MS && cronOrigin && this.env;
			// Why a tick skipped the cron, for /_purgestate cronSkip (#291: a skip was invisible).
			if (!cronGo) await this.ctx.storage.put(CRON_SKIP_KEY, { t: Date.now(), notDue: !legDue, sinceLastMs: lastCron ? Date.now() - Number(lastCron) : null, backoff: bo.waitMs ? { deaths: bo.deaths, waitMs: bo.waitMs } : null, importHeld, moveHeld, phpPending, sinceSpikeMs: Date.now() - lastSpikeEndAt, origin: !!cronOrigin });
			if (!legDue) console.log(JSON.stringify({ m: 'cron', skipped: 'not-due', sinceLastMs: Date.now() - Number(lastCron) }));
			else if (bo.waitMs) console.log(JSON.stringify({ m: 'cron', skipped: 'backoff', deaths: bo.deaths, waitMs: bo.waitMs, lastMark: (prevRun && prevRun.lastMark) || null, lastFatal: (prevRun && prevRun.lastFatal) || null }));
			if (cronGo) {
				// Stored BEFORE the run (#470): a run an isolate reset kills still counts as the last one.
				await this.ctx.storage.put(CRON_LAST_KEY, Date.now());
				// The run record (#471), synced before PHP runs, so a leg the isolate kills is counted.
				const runStart = cronRunStart(prevRun, Date.now());
				if (runStart.died) console.log(JSON.stringify({ m: 'cron', died: runStart.rec.deaths, lastMark: runStart.rec.prevMark, lastFatal: runStart.rec.prevFatal }));
				await this.ctx.storage.put(CRON_RUN_KEY, runStart.rec);
				if (typeof this.ctx.storage.sync === 'function') await this.ctx.storage.sync();
				// #394: the ledger at the start of a cron leg, when MEM_LEDGER=on (a cron leg has no operator header).
				ledgerActive = this.env.MEM_LEDGER === 'on'; ledgerId = null; ledgerFailLogged = false; sqlMeter.reset();
				ledgerInfl0 = { n: stats.inflates, b: stats.inflateBytes, r: stats.reinflates, ae: inflateArena ? inflateArena.counts.evicts : 0 };
				if (ledgerActive) ledgerLog('cron-start');
				const runStorage = this.ctx.storage;
				cronRunSink = async (patch) => {
					const cur = (await runStorage.get(CRON_RUN_KEY)) || {};
					await runStorage.put(CRON_RUN_KEY, { ...cur, ...patch });
				};
				// DB_IN_DO: bind the object's own SQLite as WordPress's database before the cron runtime
				// loads WP. The fetch path sets this per request (sqlDb = sql); the alarm runs on a woken
				// isolate where the module globals are gone, so without this sqlDb is null and every cron
				// DB query misses the object store. A b-dosql deploy has NO D1 binding, so handleMessage
				// then falls through to an undefined ENV.DB and the driver connect fatals with "Cannot
				// escape data without an active database connection" (the exact wrangler tail error). The
				// alarm/fetch race on wake is why it is intermittent, not constant (issue #208).
				const sql = this.env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
				sqlDb = sql;
				sqlStorage = sql ? this.ctx.storage : null;
				const realTxn = sql && this.env.REAL_TRANSACTIONS !== 'off';
				if (realTxn) txnRecover(sql, this.ctx.storage);
				let cr;
				let mail = null;
				try {
					const cleanDue = cronCleanDue(await this.ctx.storage.get(CRON_CLEAN_KEY), Date.now());
					mail = tickMailFor(this.env, this.ctx.storage);
					cr = await runCron(await (bootPromise ??= boot(cronOrigin)), cleanDue, mail);
					if (cr && cr.cleaned) await this.ctx.storage.put(CRON_CLEAN_KEY, Date.now());
					// Finished (#471): the death count resets. A throw above leaves it unfinished, so it counts.
					cronRunSink = null;
					await this.ctx.storage.put(CRON_RUN_KEY, cronRunDone(await this.ctx.storage.get(CRON_RUN_KEY), Date.now()));
				} finally {
					cronRunSink = null;
					// A cron run that left a transaction open is rolled back, as a request is (MySQL rolls
					// back on connection close); a throw is re-raised to the outer catch after this.
					if (realTxn && txnFrames) txnEnd(sql, this.ctx.storage);
				}
				// Send what runCron just enqueued (the deferred WC order mails). The request path drains
				// pendingEmails at the end of a request; the alarm is the ONLY drain when no request
				// follows (a low-traffic store), so without this the queued order emails sit in the
				// module global and are lost on the next isolate recycle (#185). AWAIT the sends, NOT
				// this.ctx.waitUntil: DurableObjectState.waitUntil does not keep work alive past the alarm
				// returning (CF docs: it exists mainly for API compatibility), so a send handed to it was
				// abandoned and never delivered on the real DO (box: drained but sent:0). Awaiting makes the
				// send part of the promise alarm() returns, which the runtime is guaranteed to wait on. The
				// wait is BOUNDED (SEND_TIMEOUT_MS): a stuck or throttled env.EMAIL.send must not hold the
				// alarm until the DO wall-clock kills it, which drops the whole cron record (#194); a send
				// still in flight at the bound finishes during the rest of the alarm, or the DO alarm retry
				// is the backstop.
				const drained = pendingEmails.length;
				const sp = sendPending(this.env);
				if (sp) await boundedWait(sp, SEND_TIMEOUT_MS);
				const cst = (await this.ctx.storage.get(PURGE_STATE_KEY)) || {};
				// queued = cumulative wp_mail messages enqueued; sent = cumulative actually delivered (now
				// current, since the alarm awaits the sends); drained = handed off this tick. The old single
				// 'emails' field counted ENQUEUES and read as delivery, which it was not (#185).
				// handedOff/held/lostWrites (#362): this tick's mail, handed off from inside the op, and the
				// writes it lost to a reset. A tick the reset kills writes no record; its email-handoff lines
				// in Workers Logs are the count.
				cst.cron = { t: Date.now(), ...cr, lastRan: cr.ran, drained, queued: (stats.email || 0), sent: (stats.emailSent || 0), ...mail.counts, lostWrites: mail.lostWritesSeen() };
				// One line per completed tick (#335): the backlog it left and the WP-Cron event it ran, so
				// the drain rate and WP-Cron starvation can be read from Workers Logs (/_purgestate keeps
				// only the last tick).
				console.log(JSON.stringify({ m: 'cron', done: 1, as_actions: cr.as_actions, as_pass: cr.as_pass, as_dates: cr.as_dates, as_hooks: cr.as_hooks, as_pending: cr.as_pending, as_due: cr.as_due, wp_cron_hooks: cr.wp_cron_hooks, wp_cron_skipped: cr.wp_cron_skipped, wp_cron_due: cr.wp_cron_due, mail: mail.counts, lostWrites: mail.lostWritesSeen() }));
				await this.ctx.storage.put(PURGE_STATE_KEY, cst);
				// The #370 dedupe markers expire after DEDUPE_TTL_MS (14 days by default: past any Action
				// Scheduler retry). Bounded: at most 128 a tick (the storage delete limit), so a big backlog cannot hold the alarm.
				await pruneDedupe(this.ctx.storage, Date.now(), Number(this.env.DEDUPE_TTL_MS || 14 * 86400000));
			}
		} catch (e) {
			// A thrown runCron (a transient boot failure, a runtime recycle, a 1101) leaves bootPromise
			// pointing at a failed boot; without this reset the next tick's `bootPromise ??=` reuses the
			// failure and every later tick throws too, so a low-traffic store's deferred order emails
			// never drain until a request reboots the runtime (#191). Reset so the next tick reboots fresh.
			bootPromise = null;
			cronRunSink = null; // #471: no cron leg is running any more
			console.log(JSON.stringify({ m: 'cron', error: String((e && e.message) || e).slice(0, 200) }));
			// Visible in /_purgestate too (#291): wrangler tail shows nothing for a dispatch script's alarm.
			const cst = (await this.ctx.storage.get(PURGE_STATE_KEY)) || {};
			cst.cron = { t: Date.now(), error: String((e && e.message) || e).slice(0, 300), stack: String((e && e.stack) || '').slice(0, 1200) };
			await this.ctx.storage.put(PURGE_STATE_KEY, cst);
		}
		const st = (await this.ctx.storage.get(PURGE_STATE_KEY)) || {};
		if (st.pending) {
		// Cleared before the purge: a change during the purge asks for the next one.
		st.pending = false;
		st.lastSent = Date.now();
		await this.ctx.storage.put(PURGE_STATE_KEY, st);
		let r;
		try {
			r = await this.ctx.exports.Pages.purge(['wp-pages']);
		} catch (e) {
			r = { ok: false, errors: [String((e && e.message) || e).slice(0, 200)] };
		}
		const ok = !!(r && r.ok);
		const sent = { t: st.lastSent, ok, errors: (r && r.errors) || [], error: (r && r.error) || null };
		disposeRpc(r); // #510: its fields are copied into sent
		console.log(JSON.stringify({ m: 'purge', sent: 1, ...sent, where: 'object' }));
		// The last 20 sends, for /_purgestate: wrangler tail does not show alarm runs.
		const logged = (await this.ctx.storage.get(PURGE_STATE_KEY)) || st;
		logged.sends = [...(logged.sends || []), sent].slice(-20);
		await this.ctx.storage.put(PURGE_STATE_KEY, logged);
		// Locally there is no cache API (r.error): nothing to retry. A refused purge is retried once.
		if (!ok && !(r && r.error) && !st.retried) {
			const again = (await this.ctx.storage.get(PURGE_STATE_KEY)) || st;
			again.retried = true;
			again.pending = true;
			await this.ctx.storage.put(PURGE_STATE_KEY, again);
			await this.ctx.storage.setAlarm(Date.now() + PURGE_GAP_MS);
		} else if (st.retried) {
			const done = (await this.ctx.storage.get(PURGE_STATE_KEY)) || st;
			done.retried = false;
			await this.ctx.storage.put(PURGE_STATE_KEY, done);
		}
		}
		// Keep the cron cadence unless the purge logic set a sooner retry alarm.
		await rearm(this.ctx.storage, Date.now(), Number((ENV && ENV.CRON_INTERVAL_MS) || 60000));
	}

	async fetch(raw) {
		const env = this.env;
		ENV = env;
		const objectUrl = new URL(raw.url);
		const origin = raw.headers.get(ORIGIN_HEADER);
		// Without it, the object does not guess an origin: a wrong one redirects every page.
		if (!origin) return new Response('missing ' + ORIGIN_HEADER, { status: 500 });
		const url = new URL(objectUrl.pathname + objectUrl.search, origin);
		// Only a real request arms/feeds the cron alarm. The deploy-time spike endpoints
		// (/_install, /_activate) run a long direct php.run that bypasses withPhp; arming the
		// alarm there let it fire runCron mid-activation and its php.run output replaced the
		// activation's (WooCommerce did not activate, #185). A real visitor (a page, an order)
		// arms it instead, which is when the deferred work actually needs to run.
		if (!url.pathname.startsWith('/_')) {
			lastOrigin = origin;
			await this.ctx.storage.put(ORIGIN_KEY, origin);
			// A STALE alarm (long past, its run never completed) counts as none (#291): otherwise it
			// blocks every later arm and the cron stops for good. alarm-arm.mjs.
			// A stale one is deleted, then set (rearm): a re-set alone was not delivered on ggc-test.
			const ra = await rearm(this.ctx.storage, Date.now(), Number((ENV && ENV.CRON_INTERVAL_MS) || 60000));
			if (ra.stale) console.log(JSON.stringify({ m: 'alarm', unstuck: true, was: ra.was }));
		}
		const inboxMs = raw.headers.get(SENT_HEADER) ? Date.now() - Number(raw.headers.get(SENT_HEADER)) : null;
		const req = new Request(raw);
		req.headers.delete(ORIGIN_HEADER);
		req.headers.delete(SENT_HEADER);
		// The front Worker's Turnstile answer (#351): kept for this request's PHP run, never shown to PHP.
		const turnstileHeader = takeResultHeader(req.headers);
		if (dbHandler) dbHandler.reset();
		// The Worker checked the spike token already. Checked again: the object
		// trusts nothing it did not check itself.
		// #394 L1: the OPcache boot packs live under /_pf/ in the static assets. They hold compiled PHP of
		// the site's code, so no request may read them; only the object fetches them, through the binding.
		if (url.pathname.startsWith('/_pf/')) return new Response('Not Found', { status: 404 });
		// The scheduled snapshot (#533, db-snapshot.mjs): its own key, SNAPSHOT_TOKEN, never SPIKE_TOKEN.
		// Checked here again, like the spike token: the object trusts nothing it did not check itself.
		if (url.pathname === SNAPSHOT_PATH) {
			const gate = snapshotGate(req, env);
			if (gate !== 'ok') return gateResponse(gate);
			const sql = env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
			if (!sql || !env.MEDIA) return Response.json({ ok: false, error: 'no-db-or-bucket' }, { status: 409 });
			const held = cronHeld(await this.ctx.storage.get(IMPORT_HOLD_KEY), Date.now());
			const r = await takeSnapshot({ dump: (w) => withPhp(() => ((sqlDb = sql), dumpTo(w, env, 'object'))), media: env.MEDIA, build: BUILD_ID, held });
			console.log('@event snapshot ' + JSON.stringify(r.body));
			return Response.json(r.body, { status: r.status, headers: { 'cache-control': 'private, no-store' } });
		}
		const spikeOk = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		// Spike: the URL the object got, and the origin it uses.
		if (url.pathname === '/_origin') return Response.json({ objectUrl: raw.url, publicOrigin: origin, used: url.href });
		// The purge state of this object (issue #78): pending, last sent, the last 20 sends, the next alarm.
		if (url.pathname === '/_purgestate') return Response.json({ ...((await this.ctx.storage.get(PURGE_STATE_KEY)) || {}), alarm: await this.ctx.storage.getAlarm(), alarmFatal: (await this.ctx.storage.get(ALARM_FATAL_KEY)) || null, cronSkip: (await this.ctx.storage.get(CRON_SKIP_KEY)) || null, cronRun: (await this.ctx.storage.get(CRON_RUN_KEY)) || null, now: Date.now() });
		// The build this OBJECT is running (issue #35 slice 5). After a re-upload a
		// warm object keeps the old code until it is evicted, so this reports the
		// object's version, which can lag the Worker's until /_evict or a sleep.
		if (url.pathname === '/_build') return Response.json({ build: BUILD_ID });
		// #394 headroom probe (HEADROOM_PROBE=on, off by default; a MEASUREMENT that ends this isolate, so
		// only on a throwaway). After a real request, this same isolate allocates held 1 MiB ArrayBuffers
		// until it dies, streaming the count (headroom.mjs). The first line is the ledger at that moment, so
		// 255 (a bare isolate, #394 floor probes) minus the reach minus its wasmMiB is what the runtime holds
		// outside the wasm heap. No PHP lock: it never runs PHP. gc reports whether a forced GC exists.
		if (url.pathname === '/_headroom') {
			if (env.HEADROOM_PROBE !== 'on') return new Response('Not Found', { status: 404 });
			const snap = ledgerSnapshot('headroom');
			const gcAvailable = typeof globalThis.gc === 'function';
			if (gcAvailable && url.searchParams.get('gc') === '1') globalThis.gc();
			// #394: counted as a PHP-pending holder while it runs, so the alarm's cron gate (cronGo needs
			// phpPending === 0) does not boot PHP in this isolate in the middle of the measurement.
			phpPending++;
			const { response, job } = headroomStream({ first: JSON.stringify({ m: 'headroom', build: BUILD_ID, gc: gcAvailable, ...snap }), max: url.searchParams.get('max') || 1024, every: 16, probe: () => headroomLedger() });
			this.ctx.waitUntil(job.finally(() => { phpPending--; }));
			return response;
		}
		// Reset this object so the next request boots the new code (issue #35
		// slice 5). ctx.abort() may not exist on an older compat date: then 501,
		// and the caller falls back to waiting for the idle sleep.
		if (url.pathname === '/_evict') {
			if (typeof this.ctx.abort !== 'function') return Response.json({ evicted: false, reason: 'ctx.abort is not available on this compatibility date', build: BUILD_ID }, { status: 501 });
			// Drop the PHP runtime too (#279). It lives in module scope (bootPromise), and abort()
			// resets the object, not the isolate: on fdprobe1112e (2026-11-12) the next request ran on
			// the same isolate and the same runtime (x-perf rt 1, rtServed counting on), so
			// plugin-memory.py never read a fresh runtime. Like /_activate, this is a restart on
			// purpose and is not counted in runtimeDrops.
			bootPromise = null;
			this.ctx.waitUntil(Promise.resolve().then(() => this.ctx.abort('evict for a new build (issue #35)')));
			return Response.json({ evicting: true, build: BUILD_ID });
		}
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		const ctx = { inObject: true, waitUntil: (p) => this.ctx.waitUntil(p), requestPurge: () => this.requestPurge() };
		if (url.pathname === '/_d1ping') return d1ping(req, env, url, ctx);
		// DB_IN_DO=on: WordPress's database is this object's SQLite (8j).
		const sql = env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
		if (url.pathname === '/_dbping') return dbping(env, url, sql);
		if (url.pathname === '/_dbexport' && req.method === 'GET') {
			const from = url.searchParams.get('from') === 'd1' ? 'd1' : 'object';
			if (from === 'object' && !sql) return new Response('DB_IN_DO is off', { status: 409 });
			const { readable, writable } = new TransformStream();
			this.ctx.waitUntil(withPhp(() => ((sqlDb = sql), dumpTo(writable.getWriter(), env, from))));
			return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'private, no-store' } });
		}
		if (url.pathname === '/_hold') return moveHoldRequest(this.ctx.storage, req.method, url);
		if (url.pathname === '/_mysqlexport' && req.method === 'GET') {
			// #479: a rows-only, paged export of one table (mysql-export.mjs). Raw sql.exec, no PHP
			// boot, read only; the caller proves it complete against ?stats=1 (COUNT and MAX(rowid)).
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			return exportRequest((q, ...b) => { const c = sql.exec(q, ...b); return { columns: c.columnNames, rows: [...c.raw()] }; }, url);
		}
		if (url.pathname === '/_dbcounts' && req.method === 'GET') {
			// Per-table row counts for the import self-verify (issue #165): bounded
			// (one COUNT(*) per table), so it completes for a large object where a
			// full /_dbexport does not. Raw sql.exec (no PHP boot), read before any
			// page view, so no undo-log tables are made; same data tables as dumpTo.
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			const all = [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw()].map((r) => r[0]);
			const names = all.filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_') && !n.startsWith('_wp_undo'));
			const rows = {};
			for (const name of names) rows[name] = Number(sql.exec(`SELECT COUNT(*) FROM ${quoteId(name)}`).raw().next().value[0]);
			return Response.json({ rows, databaseBytes: sql.databaseSize });
		}
		if (url.pathname === '/_dbimport' && req.method === 'POST') {
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			// Hold the cron off for the whole import (each part refreshes it; import-hold.mjs).
			await this.ctx.storage.put(IMPORT_HOLD_KEY, Date.now() + IMPORT_HOLD_MS);
			const text = await req.text();
			return withPhp(async () => {
				objectCacheClear(); // the database changes outside WordPress's cache
				try {
					const done = importInto(sql, this.ctx.storage, text, url.searchParams.get('replace') === '1', url.searchParams.get('append') === '1');
					// The pages in the page cache show the old database: the object purges them (issue #78).
					return Response.json({ ...done, databaseBytes: sql.databaseSize }, { headers: { 'x-cache-purge': await this.requestPurge() } });
				} catch (e) {
					return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 400 });
				}
			});
		}
		// Queue: requests ahead of this one in the PHP lock (a count), and the
		// wait for the lock (the clock moves at the I/O that ends each request).
		const tArrive = Date.now();
		const ahead = phpPending;
		const isSpikeLongOp = url.pathname === '/_install' || url.pathname === '/_activate';
		phpPending++;
		return withPhp(async () => {
			const waitMs = Date.now() - tArrive;
			sqlDb = sql;
			sqlStorage = sql ? this.ctx.storage : null;
			const realTxn = sql && env.REAL_TRANSACTIONS !== 'off';
			if (realTxn) txnRecover(sql, this.ctx.storage);
			// One PHP run at a time (withPhp), so one slot holds this run's answer.
			turnstileSlot.set(turnstileHeader);
			try {
				const res = await handle(req, env, url, spikeOk, maxBody, ctx);
				if (realTxn) txnEnd(sql, this.ctx.storage);
				try {
					// inMs: from the start of fetch to the response (object clock). The
					// Worker's object time minus inbox minus inMs is the wait to send the
					// response back, which the next request's PHP can block the same way.
					res.headers.set('x-perf-queue', JSON.stringify({ inboxMs, ahead, waitMs, inMs: Date.now() - tArrive }));
				} catch {}
				return res;
			} finally {
				turnstileSlot.clear();
				// A request that threw also ends its transaction (rolled back).
				if (realTxn && txnFrames) txnEnd(sql, this.ctx.storage);
				phpPending--;
				// Hold cron off briefly so an externally-armed alarm cannot run runCron in the
				// /_install -> /_activate gap, where /_activate would reuse the cron runtime (#185).
				if (isSpikeLongOp) lastSpikeEndAt = Date.now();
			}
		});
	}
}

// Which object serves a request. PHP_DO_POOL objects (default 1) share the
// load; each boots its own PHP. Spike endpoints (/_install, /_opcache-dump,
// /_last, /_mem) always go to php-0, so they see the runtime the tests used.
function phpObjectName(env, url) {
	// DB_IN_DO: the object IS the database, so there is one object.
	const pool = env.DB_IN_DO === 'on' ? 1 : Math.max(1, Math.floor(Number(env.PHP_DO_POOL || 1)));
	if (pool === 1 || url.pathname.startsWith('/_')) return 'php-0';
	return 'php-' + Math.floor(Math.random() * pool);
}

// Seconds a client waits after an overload 503. One object serves about 5
// uncached pages a second (docs/perf-dosql.md), so a full queue drains in
// seconds, not minutes.
const OVERLOAD_RETRY_AFTER_S = '5';

// Delete expired #370 dedupe markers, at most limit per call. Errors are logged, never thrown.
async function pruneDedupe(storage, now, ttlMs, limit = 128) {
	try {
		const old = [];
		for (const [k, t] of await storage.list({ prefix: DEDUPE_PREFIX, limit })) if (!(Number(t) > now - ttlMs)) old.push(k);
		if (old.length) await storage.delete(old);
		return old.length;
	} catch (e) {
		console.log(JSON.stringify({ m: 'email-dedupe', prune: 'failed', error: String((e && e.message) || e).slice(0, 120) }));
		return 0;
	}
}

async function runCron(booted, cleanDue = false, mail = null) {
		const { php } = booted;
		// A bounded tick (cron-bound.mjs, #291): our own claim/process loop, not the queue runner,
		// which grew the runtime past the 128 MiB isolate on a big store even for one action.
		const { actions, wpEvents } = cronBounds(ENV);
		return withPhp(async () => {
		// The tick's mail handoff (#362) is live only for this PHP run.
		tickMail = mail;
		let r;
		try {
		r = await php.run({ code: `<?php
			// #471: PHP's own fatal error, sent from a shutdown function (it runs after a fatal), and a
			// mark BEFORE each job, so a leg that dies says which job it was running.
			register_shutdown_function( function () {
				$e = error_get_last();
				if ( $e && in_array( $e['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR ), true ) && function_exists( 'post_message_to_js' ) ) {
					post_message_to_js( json_encode( array( 'cronFatal' => array( 'type' => (int) $e['type'], 'msg' => substr( (string) $e['message'], 0, 300 ), 'file' => substr( (string) $e['file'], 0, 160 ), 'line' => (int) $e['line'] ) ) ) );
				}
			} );
			$skyphusion_cron_mark = function ( $k, $hook, $id = 0 ) {
				if ( function_exists( 'post_message_to_js' ) ) { post_message_to_js( json_encode( array( 'cronMark' => array( 'k' => $k, 'hook' => substr( (string) $hook, 0, 120 ), 'id' => (int) $id ) ) ) ); }
			};
			require '/wordpress/wp-load.php';
			$ran = array(); $released = 0; $as_n = 0; $as_hooks = array(); $as_dates = array(); $cleaned = 0;
			if ( class_exists( 'ActionScheduler' ) || function_exists( 'as_next_scheduled_action' ) ) {
				// Stale-claim recovery (the DO memory-recycle class). This alarm is the only Action
				// Scheduler runner and runs serialized (withPhp + the phpPending gate), so any claim on
				// a PENDING action at the start of a run is an orphan: the run that staked it recycled
				// mid-batch (the 128 MB isolate recycle) after claiming a batch and running only part,
				// leaving the rest claimed-but-unrun so no later claim re-picks them (a lost order
				// email on a quiet store). A never-started pending action is safe to unclaim (attempts
				// 0, it never ran, no duplicate send); native reset only recovers after a 300s timeout.
				global $wpdb;
				$as_t = $wpdb->prefix . 'actionscheduler_actions';
				$as_c = $wpdb->prefix . 'actionscheduler_claims';
				$released = (int) $wpdb->query( "UPDATE {$as_t} SET claim_id = 0 WHERE claim_id != 0 AND status = 'pending'" );
				$wpdb->query( "DELETE FROM {$as_c} WHERE claim_id NOT IN ( SELECT DISTINCT claim_id FROM {$as_t} WHERE claim_id != 0 )" );
				$as_store = ActionScheduler::store(); $as_runner = ActionScheduler::runner();
				// Pass 1 (#357): the woocommerce-emails group (WooCommerce's deferred order emails), NEWEST
				// first. The claim is oldest first by scheduled date, and a store's backlog (2609 attribute
				// lookups and 900 old emails on the sample store) put a new order email about 3492 actions
				// back, about 85 h at the measured 41 actions an hour (fdprobe1112j, 2026-11-12). Newest first
				// so an imported store's old emails cannot block a new one either. The order filter is for
				// this one claim only. stake_claim throws when the group does not exist yet (no email ever
				// queued): that is an empty pass 1.
				$as_pass = 'emails'; $claim = null;
				$as_newest = function () { return 'ORDER BY priority ASC, scheduled_date_gmt DESC, action_id DESC'; };
				add_filter( 'action_scheduler_claim_actions_order_by', $as_newest );
				try { $claim = $as_store->stake_claim( ${actions}, null, array(), 'woocommerce-emails' ); } catch ( Throwable $as_e ) { $claim = null; }
				remove_filter( 'action_scheduler_claim_actions_order_by', $as_newest );
				// stake_claim STORES the group it was given (ActionScheduler_DBStore::claim_actions,
				// set_claim_filter) and a later claim with no group reuses it: pass 2 then claimed only
				// emails, so a tick with no email due ran nothing (fdprobe1112j, 19:43:57Z, 2613 due).
				if ( method_exists( $as_store, 'set_claim_filter' ) ) { $as_store->set_claim_filter( 'group', '' ); }
				// Pass 2, only when pass 1 claimed nothing: everything else, oldest first, as before.
				if ( ! $claim || ! count( $claim->get_actions() ) ) {
					if ( $claim ) { $as_store->release_claim( $claim ); }
					$as_pass = 'all';
					$claim = $as_store->stake_claim( ${actions} );
				}
				foreach ( $claim->get_actions() as $as_id ) {
					$as_a = $as_store->fetch_action( $as_id ); $as_h = $as_a ? $as_a->get_hook() : '?';
					$as_hooks[ $as_h ] = ( isset( $as_hooks[ $as_h ] ) ? $as_hooks[ $as_h ] : 0 ) + 1;
					// The claimed action's scheduled date (#357), so a tick shows WHICH email it sent: a new one or the backlog.
					$as_sd = ( $as_a && method_exists( $as_a, 'get_schedule' ) && $as_a->get_schedule() && method_exists( $as_a->get_schedule(), 'get_date' ) ) ? $as_a->get_schedule()->get_date() : null; $as_dates[] = $as_sd ? $as_sd->format( 'Y-m-d H:i:s' ) : '?';
					$skyphusion_cron_mark( 'as', $as_h, $as_id );
					$as_runner->process_action( $as_id, 'Skyphusion DO alarm' ); $as_n++;
					// Drop what the action loaded (orders, meta) from the in-request cache, as the queue
					// runner did per batch: without it memory grows with every action (#291).
					if ( function_exists( 'wp_cache_flush_runtime' ) ) { wp_cache_flush_runtime(); }
				}
				$as_store->release_claim( $claim );
				// The cleaner (timeouts, failures) on a tick with nothing to do, and at least every
				// CRON_CLEAN_MS on a busy store (cronCleanDue), so a long backlog cannot starve it.
				$cleaned = 0;
				if ( 0 === $as_n || ${cleanDue ? 1 : 0} ) { $as_cleaner = new ActionScheduler_QueueCleaner( $as_store ); $as_cleaner->reset_timeouts(); $as_cleaner->mark_failures(); $cleaned = 1; }
				$ran[] = 'action_scheduler';
			}
			// The WP-Cron leg never runs Action Scheduler's queue runner (#335). Action Scheduler
			// schedules action_scheduler_run_queue every minute, so it was nearly always the earliest
			// due event and took the tick's one WP-Cron slot. Its runner is the unbounded one #323
			// replaced: on the sample store it grew the heap from 99.4 to 119.3 MiB and reset the
			// isolate in 19 of 19 ticks (fdprobe1112g, 2026-11-12). The bounded loop above is the
			// only Action Scheduler runner. So the hook is removed (as /_activate does, #289), and a
			// due run_queue event is skipped when the slot is picked, so the slot goes to the next
			// due event: with the hook removed alone, run_queue still took the slot in 21 of 21 ticks
			// and no other WP-Cron event ran. It is not unscheduled: Action Scheduler would only
			// schedule it again at init.
			remove_all_actions( 'action_scheduler_run_queue' );
			${typeof ENV !== 'undefined' && ENV && ENV.CRON_TEST_FATAL === '1' ? "$skyphusion_cron_mark( 'wp', 'skyphusion_test_fatal' ); skyphusion_undefined_function_471();" : '// CRON_TEST_FATAL (#471): a local test seam, off'}
			$events = 0; $wp_hooks = array(); $skipped = array(); $crons = function_exists( '_get_cron_array' ) ? _get_cron_array() : array();
			// The due WP-Cron hooks other than run_queue, before the leg runs: a tick that runs none
			// while this is not empty would be starving them (#335).
			$wp_due = array(); if ( is_array( $crons ) ) { foreach ( $crons as $dts => $dhooks ) { if ( $dts > time() ) break; foreach ( (array) $dhooks as $dh => $devs ) { if ( 'action_scheduler_run_queue' !== $dh ) { $wp_due[ $dh ] = 1; } } } }
			if ( ${wpEvents} > 0 && is_array( $crons ) ) { $now = time(); foreach ( $crons as $ts => $hooks ) { if ( $ts > $now ) break;
				foreach ( (array) $hooks as $hook => $evs ) { if ( 'action_scheduler_run_queue' === $hook ) { $skipped[ $hook ] = 1; continue; } foreach ( (array) $evs as $ev ) { $wp_hooks[] = $hook;
					// Whether this event's unschedule (and reschedule) was SAVED (#362): a mail the event sends
					// is then its only send, so the Worker hands it off even after a reset (wp_cron 1); when it
					// was not saved the event runs again and the Worker holds the mail (wp_cron -1).
					$wp_ok = true;
					if ( ! empty( $ev['schedule'] ) ) { $wp_r = wp_reschedule_event( $ts, $ev['schedule'], $hook, $ev['args'], isset($ev['interval']) ? $ev['interval'] : 0 ); if ( false === $wp_r || ( function_exists( 'is_wp_error' ) && is_wp_error( $wp_r ) ) ) { $wp_ok = false; } }
					$wp_r = wp_unschedule_event( $ts, $hook, $ev['args'] ); if ( false === $wp_r || ( function_exists( 'is_wp_error' ) && is_wp_error( $wp_r ) ) ) { $wp_ok = false; }
					$GLOBALS['skyphusion_mail_wp_cron'] = $wp_ok ? 1 : -1;
					$skyphusion_cron_mark( 'wp', $hook );
					do_action_ref_array( $hook, $ev['args'] ); $GLOBALS['skyphusion_mail_wp_cron'] = 0; if ( function_exists( 'wp_cache_flush_runtime' ) ) { wp_cache_flush_runtime(); } if ( ++$events >= ${wpEvents} ) { break 3; }
				} } } }
			$as_list = array(); foreach ( $as_hooks as $k => $v ) { $as_list[] = $k . ':' . $v; }
			// The backlog after this tick (#335): what the bounded loop has left to drain.
			$as_pending = null; $as_due = null;
			if ( isset( $as_t ) ) {
				$as_pending = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$as_t} WHERE status = 'pending'" );
				$as_due = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$as_t} WHERE status = 'pending' AND scheduled_date_gmt <= '" . gmdate( 'Y-m-d H:i:s' ) . "'" );
			}
			echo json_encode( array( 'ran' => $ran, 'wp_cron_events' => $events, 'wp_cron_hooks' => implode( ',', $wp_hooks ), 'wp_cron_skipped' => implode( ',', array_keys( $skipped ) ), 'wp_cron_due' => implode( ',', array_keys( $wp_due ) ), 'released' => $released, 'as_actions' => $as_n, 'as_pass' => isset( $as_pass ) ? $as_pass : null, 'as_dates' => implode( ',', $as_dates ), 'as_hooks' => implode( ',', $as_list ), 'as_pending' => $as_pending, 'as_due' => $as_due, 'cleaned' => $cleaned ) );` });
		} finally {
			tickMail = null;
			evictLazy();
			if (remotePacks) remotePacks.endRequest(); // #563: held packs live for one request
			dropBootPack(php[__private__dont__use].FS); // #394 L1: a cron run that booted drops the boot files too
		}
		let out = {};
		try { out = JSON.parse(String(r.text).slice(String(r.text).lastIndexOf('{'))); } catch (e) { out = { parse: String(r.text).slice(-200) }; }
		return out;
		});
	}

// The front Worker verifies a gated POST before it reaches the object (#351, turnstile.mjs). It
// returns the header value for the object, or null when the request is not a gated form or carries
// no token (its PHP gate then fails closed on its own). The token and the secret are never logged.
async function preverifyTurnstile(req, env, url) {
	const route = turnstileRoute(env, req.method, url);
	if (!route) return null;
	const token = await readGatedToken(route, req.clone());
	if (!token) return { route, value: null, res: null };
	const t0 = Date.now();
	const res = await verifyToken(env.TURNSTILE_SECRET, token, req.headers.get('cf-connecting-ip') || '', {
		timeoutMs: turnstileTimeoutMs(env),
		expect: { hostname: siteHost(env.SITE_ORIGIN), action: TURNSTILE_ACTION },
	});
	console.log(JSON.stringify({ m: 'turnstile', where: 'front', route, success: res.success, codes: res.codes || [], error: res.error, tries: res.tries, ms: Date.now() - t0 }));
	return { route, value: encodeResult(res, token), res };
}

async function toPhpObject(req, env, url, ctx) {
	const name = phpObjectName(env, url);
	// Turnstile (#351): verified here, before the object, so the object never waits on siteverify.
	const pre = await preverifyTurnstile(req, env, url);
	// The hint applies only when the object is made. D1's primary is in the
	// Chicago area; "enam" is Eastern North America.
	let t0 = Date.now();
	// A GET or HEAD that dies in an object reset (memory #335, or storage #398) is sent once more
	// (object-error.mjs fetchWithMemoryRetry); each attempt makes its own stub and request.
	const res = await fetchWithMemoryRetry(
		() => {
			const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(name), env.PHP_LOCATION ? { locationHint: env.PHP_LOCATION } : undefined);
			const fwd = new Request(req);
			// Only this Worker sets the Turnstile answer: a copy from the client is always dropped.
			setResultHeader(fwd.headers, pre && pre.value);
			fwd.headers.set(ORIGIN_HEADER, siteOrigin(env, url));
			t0 = Date.now();
			fwd.headers.set(SENT_HEADER, String(t0));
			return stub.fetch(fwd);
		},
		req.method,
		(e) => console.log(JSON.stringify({ m: 'isolate-reset-retry', kind: classifyObjectError(e), path: url.pathname, ...memIdOf(req, env), error: String(e.message).slice(0, 200) })),
	);
	const retried = res.attempts > 1;
	if (res.error) {
		const e = res.error;
		const kind = res.kind;
		// The object runs one PHP request at a time. Past its queue limit the
		// runtime refuses with "Durable Object is overloaded" (measured
		// 2026-11-05: 27 of 400 at 100 clients, docs/perf-dosql.md). Uncaught,
		// that was an exception and a bare 503 with no body. Answer it: a 503
		// the client can act on, never stored by the page cache in front of the
		// Worker (a cached error would reach readers after the queue drains).
		// An isolate memory reset also comes with e.overloaded set; it gets its own
		// header, x-isolate-reset: memory, not x-overloaded (#335, object-error.mjs).
		// A storage reset (#398) is a reset too: x-isolate-reset: storage, the same retry and the same
		// write-loss answer. Other errors are thrown as before (fetchWithMemoryRetry rethrows them).
		const reset = isResetKind(kind);
		console.log(JSON.stringify({ m: reset ? 'isolate-reset' : 'overloaded', kind, path: url.pathname, retried, ...memIdOf(req, env), error: String(e.message).slice(0, 200) }));
		// A method that may have written (anything but GET or HEAD) and died in a reset: its earlier
		// writes may be saved (#350; #398 saw a page create and a delete saved), so no 503 "try
		// again" and never the dispatcher 502 (write-loss.mjs).
		if (objectErrorOutcome(kind, req.method) === 'write-loss') {
			console.log(JSON.stringify({ '@event': 'write-loss', m: 'write-loss', kind, method: req.method, path: url.pathname, failed: 'unknown', phase: 'request-killed' }));
			const wl = writeLossResponse('unknown', wantsJson(url.pathname, url.search, req.headers.get('accept')), kind);
			wl.headers['x-php-object'] = name;
			return new Response(wl.body, { status: wl.status, headers: wl.headers });
		}
		const headers = objectErrorHeaders(kind, name, OVERLOAD_RETRY_AFTER_S);
		if (retried) headers['x-isolate-retry'] = '1';
		return new Response(reset ? 'The site restarted. Please try again in a few seconds.\n' : 'The site is busy. Please try again in a few seconds.\n', {
			status: 503,
			headers,
		});
	}
	const r = res.r;
	const out = new Response(r.body, r);
	out.headers.set('x-php-object', name);
	// A Store API checkout refused because the verifier was unreachable: nothing was written, so
	// the client may retry (#351).
	const ra = retryAfterFor(pre && pre.route, pre && pre.res, out.status);
	if (ra) out.headers.set('retry-after', ra);
	// The answer came from the retry after a memory reset (#335): the instrument for the A/B.
	if (retried) out.headers.set('x-isolate-retry', '1');
	// Wall time from the Worker to the object and back, PHP time included.
	const objectMs = Date.now() - t0;
	out.headers.set('x-object-ms', String(objectMs));
	// Server-Timing (docs/perf-dosql.md): object = the Worker's own wall time
	// for the object (its clock moves at this I/O); the rest is from the object.
	try {
		const p = JSON.parse(out.headers.get('x-perf') || '{}');
		const q = JSON.parse(out.headers.get('x-perf-queue') || '{}');
		const t = [`object;dur=${objectMs}`];
		if (q.inboxMs !== undefined && q.inboxMs !== null) t.push(`inbox;dur=${q.inboxMs}`);
		if (q.waitMs !== undefined) t.push(`queue;dur=${q.waitMs};desc="ahead ${q.ahead}"`);
		if (q.inMs !== undefined && q.inboxMs !== undefined && q.inboxMs !== null) t.push(`in;dur=${q.inMs}`, `outbox;dur=${objectMs - q.inboxMs - q.inMs}`);
		if (p.bootWaitMs !== undefined) t.push(`boot;dur=${p.bootWaitMs};desc="boot ${p.boot}"`);
		if (p.phpMs !== undefined) t.push(`php;dur=${p.phpMs}`, `db;dur=${p.dbMs};desc="${p.dbN} statements"`);
		out.headers.set('server-timing', t.join(', '));
		out.headers.set('x-perf-worker', JSON.stringify({ colo: (req.cf && req.cf.colo) || null, iso: ISOLATE_ID }));
	} catch {}
	return out;
}

const INSTALL = `<?php
define( 'WP_INSTALLING', true );
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if ( is_blog_installed() ) { echo json_encode( array( 'installed' => 'already' ) ); exit; }
$pw = trim( (string) @file_get_contents( '/tmp/admin-password' ) );
@unlink( '/tmp/admin-password' );
if ( strlen( $pw ) < 12 ) { echo json_encode( array( 'installed' => false, 'error' => 'admin password missing or shorter than 12' ) ); exit; }
$admin_email = trim( (string) @file_get_contents( '/tmp/admin-email' ) );
@unlink( '/tmp/admin-email' );
// A test deploy keeps the placeholder admin@example.com, which the mail layer now
// drops as undeliverable so its New Order mail never bounces (#198); a real deploy
// sets ADMIN_EMAIL / x-admin-email to a deliverable address.
if ( $admin_email === '' || ! is_email( $admin_email ) ) { $admin_email = 'admin@example.com'; }
$r = wp_install( 'WordPress on D1', 'admin', $admin_email, false, '', $pw );
echo json_encode( array( 'installed' => true, 'user_id' => $r['user_id'] ) );
`;

const site = {
	// Every answer passes through here, so the performance headers leave only on a request that
	// may see them (perf-headers.mjs), whichever branch of serve() built the response.
	async fetch(req, env, ctx) {
		// Never store operator responses at the edge (perf-headers.mjs operatorNoStore).
		return operatorNoStore(scrubPerfHeaders(await this.serve(req, env, ctx), perfHeadersAllowed(req, env)), req);
	},
	async serve(req, env, ctx) {
		ENV = env;
		const url = new URL(req.url);
		if (url.pathname === '/_ping') return new Response('ok');
		// Approach A: a Worker request cannot use a connection another request opened.
		// Drop any left over (an /_install run, or a request that failed early).
		if (dbHandler) dbHandler.reset();
		// Spike endpoints need the SPIKE_TOKEN secret when it is set (always on a deploy).
		// #394 L1: the OPcache boot packs live under /_pf/ in the static assets. They hold compiled PHP of
		// the site's code, so no request may read them; only the object fetches them, through the binding.
		if (url.pathname.startsWith('/_pf/')) return new Response('Not Found', { status: 404 });
		// The scheduled snapshot (#533): the dispatcher's cron calls it with SNAPSHOT_TOKEN (db-snapshot.mjs),
		// so it is gated by that key, not by SPIKE_TOKEN, and goes to the object, which is the database.
		if (url.pathname === SNAPSHOT_PATH) {
			const gate = snapshotGate(req, env);
			if (gate !== 'ok') return gateResponse(gate);
			if (env.PHP_IN_DO !== 'on' || !env.PHP_RUNTIME) return Response.json({ ok: false, error: 'no-object' }, { status: 409 });
			return toPhpObject(req, env, url, ctx);
		}
		const spikeOk = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		if (env.MEDIA && (req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/wp-content/uploads/')) return serveUpload(req, env, url);
		// Signed invoice PDF download (issue #227). The Worker verifies the HMAC the
		// browserRender op minted and streams the PDF from R2; PHP never holds the secret.
		if (env.MEDIA && env.INVOICE_TOKEN && (req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/skyphusion-invoice') return serveInvoice(req, env, url);
		// Static files (build/public) never reach this code (#412). The asset router serves them
		// BEFORE the Worker runs, on a WfP site (measured on ggc.sh 2026-11-13, and the WfP static
		// assets page) and on every spike env and deploy.sh site alike. The Worker sees only a miss,
		// or a run_worker_first path (only /_pf/*, refused above). So a gateway asset lookup here
		// could only miss again; it was removed. The ASSETS binding exists only so the object can
		// fetch the OPcache boot packs (#394 L1): a WfP site has it only with OPCACHE_SPLIT=1.
		// XML-RPC lets one request try many passwords (system.multicall). Off unless XMLRPC=on.
		if (url.pathname === '/xmlrpc.php' && env.XMLRPC !== 'on') return new Response('XML-RPC is off', { status: 403 });
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		if (Number(req.headers.get('content-length') || 0) > maxBody) return new Response('request body too large', { status: 413 });
		// WordPress serves no WebSockets. PHP's socket layer opens them to the site
		// itself (during /_install, measured 2026-11-05), and such a request must
		// never reach PHP: it booted a runtime with a wrong origin. This holds for
		// every variant: in variant a (PHP in the Worker) such a request booted the
		// runtime right after /_install with the origin http://127.0.0.1:<port>,
		// while the site is http://localhost:<port>, so every page linked to
		// 127.0.0.1 (2026-11-06, tests/a2/opcache-diag.sh, issue #50).
		if (req.headers.get('upgrade')) {
			console.log(JSON.stringify({ m: 'ws-refused', host: req.headers.get('host'), path: url.pathname }));
			return new Response('WebSocket is not served', { status: 426 });
		}
		// Import a MySQL dump (issue #31): variant a only, where dbHandler is the
		// MySQL bridge (index-a.js). Every other variant gets the 404 of sql-import.js.
		if (url.pathname === '/_sqlimport') return sqlImport(req, env, url, env.PHP_IN_DO === 'on' ? null : dbHandler);
		// PHP in a Durable Object (PHP_IN_DO=on, issue #28): every request that
		// needs PHP goes to the object, including /_d1ping (D1 as PHP sees it).
		// DB_IN_DO needs the object; without it the Worker would use D1 silently.
		if (env.DB_IN_DO === 'on' && env.PHP_IN_DO !== 'on') return new Response('DB_IN_DO=on needs PHP_IN_DO=on', { status: 500 });
		// Without the binding, fail: a silent fallback would run PHP in the Worker.
		if (env.PHP_IN_DO === 'on') {
			return env.PHP_RUNTIME ? toPhpObject(req, env, url, ctx) : new Response('PHP_IN_DO=on needs the PHP_RUNTIME Durable Object binding', { status: 500 });
		}
		// Spike: time N sequential D1 statements from where this Worker runs.
		if (url.pathname === '/_d1ping') return d1ping(req, env, url, ctx);
		// Spike: stop the checkout Container, so the next request starts the current image.
		if (env.WOO_CHECKOUT && url.pathname === '/_container-stop') {
			const name = url.searchParams.get('name');
			await (name ? getContainer(env.WOO_CHECKOUT, name) : checkoutContainer(env)).stop();
			return new Response('stopped ' + (name || 'current'));
		}
		// Spike: reach the checkout Container on any path, e.g. /_container/_diag.php
		if (env.WOO_CHECKOUT && url.pathname.startsWith('/_container/')) {
			const inner = new URL(url.pathname.slice('/_container'.length) + url.search, url.origin);
			const r = await checkoutContainer(env).fetch(new Request(inner, req));
			const out = new Response(r.body, r);
			out.headers.set('cache-control', 'private, no-store');
			return out;
		}
		if (env.WOO_CHECKOUT && env.CHECKOUT_CONTAINER === 'on' && isCheckout(url)) {
			const r = await checkoutContainer(env).fetch(req);
			const out = new Response(r.body, r);
			out.headers.set('x-served-by', 'checkout-container');
			// Checkout is per shopper: never let the edge cache keep it.
			if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'private, no-store');
			return out;
		}
		return withPhp(() => handle(req, env, url, spikeOk, maxBody, ctx));
	},
};

// The cached entrypoint (wrangler.toml: exports.Pages.cache). It gets only what
// pageCacheRoute() lets through, with no Cookie header.
export class Pages extends WorkerEntrypoint {
	async fetch(req) {
		const r = await site.fetch(req, this.env, this.ctx);
		// So a test can see which entrypoint answered (the gateway sets nothing).
		const out = new Response(r.body, r);
		out.headers.set('x-entrypoint', 'pages');
		// An operator request (it carries the token header) may be answered with the performance
		// headers; never let the edge cache keep that copy for the next visitor. cache-control alone
		// was not enough: the edge obeys cloudflare-cdn-cache-control over it (perf-headers.mjs).
		if (isOperatorRequest(req)) noStoreAnywhere(out.headers);
		return out;
	}
	// An RPC method, so not cached. A purge reaches only the cache of the
	// entrypoint that calls it, so the purge of the page cache runs here.
	async purge(tags) {
		if (!this.ctx.cache) return { ok: false, error: 'no cache API' };
		const r = await this.ctx.cache.purge({ tags });
		return { ok: !!(r && r.success !== false), errors: (r && r.errors) || [] };
	}
}

// The gateway (not cached). A request that pageCacheRoute() accepts goes to
// Pages without its Cookie header; every other request runs here.
export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		if (pageCacheRoute(req, url, env)) {
			const h = new Headers(req.headers);
			h.delete('cookie');
			h.delete('authorization');
			return ctx.exports.Pages.fetch(new Request(req, { headers: h }));
		}
		return site.fetch(req, env, ctx);
	},
	async queue(batch, env, ctx) {
		return consumeEmailQueue(batch, env);
	},
};

async function handle(req, env, url, spikeOk, maxBody, ctx) {
	ocCtx = ctx; // for L2 (KV) object-cache write-through this request (#218)
	if (ocL2W) ocL2W.beginRequest(); // #500: the per-request PUT cap starts again
	{
		// A runtime serves only the origin it booted with (8i). The first request
		// after /_install used to boot the runtime for every later one, and that
		// request could be PHP's own socket connection back to the site: every
		// page then linked to (or answered 301 to) that request's origin. The
		// origin is now the configured site origin (siteOrigin, #33), so it does
		// not change; without SITE_ORIGIN a request for another origin boots a
		// new runtime, in the Worker as in the object.
		const origin = siteOrigin(env, url);
		if (bootPromise && bootOrigin !== origin) {
			runtimeDrops++;
			bootPromise = null;
		}
		// A deploy-time spike long-op boots a FRESH runtime so it never inherits one the cron alarm
		// just used: runCron and the install/activate share one PHP runtime, and a reused runtime
		// returns runCron's output (or aborts) in place of the activation (#185). This runs inside
		// the per-object PHP lock, so any cron run it isolates from has already finished.
		if (url.pathname === '/_install' || url.pathname === '/_activate') bootPromise = null;
		if (url.pathname === '/_last') return Response.json(globalThis.__lastRequest || {});
		if (url.pathname === '/_peak') {
			bootPromise ??= boot(origin);
			const { php } = await bootPromise;
			const r = await php.run({ code: `<?php
				$a = memory_get_peak_usage(false); $b = memory_get_peak_usage(true);
				register_shutdown_function(function () use ($a, $b) { while (ob_get_level()) ob_end_clean(); echo 'PEAK' . json_encode(array('before' => array($a, $b), 'peak' => memory_get_peak_usage(false), 'peak_real' => memory_get_peak_usage(true), 'limit' => ini_get('memory_limit'), 'files' => count(get_included_files()))); });
				define('WP_USE_THEMES', true);
				ob_start(); require '/wordpress/wp-blog-header.php';` });
			return new Response(r.text.slice(r.text.indexOf('PEAK')));
		}
		if (url.pathname === '/_runcron') {
			// Run due background work off the request path (issue #185, Phase 2). WP-Cron is
			// disabled (DISABLE_WP_CRON), so nothing runs it otherwise; the DO alarm calls the
			// same runCron() on a cadence. Runs the Action Scheduler queue (the deferred WC
			// order emails) and due WP-Cron events. Spike/manual trigger and the test seam.
			bootPromise ??= boot(origin);
			const mail = tickMailFor(env, sqlStorage);
			const r = await runCron(await bootPromise, false, mail);
			// Drain + SEND here too (a manual run), awaiting delivery so the response reports actual
			// sends, not enqueues (#185). The alarm uses waitUntil; a manual trigger awaits the signal.
			const drained = pendingEmails.length;
			const sp = sendPending(env);
			// Bound the drain the same way the alarm does (#198): a manual /_runcron must
			// not hang on a send env.EMAIL.send will not promptly answer. sendBounded flags
			// a send still in flight at the bound; the next alarm tick (and #190's Queue)
			// re-drives it.
			let sent = 0;
			let sendBounded = false;
			if (sp) {
				const res = await boundedWait(sp, SEND_TIMEOUT_MS);
				if (res === TIMED_OUT) sendBounded = true;
				else sent = res;
			}
			return new Response(JSON.stringify({ ...r, drained, sent, mail: mail.counts, lostWrites: mail.lostWritesSeen(), ...(sendBounded ? { sendBounded: true } : {}) }), { headers: { 'content-type': 'application/json' } });
		}
		if (url.pathname === '/_activate') {
			// Activate a plugin, e.g. ?plugin=woocommerce/woocommerce.php. Spike only.
			bootPromise ??= boot(origin);
			const { php } = await bootPromise;
			const plugin = url.searchParams.get('plugin') || '';
			// Underscores are allowed (#279: All in One SEO is all-in-one-seo-pack/all_in_one_seo_pack.php).
			// No dot, quote or second slash: the value is interpolated into the PHP below.
			if (!/^[a-z0-9_-]+\/[a-z0-9_-]+\.php$/.test(plugin)) return new Response('bad plugin', { status: 400 });
			const start = stats.calls;
			let r;
			try {
				r = await php.run({ code: `<?php
					define( 'WP_ADMIN', true );
					// A deploy-time activation never runs the store's queued work (#289). In an admin load,
					// Action Scheduler starts its async queue runner, and on a store with pending actions
					// that ran one inside this request; its failure (an uncaught InvalidArgumentException
					// from mark_failure) ended the request before the activation was saved. The filter is
					// pre-seeded in $wp_filter (WP_Hook::build_preinitialized_hooks), because Action
					// Scheduler reads it while wp-load runs, before any add_filter here could. The cron
					// alarm stays the one runner of that queue.
					$GLOBALS['wp_filter']['action_scheduler_allow_async_request_runner'][999]['skyphusion_activate_no_queue'] = array( 'function' => '__return_false', 'accepted_args' => 1 );
					require '/wordpress/wp-load.php';
					remove_all_actions( 'action_scheduler_run_queue' );
					require_once ABSPATH . 'wp-admin/includes/plugin.php';
					wp_set_current_user( 1 );
					// Deploy-time activation race (#35): seed WooCommerce's own attribute-taxonomies transient so
					// its admin init (wc_get_attribute_taxonomies) does not read wp_woocommerce_attribute_taxonomies
					// before the activation creates it. A cold just-deployed isolate hits this read-before-create
					// window and logs "no such table"; a warm activate does not, because the table already exists.
					// wc_get_attribute_taxonomies() checks this transient before the DB, and there are no attributes
					// at activation, so an empty seed is correct; WC_Install then creates the table and normal cache
					// invalidation takes over.
					if ( '${plugin}' === 'woocommerce/woocommerce.php' ) { set_transient( 'wc_attribute_taxonomies', array() ); }
					// The result is printed from a shutdown function, so it is printed also when a plugin
					// ends the request itself (#289): Slim SEO's activated_plugin hook redirects to its
					// settings page and calls die AFTER the activation is saved, and /_activate answered an
					// empty out for an activation that had worked (sample store, 2026-11-12). exited is true
					// when the run did not reach the end of this script.
					$GLOBALS['skyphusion_act'] = array( 'r' => null, 'done' => false );
					register_shutdown_function( function () {
						global $wpdb;
						$a = $GLOBALS['skyphusion_act']; $r = $a['r'];
						echo json_encode( array( 'active' => is_plugin_active( '${plugin}' ), 'error' => is_wp_error( $r ) ? $r->get_error_message() : null, 'exited' => ! $a['done'], 'db_error' => $wpdb->last_error ? $wpdb->last_error : null, 'queue_runs' => did_action( 'action_scheduler_run_queue' ) ) );
					} );
					$r = activate_plugin( '${plugin}' );
					$GLOBALS['skyphusion_act']['r'] = $r;
					// WooCommerce sends the first admin visit to its setup wizard (a 302 on /wp-admin/). A deploy has no use for it.
					delete_transient( '_wc_activation_redirect' );
					// WooCommerce makes its order tables (HPOS) on the first admin page view. dbDelta
					// first runs DESCRIBE on each missing table, which is an error by design. Make them
					// here, so that one-time step is part of the activation and not of a visitor's page.
					if ( function_exists( 'wc_get_container' ) && class_exists( 'Automattic\\\\WooCommerce\\\\Internal\\\\DataStores\\\\Orders\\\\DataSynchronizer' ) ) {
						$sync = wc_get_container()->get( 'Automattic\\\\WooCommerce\\\\Internal\\\\DataStores\\\\Orders\\\\DataSynchronizer' );
						if ( ! $sync->check_orders_table_exists() ) $sync->create_database_tables();
					}
					// db_error (the last database error of this run) and queue_runs (did Action Scheduler run
					// its queue in this request) are printed by the shutdown function above (#289).
					$GLOBALS['skyphusion_act']['done'] = true;` });
			} catch (e) {
				bootPromise = null;
				return new Response('activate failed: ' + String((e && e.message) || e), { status: 500 });
			}
			bootPromise = null; // a fresh runtime loads the plugin cleanly
			return new Response(JSON.stringify({ out: r.text.slice(-2000), errors: String(r.errors).slice(0, 2000), d1: stats.calls - start }), { headers: { 'content-type': 'application/json' } });
		}
		if (url.pathname === '/_opcache-dump') {
			// Zip of the OPcache file cache, for opcache.sh. Run it after the e2e
			// requests, so it holds the scripts real pages use.
			// x-isolate and x-runtime-drops: opcache.sh needs the isolate it started with
			// and 0 drops, so one runtime compiled everything the pages used.
			const dumpHeaders = { 'x-isolate': ISOLATE_ID, 'x-runtime-drops': String(runtimeDrops), 'x-runtimes': String(runtimeSerial) };
			if (!bootPromise) return new Response('not booted', { status: 409, headers: dumpHeaders });
			const { php } = await bootPromise;
			const files = {};
			const walk = (dir) => {
				for (const name of php.listFiles(dir)) {
					const p = dir + '/' + name;
					if (php.isDir(p)) walk(p);
					else if (!p.endsWith('/wordpress/wp-runtime.php.bin')) files[p.slice(OPCACHE_DIR.length + 1)] = php.readFileAsBuffer(p);
				}
			};
			walk(OPCACHE_DIR);
			const { zipSync } = await import('fflate');
			// Deflated: with WooCommerce, a stored zip passes the 64 MiB Worker size
			// limit. The Worker inflates each file on its first read only.
			return new Response(zipSync(files, { level: 6 }), { headers: { 'content-type': 'application/zip', 'x-files': String(Object.keys(files).length), ...dumpHeaders } });
		}
		if (url.pathname === '/_trace') {
			// The file reads recorded since the last call (FILE_TRACE=on, #394 M0), then cleared.
			return Response.json({ on: tracing(), ...fileTrace.drain() });
		}
		if (url.pathname === '/_mem') {
			if (!bootPromise) return Response.json({ booted: false });
			const { php, bootMs } = await bootPromise;
			const r = await php.run({ code: '<?php echo json_encode(array("opcache" => ini_get("opcache.enable"), "mc" => ini_get("opcache.memory_consumption"), "fco" => ini_get("opcache.file_cache_only"), "cached" => function_exists("opcache_get_status") && ($st = opcache_get_status(false)) ? $st["opcache_statistics"]["num_cached_scripts"] : null, "mem" => isset($st["memory_usage"]) ? $st["memory_usage"] : null));' });
			return Response.json({ bootMs, wasmMemoryBytes: php[__private__dont__use].HEAPU8.length, fileBytes: bootMs.fileBytes, fileCount: bootMs.fileCount, memAt: bootMs.memAt, ini: JSON.parse(r.text || '{}') });
		}
		if (url.pathname === '/_memprobe') {
			// Decompose the Woo-warmed admin-upload working set (issue #189), so the biggest
			// FREEABLE chunk is visible. Bootstraps WordPress in the admin-upload context
			// (WooCommerce active, the wp-admin media includes) and reports memory at each
			// phase, the OPcache breakdown, and WooCommerce's share of loaded files, classes
			// and functions; the Worker adds the WASM heap size and the cross-request object
			// cache. Spike-token gated (every /_ path is). A measurement run: it loads
			// WooCommerce into the runtime, so run it on an isolate you are done measuring.
			bootPromise ??= boot(origin);
			const { php } = await bootPromise;
			const r = await php.run({ code: `<?php
				$P = array('limit' => ini_get('memory_limit'), 'use_zend_alloc' => (memory_get_usage(true) > 0 ? '1' : '0')); // #547: not getenv, which php-wasm sets to "0" itself
				$heap = function () {
					if (!function_exists('post_message_to_js')) { return null; }
					$r = json_decode(post_message_to_js(json_encode(array('probeMem' => 1))), true);
					return (is_array($r) && isset($r['wasm'])) ? $r['wasm'] : null;
				};
				register_shutdown_function(function () use (&$P, $heap) {
					while (ob_get_level()) { ob_end_clean(); }
					$P['wasm_end'] = $heap();
					// memory_get_usage reports 0 under USE_ZEND_ALLOC=0 (the Zend allocator is
					// bypassed), so the wasm_* heap samples above are the memory of record.
					$P['php_mem_end'] = memory_get_usage(true);
					$P['php_mem_peak'] = memory_get_peak_usage(true);
					if (function_exists('opcache_get_status')) {
						$st = @opcache_get_status(false);
						if (is_array($st)) {
							$P['opcache'] = array(
								'used' => isset($st['memory_usage']['used_memory']) ? $st['memory_usage']['used_memory'] : null,
								'free' => isset($st['memory_usage']['free_memory']) ? $st['memory_usage']['free_memory'] : null,
								'wasted' => isset($st['memory_usage']['wasted_memory']) ? $st['memory_usage']['wasted_memory'] : null,
								'scripts' => isset($st['opcache_statistics']['num_cached_scripts']) ? $st['opcache_statistics']['num_cached_scripts'] : null,
								'interned_used' => isset($st['interned_strings_usage']['used_memory']) ? $st['interned_strings_usage']['used_memory'] : null,
							);
						}
					}
					$inc = get_included_files();
					$tot = 0; $wc_files = 0; $wc_bytes = 0;
					foreach ($inc as $f) {
						$sz = @filesize($f);
						if ($sz !== false) { $tot += $sz; }
						if (strpos($f, '/plugins/woocommerce/') !== false) { $wc_files++; if ($sz !== false) { $wc_bytes += $sz; } }
					}
					$wc_classes = 0;
					foreach (get_declared_classes() as $c) { if (stripos($c, 'woocommerce') !== false) { $wc_classes++; } }
					$fns = get_defined_functions();
					$user_fns = isset($fns['user']) ? $fns['user'] : array();
					$wc_fns = 0;
					foreach ($user_fns as $fn) { if (stripos($fn, 'woocommerce') !== false || strpos($fn, 'wc_') === 0) { $wc_fns++; } }
					$P['included'] = array('count' => count($inc), 'bytes' => $tot);
					$P['woocommerce'] = array('files' => $wc_files, 'file_bytes' => $wc_bytes, 'classes' => $wc_classes, 'functions' => $wc_fns);
					$P['classes_total'] = count(get_declared_classes());
					$P['user_functions'] = count($user_fns);
					echo 'PROBE' . json_encode($P);
				});
				$P['wasm_start'] = $heap();
				if (!defined('WP_ADMIN')) { define('WP_ADMIN', true); }
				$_SERVER['REQUEST_URI'] = '/wp-admin/';
				require '/wordpress/wp-load.php';
				$P['wasm_after_wp_load'] = $heap();
				if (function_exists('wp_set_current_user')) { wp_set_current_user(1); }
				require_once ABSPATH . 'wp-admin/includes/image.php';
				require_once ABSPATH . 'wp-admin/includes/media.php';
				require_once ABSPATH . 'wp-admin/includes/admin.php';
				$P['wasm_after_media_includes'] = $heap();` });
			let phpSide;
			const marker = r.text.indexOf('PROBE');
			try { phpSide = JSON.parse(r.text.slice(marker + 5)); } catch { phpSide = { parse_error: true, raw: r.text.slice(Math.max(0, marker), marker + 500) }; }
			return Response.json({
				wasmMemoryBytes: php[__private__dont__use].HEAPU8.length,
				recycleThresholdBytes: RECYCLE_WASM_BYTES,
				objectCache: { entries: objectCache.size, bytes: objectCacheBytes, capBytes: OBJECT_CACHE_BYTES },
				php: phpSide,
			});
		}
		try {
			if (!isolateStart) isolateStart = Date.now(); // #474: the isolate's first request
			ledgerActive = ledgerOn(env, req.headers.get('x-mem-ledger'), perfHeadersAllowed(req, env));
			ledgerId = ledgerActive ? memIdOf(req, env).id || null : null;
			ledgerFailLogged = false;
			sqlMeter.reset();
			ledgerInfl0 = { n: stats.inflates, b: stats.inflateBytes, r: stats.reinflates, ae: inflateArena ? inflateArena.counts.evicts : 0 };
			if (ledgerActive) ledgerLog('start');
			const tBoot = Date.now();
			const booted = !bootPromise;
			if (tracing()) fileTrace.begin({ cls: routeClass(req.method, url.pathname, url.search), method: req.method, path: url.pathname, boot: booted ? 1 : 0 });
			bootPromise ??= boot(origin);
			const { php, handler, bootMs } = await bootPromise;
			const bootWaitMs = Date.now() - tBoot;
			const wasm0 = php[__private__dont__use].HEAPU8.length;
			const start = { dbTables: { ...stats.dbTables }, ocGroups: { ...stats.ocGroups }, calls: stats.calls, ms: stats.ms, fail: stats.failures.length, log: stats.log.length, rowsRead: stats.rowsRead, rowsWritten: stats.rowsWritten, inflates: stats.inflates, inflateBytes: stats.inflateBytes, reinflates: stats.reinflates, lazyWrites: stats.lazyWrites, rfN: stats.rfN, rfBytes: stats.rfBytes, rfMs: stats.rfMs, rfFail: stats.rfFail, rfCapped: stats.rfCapped, ocCalls: stats.ocCalls, ocHits: stats.ocHits, httpCalls: stats.httpCalls, txnOps: stats.txnOps, undoRows: stats.undoRows };
			const delta = () => ({ calls: stats.calls - start.calls, ms: stats.ms - start.ms, failures: stats.failures.slice(start.fail), log: stats.log.slice(start.log) });
			const t0 = Date.now();
			if (url.pathname === '/_install') {
				php.writeFile('/tmp/admin-password', req.headers.get('x-admin-password') || (env.SPIKE_TOKEN ? '' : 'local-spike-password'));
				php.writeFile('/tmp/admin-email', req.headers.get('x-admin-email') || env.ADMIN_EMAIL || 'admin@example.com');
				let out, errors;
				try {
					const r = await php.run({ code: INSTALL });
					out = r.text;
					errors = r.errors;
				} catch (e) {
					out = String((e && e.message) || e);
					errors = 'PHP exited non-zero';
				}
				// The runtime is not usable for requests after this script exits. Boot a fresh one next time.
				bootPromise = null;
				objectCacheClear(); // the database changed outside WordPress's cache
				const tail = out.length > 6000 ? out.slice(-6000) : out;
				return Response.json({ bootMs, ms: Date.now() - t0, out: tail, errors: String(errors).slice(0, 4000), d1: delta() });
			}
			const headers = {};
			req.headers.forEach((v, k) => (headers[k] = v));
			// The AST-cache per-request bypass (issue #173) is honored only with a
			// valid spike token, so a visitor cannot disable the cache in production.
			if (!spikeOk) delete headers['x-ast-cache-off'];
			if (!spikeOk) delete headers['x-oc-off'];
			// The memory trace and its switches (#434) reach PHP only with a valid spike token.
			if (!spikeOk) { delete headers['x-mem-trace']; delete headers['x-mem-off']; }
			let body;
			if (env.MEDIA && isMediaUpload(req, url) && Number(req.headers.get('content-length') || 0) > STAGE_MIN_BYTES) {
				const staged = await stageUpload(req, env);
				body = staged.body;
				headers['content-type'] = staged.contentType;
				headers['content-length'] = String(body.length);
			} else {
				body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
			}
			if (body && body.length > maxBody) return new Response('request body too large', { status: 413 });
			purgeRequested = false;
			pendingEmails = [];
			const r2before = JSON.stringify(stats.r2);
			const r2start = JSON.parse(r2before);
			// OPcache counters before and after, only when a spike-token holder asks (two extra php.run calls).
			const wantOpcache = ctx && ctx.inObject && spikeOk && req.headers.get('x-perf-opcache') === '1';
			const op0 = wantOpcache ? await opcacheStats(php) : null;
			const tPhp = Date.now();
			lastMemTrace = null;
			const r = await handler.request({ url: url.pathname + url.search, method: req.method, headers, body });
			const phpOnlyMs = Date.now() - tPhp;
			const op1 = wantOpcache ? await opcacheStats(php) : null;
			// Approach A: close this request's MySQL connection after the response.
			if (dbHandler) (ctx ? ctx.waitUntil(dbHandler.end()) : dbHandler.end());
			if (ctx && ctx.exports && purgeRequested) schedulePurge(ctx);
			const out = new Headers();
			// In the PHP object, the object itself coalesces the purges of the whole site (issue #78).
			// x-cache-purge (scheduled or coalesced) is for tests.
			if (ctx && ctx.requestPurge && purgeRequested) out.set('x-cache-purge', await ctx.requestPurge());
			const d = delta();
			// A write lost to an isolate memory reset (#350, write-loss.mjs): PHP's answer is replaced,
			// whatever its status, before any of its headers (a Set-Cookie for a session that was not
			// stored) is copied. The statements before the reset may be saved, so no "try again".
			const lost = resetFailures(d.failures);
			// Async email (issue #185): hand the collected messages to the send_email binding off the
			// request path, so checkout never waits on delivery. No binding, no MAIL_FROM, or no ctx:
			// sendPending drops them and says so. Decided only AFTER the lost writes are counted (#368,
			// HOLD): a request with a loss sends no mail, and each held mail is an email-held event.
			if (pendingEmails.length) {
				const plan = heldRequestMail(pendingEmails, lost, { method: req.method, path: url.pathname });
				for (const e of plan.events) console.log(JSON.stringify(e));
				if (plan.events.length) pendingEmails = [];
				else if (ctx && ctx.waitUntil) {
					const sp = sendPending(env);
					if (sp) ctx.waitUntil(sp);
				}
			}
			if (lost) {
				if (ledgerActive) ledgerLog('write-loss', { lost });
				console.log(JSON.stringify({ '@event': 'write-loss', m: 'write-loss', method: req.method, path: url.pathname, failed: lost, phpStatus: r.httpStatusCode, firstSql: sqlShape(d.failures[0].sql) }));
				bootPromise = null; // the runtime saw the reset; the next request boots a new one
				const wl = writeLossResponse(lost, wantsJson(url.pathname, url.search, req.headers.get('accept')));
				return new Response(wl.body, { status: wl.status, headers: wl.headers });
			}
			for (const [k, v] of Object.entries(r.headers)) for (const one of [].concat(v)) out.append(k, one);
			const ocTables = diffCounts(stats.dbTables, start.dbTables);
			const ocGroupStats = diffCounts(stats.ocGroups, start.ocGroups);
			pageCacheHeaders(req, url, r, out, env);
			// A filled cart means a checkout may follow: start the container now.
			if (env.WOO_CHECKOUT && env.CHECKOUT_CONTAINER === 'on' && r.httpStatusCode === 201 && ADD_TO_CART_ROUTE.test(restRoute(url))) {
				ctx.waitUntil(checkoutContainer(env).startAndWaitForPorts().catch((e) => console.log('checkout warm-up failed', String(e))));
				out.set('x-checkout-warmup', '1');
			}
			trimStats();
			const r2now = JSON.stringify(stats.r2);
			if (r2now !== r2before) out.set('x-r2-ops', Object.entries(stats.r2).map(([k, v]) => `${k}:${v.n - (r2start[k]?.n || 0)}/${v.ms - (r2start[k]?.ms || 0)}ms`).filter((s) => !s.includes(':0/')).join(' '));
			if (sqlDb) {
				out.set('x-db', 'object-sqlite');
				out.set('x-db-rows', `read=${stats.rowsRead - start.rowsRead} written=${stats.rowsWritten - start.rowsWritten}`);
			}
			if (Object.keys(ocTables).length || Object.keys(ocGroupStats).length) out.set('x-oc-stats', JSON.stringify({ dbN: d.calls, dbMs: d.ms, tables: ocTables, groups: ocGroupStats, ocKeys: objectCache.size, ocKiB: Math.round(objectCacheBytes / 1024), ...(ocL2W ? { l2w: { ...ocL2W.counts } } : {}) })); // l2w: this isolate's KV write outcomes so far (#500)
			out.set('x-d1-calls', String(d.calls));
			out.set('x-d1-ms', String(d.ms));
			out.set('x-d1-failures', String(d.failures.length));
			if (d.failures.length && spikeOk && env.SPIKE_TOKEN) out.set('x-d1-first-failure', (d.failures[0].error + ' | ' + d.failures[0].sql).replace(/[^\x20-\x7e]/g, ' ').slice(0, 600));
			out.set('x-php-ms', String(Date.now() - t0));
			out.set('x-boot', booted ? '1' : '0');
			if (spikeOk && lastMemTrace) out.set('x-mem-trace', JSON.stringify(lastMemTrace).slice(0, 7900));
			lastMemTrace = null;
			if (ctx && ctx.inObject) out.set('x-boot-origin', bootOrigin);
			// The path only, never the query string: a store's URLs carry order keys and logins there.
			console.log(JSON.stringify({ m: 'req', path: url.pathname, boot: booted, d1: d.calls }));
			globalThis.__lastRequest = { url: url.pathname, status: r.httpStatusCode, ...d };
			if (tracing()) fileTrace.end({ status: r.httpStatusCode });
			evictLazy();
			if (remotePacks) remotePacks.endRequest(); // #563: held packs live for one request
			dropBootPack(php[__private__dont__use].FS); // #394 L1: the boot files are no longer needed
			const wasmBytes = php[__private__dont__use].HEAPU8.length;
			out.set('x-wasm-mib', String(Math.round(wasmBytes / 1048576)));
			// php-wasm answers a crashed runtime with a bare 500. Never reuse it.
			const crashed = r.httpStatusCode === 500 && r.text === 'Internal Server Error';
			// PHP_RECYCLE=off (opcache.sh only): no recycle for memory while OPcache is
			// primed. A recycle drops the runtime and its file cache, so the dump held
			// only what compiled after it, or answered 409 when the last request
			// recycled (measured 2026-11-06: 3 recycles at 119 MiB with WooCommerce and
			// All-in-One WP Migration). A crashed runtime is still dropped.
			let recycled = null;
			if (crashed || (wasmBytes > RECYCLE_WASM_BYTES && env.PHP_RECYCLE !== 'off')) {
				runtimeDrops++;
				bootPromise = null;
				recycled = php;
				out.set('x-runtime-recycled', crashed ? 'crashed' : 'memory');
			}
			if (ctx && ctx.inObject) {
				runtimeServed++;
				const now = Date.now();
				const perf = {
					iso: ISOLATE_ID,
					isoAgeS: Math.round((now - isolateStart) / 1000),
					rt: runtimeSerial,
					rtServed: runtimeServed,
					rtAgeS: Math.round((now - runtimeBootAt) / 1000),
					boot: booted ? 1 : 0,
					bootWaitMs,
					phpMs: phpOnlyMs,
					dbN: d.calls,
					dbMs: d.ms,
					inflates: stats.inflates - start.inflates,
					inflateKiB: Math.round((stats.inflateBytes - start.inflateBytes) / 1024),
					reinflates: stats.reinflates - start.reinflates, // #394 step 2: the CPU side of the arena
					lazyWrites: stats.lazyWrites - start.lazyWrites, // #530: bundle files PHP wrote this request (kept, not dropped)
					wasm0MiB: Math.round(wasm0 / 1048576),
					wasm1MiB: Math.round(wasmBytes / 1048576),
					...(booted ? { l1: l1State } : {}), // #394 L1: where this boot's OPcache boot pack came from
					...(booted && OPCACHE_REMOTE ? { remote: remoteState } : {}), // #563: the remote OPcache packs at this boot
					// #563: remote OPcache pack fetches this request (each one is a subrequest), their KiB and ms,
					// the failed ones (a clean miss: OPcache compiled from source) and the opens past the cap.
					...(OPCACHE_REMOTE ? { rfN: stats.rfN - start.rfN, rfKiB: Math.round((stats.rfBytes - start.rfBytes) / 1024), rfMs: stats.rfMs - start.rfMs, rfFail: stats.rfFail - start.rfFail, rfCapped: stats.rfCapped - start.rfCapped } : {}),
					...(ledgerActive ? { mem: ledgerSnapshot('end') } : {}), // #394: the isolate memory ledger
					bytes: r.bytes.length,
					httpCalls: stats.httpCalls - start.httpCalls,
					txnOps: stats.txnOps - start.txnOps,
					undoRows: stats.undoRows - start.undoRows,
					ocCalls: stats.ocCalls - start.ocCalls,
					ocHits: stats.ocHits - start.ocHits,
					ocKeys: objectCache.size,
					ocKiB: Math.round(objectCacheBytes / 1024),
					dbTables: ocTables,
					ocGroups: ocGroupStats,
					...(op0 && op1 ? { opHits: op1.hits - op0.hits - 1, opMisses: op1.misses - op0.misses, opCached: op1.cached, opFull: op1.full } : {}),
				};
				out.set('x-perf', JSON.stringify(perf));
				console.log(JSON.stringify({ m: 'perf', id: req.headers.get('x-perf-id'), path: url.pathname, ...perf }));
			}
			const response = new Response(r.bytes, { status: r.httpStatusCode, headers: out });
			// #394 (b): a recycled runtime is RELEASED, not only forgotten. bootPromise = null alone left
			// lastBootedPhp holding the old runtime, WASM memory and all, until the next boot had built a
			// new one: after a post-new.php recycle (115 to 121 MiB) the next request booted with both.
			// The response above is built first, so its bytes are not touched.
			if (recycled) releaseRuntime(recycled);
			return response;
		} catch (e) {
			if (bootPromise) runtimeDrops++;
			bootPromise = null; // a failed runtime is not reused
			// The stack names internal paths. It goes to the tail log for every caller, never to the body,
			// so a leaked spike token cannot also leak stacks.
			console.error(String((e && e.stack) || e));
			return new Response('internal error', { status: 500 });
		}
	}
}
