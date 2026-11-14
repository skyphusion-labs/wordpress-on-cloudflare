// OPcache files that live in static-asset packs, fetched when PHP opens one (#563, #394 Gate 1).
//
// The build (opcache-split.py --remote) puts the WARM OPcache files in small zips ("packs") under
// /_pf/<build-id>/ in the static assets, and writes an index: for each file, its pack and size; for
// each pack, its byte length and SHA-256. Only the index is in the bundle. MEMFS gets a node per file
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
// Packs are held for one request only (endRequest, next to evictLazy).

export const REMOTE_FETCH_CAP = 32;

async function sha256hex(bytes) {
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let s = '';
	for (const b of h) s += b.toString(16).padStart(2, '0');
	return s;
}

// index: { id, packs: [{ name, bytes, sha256 }], files: { <name>: [packNo, size] } }
// fetchPack(name) -> Promise<Uint8Array> (throws on a non-200); parse(bytes) -> zip entries
// ({ name, data(out) }, index.js zipEntries); stats: the counters x-perf reads (rf*).
export function createRemotePacks({ index, fetchPack, parse, stats, cap = REMOTE_FETCH_CAP, log = () => {} }) {
	const held = new Map(); // packNo -> Map(name -> entry), this request only
	const pending = new Map(); // packNo -> promise of the fetch in flight
	const failed = new Set(); // packNo that failed in this request
	let reqN = 0;
	let cappedLogged = false;
	for (const k of ['rfN', 'rfBytes', 'rfMs', 'rfFail', 'rfCapped']) if (typeof stats[k] !== 'number') stats[k] = 0;

	function load(packNo) {
		if (held.has(packNo)) return null;
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
		const pk = index.packs[packNo];
		const t = Date.now();
		const p = (async () => {
			const bytes = await fetchPack(pk.name);
			if (bytes.length !== pk.bytes) throw new Error(pk.name + ': ' + bytes.length + ' bytes, the index says ' + pk.bytes);
			const h = await sha256hex(bytes);
			if (h !== pk.sha256) throw new Error(pk.name + ': SHA-256 mismatch');
			const m = new Map();
			for (const e of parse(bytes)) m.set(e.name, e);
			held.set(packNo, m);
			stats.rfBytes += bytes.length;
		})().then(
			() => {
				stats.rfMs += Date.now() - t;
				pending.delete(packNo);
			},
			(e) => {
				stats.rfMs += Date.now() - t;
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
			held.clear();
			failed.clear();
			reqN = 0;
			cappedLogged = false;
		},
		heldPacks: () => held.size,
	};
}
