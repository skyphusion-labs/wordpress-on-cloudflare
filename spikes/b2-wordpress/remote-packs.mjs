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

async function sha256hex(bytes) {
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let s = '';
	for (const b of h) s += b.toString(16).padStart(2, '0');
	return s;
}

// index: { id, packs: [{ name, bytes, sha256 }], files: { <name>: [packNo, size] } }
// fetchPack(name) -> Promise<Uint8Array> (throws on a non-200); parse(bytes) -> zip entries
// ({ name, data(out) }, index.js zipEntries); stats: the counters x-perf reads (rf*).
export function createRemotePacks({ index, fetchPack, parse, stats, cap = REMOTE_FETCH_CAP, holdBytes = REMOTE_HOLD_BYTES, log = () => {} }) {
	// packNo -> Map(name -> entry), this request only. A Map keeps insertion order: the first key is
	// the least recently used pack (touch() moves a pack to the end).
	const held = new Map();
	let heldBytes = 0;
	let heldMax = 0;
	let lastHeldMax = 0;
	const distinct = new Set(); // packs fetched in this request: rfN minus this is the refetch (thrash) count
	let lastDistinct = 0;
	const pending = new Map(); // packNo -> promise of the fetch in flight, THIS request only
	// #563 audit (the #568 class): every fetch is started by an open() of a live request and awaited
	// by it, through the loader's Suspending import; nothing here runs in the background, so nothing
	// needs waitUntil. But a request can END with a fetch in flight, and workerd may drop that promise
	// so it never settles. epoch makes such a fetch harmless: endRequest() forgets it (the next
	// request fetches again, never waits on it), and a late result is thrown away, never held.
	let epoch = 0;
	const failed = new Set(); // packNo that failed in this request
	let reqN = 0;
	let cappedLogged = false;
	for (const k of ['rfN', 'rfBytes', 'rfMs', 'rfFail', 'rfCapped']) if (typeof stats[k] !== 'number') stats[k] = 0;

	function touch(packNo) {
		const m = held.get(packNo);
		held.delete(packNo);
		held.set(packNo, m);
	}
	function hold(packNo, m, size) {
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
	function load(packNo) {
		if (held.has(packNo)) {
			touch(packNo);
			return null;
		}
		if (pending.has(packNo)) return pending.get(packNo);
		if (failed.has(packNo)) return Promise.reject(new Error('pack ' + packNo + ' failed earlier in this request'));
		if (reqN >= cap) {
			stats.rfCapped++;
			if (!cappedLogged) log({ m: 'remote', capped: cap, pack: index.packs[packNo].name }); // once per request, loudly
			cappedLogged = true;
			return Promise.reject(new Error('remote fetch cap ' + cap + ' reached'));
		}
		reqN++;
		stats.rfN++;
		distinct.add(packNo);
		const pk = index.packs[packNo];
		const t = Date.now();
		const mine = epoch;
		const p = (async () => {
			const bytes = await fetchPack(pk.name);
			if (bytes.length !== pk.bytes) throw new Error(pk.name + ': ' + bytes.length + ' bytes, the index says ' + pk.bytes);
			const h = await sha256hex(bytes);
			if (h !== pk.sha256) throw new Error(pk.name + ': SHA-256 mismatch');
			if (mine !== epoch) throw new Error(pk.name + ': its request ended before the fetch did');
			const m = new Map();
			for (const e of parse(bytes)) m.set(e.name, e);
			hold(packNo, m, bytes.length);
			stats.rfBytes += bytes.length;
		})().then(
			() => {
				stats.rfMs += Date.now() - t;
				if (mine === epoch) pending.delete(packNo);
			},
			(e) => {
				stats.rfMs += Date.now() - t;
				if (mine !== epoch) throw e; // an ended request's fetch: no count, no mark on the next request
				stats.rfFail++;
				failed.add(packNo);
				pending.delete(packNo);
				log({ m: 'remote', fail: String((e && e.message) || e).slice(0, 200) });
				throw e;
			},
		);
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
			const m = f === undefined ? null : held.get(f[0]);
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
			reqN = 0;
			cappedLogged = false;
		},
		heldPacks: () => held.size,
		// The high-water of held pack bytes in the request that ended last (x-perf rfHeldKiB).
		lastHeldMax: () => lastHeldMax,
		// Distinct packs fetched in the request that ended last (x-perf rfPacks).
		lastDistinct: () => lastDistinct,
	};
}
