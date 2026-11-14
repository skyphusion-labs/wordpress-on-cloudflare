// OPcache files that live in static-asset packs, fetched when PHP opens one (#563, #394 Gate 1).
//
// The build (opcache-remote.py) puts EVERY OPcache file in zips of about 1 MiB ("packs") under
// /_pf/<build-id>/ in the static assets, in the order a cold boot reads them, and writes an index:
// for each file, its pack and size; for each pack, its byte length and SHA-256. Only the index is
// in the bundle. There is no split and no boot pack (#394 issuecomment-6878206213). MEMFS gets a node per file
// at boot (so stat() needs no bytes), and the loader's open() asks open() here first (prepare.sh,
// the pagefeatherOpen hook). A file whose pack is not held yet returns a promise: PHP pauses until
// the pack is fetched and checked. Then the node's contents getter inflates from the held pack.
//
// Fail clean, never a half file:
// - a pack is used only if its length AND its SHA-256 match the index;
// - a fetch that fails, a mismatch, or the per-request cap makes the promise reject, and the loader
//   fails the open with EIO. For an OPcache file that is a file-cache miss: OPcache compiles the
//   script from source, its normal path. The page stays correct; only CPU is spent.
// - a pack that failed is not fetched again in the same request; the next request tries again.
// Every pack fetch is a subrequest (Gate 0, #394 issuecomment-6878010968: ASSETS.fetch counts
// against the limit), so a request fetches at most `cap` packs. Past that, opens fail as above.
// The held budget: at most holdBytes of packs are held (REMOTE_HOLD_KIB, default 4096), least
// recently used out first; the pack being opened is always kept. Packs end just over 1 MiB, so 4 MiB
// holds three. Measured (opcache-build run 43603733149, one runtime, home/shop/login/REST): 2 MiB held
// ONE pack and thrashed (86 fetches, 53 of them refetches); 4 MiB made 20 fetches on the cold boot
// and 39 over the 4 pages, peak 3,270 KiB, against the 14 MiB L1's boot pack held. A read of
// a file whose pack was evicted fails with EIO (the contents getter has the bytes or throws), and
// OPcache compiles that script: never a half file. Every pack is dropped at the end of a request
// (endRequest, next to evictLazy), so nothing is held across requests.
//
// The cap: Workers Paid allows 10,000 subrequests per invocation (Workers limits page, Nov 13 2026).
// A cold boot fetches about 20 packs at the 4 MiB budget (measured above). 64 is 3x that, and fails
// clean (a compile) far below the platform limit. A Free site (50) or a site with a
// lower [limits] subrequests must set REMOTE_FETCH_CAP below its own limit.

export const REMOTE_FETCH_CAP = 64;
export const REMOTE_HOLD_BYTES = 4096 * 1024;
// #569 (Gate 2): site opens may go on to this per-request HARD cap (0.96 % of the Paid 10,000). The
// measured cold admin request is about 44 fetches in all (#394 issuecomment-6879197224).
export const SITE_FETCH_CAP = 96;
export const SITE_HOLD_BYTES = 2048 * 1024;

async function sha256hex(bytes) {
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let s = '';
	for (const b of h) s += b.toString(16).padStart(2, '0');
	return s;
}

// One request's subrequest budget, shared by the OPcache and the site packs (#569). OPcache opens
// stop at the SOFT cap: past it, an OPcache file is a compile from source, free and correct. Site
// opens may go on to the HARD cap: a site file that cannot be fetched is an honest 500, so site
// needs the headroom. Each fetch, a retry included, takes one. reset() at the end of a request.
export function createFetchBudget({ soft = REMOTE_FETCH_CAP, hard = SITE_FETCH_CAP } = {}) {
	let n = 0;
	return {
		get n() { return n; },
		soft,
		hard,
		take(limit) {
			if (n >= (limit === 'hard' ? hard : soft)) return false;
			n++;
			return true;
		},
		reset() { n = 0; },
	};
}

// index: { id, packs: [{ name, bytes, sha256 }], files: { <name>: [packNo, size] }, hot? }
//   hot (site, #569): { name, bytes, sha256 }, the pack of the files with packNo -1. It is fetched
//   once per runtime and held across requests, outside the LRU budget.
// fetchPack(name) -> Promise<Uint8Array> (throws on a non-200); parse(bytes) -> zip entries
// ({ name, data(out) }, index.js zipEntries); stats: the counters x-perf reads, named prefix + N,
// Bytes, Ms, Fail, Capped, Retry ('rf' OPcache, 'rs' site).
// budget/limit: a shared createFetchBudget and which cap this instance stops at. Without one, a
//   budget of its own at `cap` (the #565 shape), reset by endRequest.
// retries/retryDelayMs/sleep: a failed fetch is tried again `retries` times after a fixed delay
//   (site: 1, so one transient ASSETS hiccup is not a 500). Each retry is counted, and needs budget.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function createRemotePacks({ index, fetchPack, parse, stats, cap = REMOTE_FETCH_CAP, holdBytes = REMOTE_HOLD_BYTES, log = () => {}, prefix = 'rf', budget = null, limit = 'soft', retries = 0, retryDelayMs = 50, sleep = realSleep }) {
	// packNo -> Map(name -> entry), this request only. A Map keeps insertion order: the first key is
	// the least recently used pack (touch() moves a pack to the end).
	const held = new Map();
	let heldBytes = 0;
	let heldMax = 0;
	let lastHeldMax = 0;
	let hot = null; // the hot pack's Map(name -> entry), held for the life of this runtime
	const distinct = new Set(); // packs fetched in this request: N minus this is the refetch (thrash) count
	let lastDistinct = 0;
	const pending = new Map(); // packNo -> promise of the fetch in flight, THIS request only
	// #569 audit (the #568 class): every fetch is started by an open() of a live request and awaited
	// by it, through the loader's Suspending import; nothing here runs in the background, so nothing
	// needs waitUntil. But a request can END with a fetch in flight (an exception, a dropped isolate
	// task), and workerd may drop that promise so it never settles. epoch makes such a fetch harmless:
	// endRequest() forgets it (the next request fetches again, never waits on it), and a late result
	// of an ended request is thrown away, never held in the next one.
	let epoch = 0;
	const failed = new Set(); // packNo that failed in this request
	const own = !budget;
	const bud = budget || createFetchBudget({ soft: cap, hard: cap });
	const lim = budget ? limit : 'soft';
	let cappedLogged = false;
	const K = (s) => prefix + s;
	for (const s of ['N', 'Bytes', 'Ms', 'Fail', 'Capped', 'Retry']) if (typeof stats[K(s)] !== 'number') stats[K(s)] = 0;
	const packAt = (packNo) => (packNo === -1 ? index.hot : index.packs[packNo]);

	function touch(packNo) {
		const m = held.get(packNo);
		held.delete(packNo);
		held.set(packNo, m);
	}
	function hold(packNo, m, size) {
		if (packNo === -1) {
			hot = m;
			return;
		}
		held.set(packNo, m);
		heldBytes += size;
		// Least recently used out first, but never the pack just fetched.
		for (const k of held.keys()) {
			if (heldBytes <= holdBytes || k === packNo) break;
			held.delete(k);
			heldBytes -= index.packs[k].bytes;
		}
		if (heldBytes > heldMax) heldMax = heldBytes;
	}
	function capped(pk) {
		stats[K('Capped')]++;
		if (!cappedLogged) log({ m: 'remote', kind: prefix, capped: lim === 'hard' ? bud.hard : bud.soft, pack: pk.name }); // once per request, loudly
		cappedLogged = true;
		return new Error('remote fetch cap ' + (lim === 'hard' ? bud.hard : bud.soft) + ' reached');
	}
	async function fetchChecked(pk) {
		const bytes = await fetchPack(pk.name);
		if (bytes.length !== pk.bytes) throw new Error(pk.name + ': ' + bytes.length + ' bytes, the index says ' + pk.bytes);
		const h = await sha256hex(bytes);
		if (h !== pk.sha256) throw new Error(pk.name + ': SHA-256 mismatch');
		return bytes;
	}
	function load(packNo) {
		if (packNo === -1 ? hot !== null : held.has(packNo)) {
			if (packNo !== -1) touch(packNo);
			return null;
		}
		if (pending.has(packNo)) return pending.get(packNo);
		const pk = packAt(packNo);
		if (failed.has(packNo)) return Promise.reject(new Error(pk.name + ' failed earlier in this request'));
		if (!bud.take(lim)) return Promise.reject(capped(pk));
		stats[K('N')]++;
		distinct.add(packNo);
		const t = Date.now();
		const mine = epoch;
		const p = (async () => {
			let bytes;
			for (let attempt = 0; ; attempt++) {
				try {
					bytes = await fetchChecked(pk);
					break;
				} catch (e) {
					if (attempt >= retries) throw e;
					stats[K('Retry')]++;
					log({ m: 'remote', kind: prefix, retry: String((e && e.message) || e).slice(0, 200) });
					await sleep(retryDelayMs);
					if (!bud.take(lim)) throw capped(pk);
					stats[K('N')]++;
				}
			}
			if (mine !== epoch) throw new Error(pk.name + ': its request ended before the fetch did');
			const m = new Map();
			for (const e of parse(bytes)) m.set(e.name, e);
			hold(packNo, m, bytes.length);
			stats[K('Bytes')] += bytes.length;
		})().then(
			() => {
				stats[K('Ms')] += Date.now() - t;
				if (mine === epoch) pending.delete(packNo);
			},
			(e) => {
				stats[K('Ms')] += Date.now() - t;
				if (mine !== epoch) throw e; // an ended request's fetch: no count, no mark on the next request
				stats[K('Fail')]++;
				failed.add(packNo);
				pending.delete(packNo);
				log({ m: 'remote', kind: prefix, fail: String((e && e.message) || e).slice(0, 200) });
				throw e;
			},
		);
		// A stale fetch (its request ended) rejects into a chain nobody awaits any more; mark it handled
		// so it never logs as an unhandled rejection. Anyone who IS waiting still gets the rejection.
		p.catch(() => {});
		pending.set(packNo, p);
		return p;
	}

	return {
		files: index.files,
		// null: no wait (not a remote file, or its pack is held). A promise: wait for the pack.
		open(name) {
			const f = index.files[name];
			return f === undefined ? null : load(f[0]);
		},
		// The bytes of a remote file from its held pack, or null when the pack is not held.
		data(name, out) {
			const f = index.files[name];
			const m = f === undefined ? null : f[0] === -1 ? hot : held.get(f[0]);
			const e = m && m.get(name);
			return e ? e.data(out) : null;
		},
		endRequest() {
			epoch++;
			pending.clear();
			held.clear();
			heldBytes = 0;
			lastHeldMax = heldMax;
			heldMax = 0;
			lastDistinct = distinct.size;
			distinct.clear();
			failed.clear();
			if (own) bud.reset();
			cappedLogged = false;
		},
		heldPacks: () => held.size,
		// The high-water of held pack bytes in the request that ended last (x-perf rfHeldKiB), the hot
		// pack not included (its fixed cost is index.hot.bytes).
		lastHeldMax: () => lastHeldMax,
		// Distinct packs fetched in the request that ended last (x-perf rfPacks).
		lastDistinct: () => lastDistinct,
		hotHeld: () => hot !== null,
	};
}

// #569 (Gate 2, the HYBRID): the loader hooks for SITE files (site.zip names, no leading slash).
// OPcache opens a .php source it then serves from its cache WITHOUT reading it (step 3, #394
// issuecomment-6879862441: 37,721 of 37,721 opened-but-unread site files were .php), so:
// - a .php is fetched at its FIRST READ (pagefeatherRead, prepare.sh PY6), and pinned from that read
//   to its close;
// - every other site file is fetched at its OPEN (pagefeatherOpen, PY5), and pinned from the open, so
//   a failure stays a clean false (a failed READ makes @file_get_contents return "", Gate 0b).
// The node gets pagefeatherName and pagefeatherPin from attachLazyContents (tag.pin 'read').
export function createSiteHooks(remote, isPhp = (name) => name.endsWith('.php')) {
	return {
		pinMode: (name) => (isPhp(name) ? 'read' : 'open'),
		// null: open now (not a site file, a .php, or its pack is held). A promise: wait for the pack.
		open(path) {
			const name = path.charCodeAt(0) === 47 ? path.slice(1) : path;
			if (remote.files[name] === undefined || isPhp(name)) return null;
			return remote.open(name);
		},
		read(stream) {
			const node = stream && stream.node;
			if (!node || typeof node.pagefeatherPin !== 'function' || stream.pfPinned) return null;
			const p = remote.open(node.pagefeatherName);
			if (!p) {
				node.pagefeatherPin(stream); // throws EIO (an ErrnoError) if the bytes cannot be had
				return null;
			}
			return p.then(() => node.pagefeatherPin(stream));
		},
	};
}

// #569: the BOOT SELF-CHECK (after Gate 0b's red control read files as EMPTY, silently). A known
// remote .php (site-remote.py records [name, size, sha256]) is read through PHP at boot: the read
// path a site depends on. Anything but its exact size and SHA-256 fails the boot, loudly.
export function selfCheckCode([name]) {
	return '<?php $c = @file_get_contents(' + JSON.stringify('/' + name) + '); echo is_string($c) ? strlen($c) . "|" . hash("sha256", $c) : "false";';
}
export function checkSelfCheck(text, [name, size, sha256]) {
	const want = size + '|' + sha256;
	if (String(text).trim() !== want) throw new Error('site self-check failed: /' + name + ' read as ' + JSON.stringify(String(text).slice(0, 80)) + ', want ' + want + ' (SITE_REMOTE reads are not working; the boot is refused)');
}
