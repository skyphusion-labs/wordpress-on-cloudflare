// The undo log of the PHP object's SQLite (#60) and the REQUEST FRAME on it (#352).
//
// #60, moved here from index.js unchanged in behavior (docs/approach-b.md 8l): the object's SQLite
// refuses BEGIN and SAVEPOINT, so while a transaction is open, per-table triggers write the inverse
// SQL of each row change to _wp_undo (SQLite's "Automatic Undo/Redo"), and a ROLLBACK replays it,
// newest first. _wp_undo_state.active is STORED, so an isolate that died with it set is rolled back
// by the next one (recover()). PHP's own BEGIN, COMMIT, ROLLBACK and savepoints reach txnOp() through
// php/real-transactions.php.
//
// #352, the request frame (frames = REQUEST_FRAMES=on): a request is armed (arm()) before PHP runs.
// The frame OPENS LAZILY, just before the request's first statement that may write (beforeStatement,
// called by index.js sqlStatement for every PHP statement), so a request that only reads pays nothing.
// It closes KEPT when the request ends (end()), a PHP fatal included: the frame hides OUR platform's
// failure (an isolate reset), not WordPress's (autocommit semantics). It closes ROLLED BACK only by
// recover() in the next isolate. Inside a frame:
// - a PHP BEGIN is a savepoint of the frame, its COMMIT a release, its ROLLBACK undoes only its part;
// - a COMMIT POINT (DDL, an outbound non-GET HTTP call, an R2 delete or copy) closes the frame KEPT
//   just before the effect: a rollback never erases a row an outside party may already know about. The
//   next write opens a new frame;
// - defer(fn) holds work that must not outlive a rollback (the KV L2 cache sets) until the frame is kept.
// _wp_frame keeps the outcome per request id (a short history) for the Worker's /_frame probe, so a
// client is only told "nothing was saved" when it is proven.

const UNDO_TABLES = new Set(['_wp_undo', '_wp_undo_state', '_wp_frame']);
const FRAME_HISTORY = 32;

/** A statement that may write. Conservative: only a plain SELECT or EXPLAIN and a query PRAGMA are reads. */
export function mayWrite(sql) {
	const s = String(sql || '');
	if (/\bRETURNING\b/i.test(s)) return true;
	if (/^\s*(SELECT|EXPLAIN)\b/i.test(s)) return false;
	if (/^\s*PRAGMA\s+[\w.]+\s*(\(\s*[^)]*\)\s*)?;?\s*$/i.test(s)) return false;
	return true;
}
/** The verb and the first table of a statement, for a log or x-perf: never its values. */
export function shapeOf(sql) {
	const s = String(sql || '').replace(/\s+/g, ' ').trim();
	const verb = (s.match(/^(\w+)/) || [, '?'])[1].toUpperCase();
	const t = s.match(/\b(?:INTO|FROM|UPDATE|TABLE)\s+[`"]?([A-Za-z0-9_]+)/i);
	const or = s.match(/^\w+\s+OR\s+(\w+)/i);
	const onc = /\bON\s+CONFLICT\b/i.test(s) ? ' ON CONFLICT' : '';
	return verb + (or ? ' OR ' + or[1].toUpperCase() : '') + (t ? ' ' + t[1] : '') + onc;
}
/** DDL: MySQL's implicit commit, a commit point of the frame. */
export function isDdl(sql) {
	return /^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(String(sql || ''));
}

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
// A signature of sqlite_master (entries and the length of their SQL): any DDL changes it. PRAGMA
// schema_version would be the direct way, but the object's SQLite refuses it (SQLITE_AUTH).
function schemaSig(db) {
	const r = db.exec('SELECT COUNT(*) AS n, TOTAL(LENGTH(sql)) AS l FROM sqlite_master').one();
	return r.n + ':' + r.l;
}

export function createUndoLog({ stats, objectCacheDrop = () => {}, log = () => {}, frames = false } = {}) {
	let undoSchemaSig = null;
	let setupDone = false;
	let txnFrames = null; // PHP's transaction and its savepoints: [{ name, seq }]
	const txnTouched = new Set();
	let armedReq = null; // the request id a frame may open for
	let frameOpen = false;
	let points = 0;
	let kinds = [];
	let deferred = [];
	let recovered = false;
	const counts = { opened: 0, kept: 0, points: 0, miss: 0 };
	let openedBy = null; // the shape (verb and table, never values) of the statement that opened the last frame

	function undoSetup(db) {
		if (setupDone) return;
		db.exec('CREATE TABLE IF NOT EXISTS _wp_undo (seq INTEGER PRIMARY KEY AUTOINCREMENT, sql TEXT NOT NULL)');
		db.exec('CREATE TABLE IF NOT EXISTS _wp_undo_state (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL)');
		db.exec('INSERT OR IGNORE INTO _wp_undo_state (id, active) VALUES (1, 0)');
		if (frames) db.exec('CREATE TABLE IF NOT EXISTS _wp_frame (req TEXT PRIMARY KEY, state TEXT NOT NULL, points INTEGER NOT NULL, kinds TEXT NOT NULL, undone INTEGER NOT NULL, t INTEGER NOT NULL)');
		setupDone = true;
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
	const undoSeq = (db) => db.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM _wp_undo').one().s;
	const setActive = (db, on) => db.exec('UPDATE _wp_undo_state SET active = ? WHERE id = 1', on ? 1 : 0);
	// Undo every change after seq, newest first, in one storage transaction.
	function undoTo(db, storage, seq) {
		setActive(db, false);
		const rows = [...db.exec('SELECT sql FROM _wp_undo WHERE seq > ? ORDER BY seq DESC', seq).raw()];
		const apply = () => {
			for (const [stmt] of rows) db.exec(stmt);
			db.exec('DELETE FROM _wp_undo WHERE seq > ?', seq);
		};
		if (storage && typeof storage.transactionSync === 'function') storage.transactionSync(apply);
		else apply();
		stats.undoRows += rows.length;
		for (const k of txnTouched) objectCacheDrop(k);
		txnTouched.clear();
		return rows.length;
	}
	// PHP's transaction ends; the frame, if open, goes on (active stays 1).
	function phpClose(db) {
		txnFrames = null;
		txnTouched.clear();
		if (!frameOpen) {
			setActive(db, false);
			db.exec('DELETE FROM _wp_undo');
		}
	}
	function frameRow(db, req, state) {
		db.exec('INSERT INTO _wp_frame (req, state, points, kinds, undone, t) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (req) DO UPDATE SET state = excluded.state, points = excluded.points, kinds = excluded.kinds, t = excluded.t', req, state, points, kinds.join(','), Date.now());
	}
	function frameOpenNow(db, sql) {
		openedBy = sql ? shapeOf(sql) : 'php-begin';
		undoSetup(db);
		undoTriggers(db);
		setActive(db, true);
		frameOpen = true;
		counts.opened++;
		frameRow(db, armedReq, 'open');
		db.exec('DELETE FROM _wp_frame WHERE req NOT IN (SELECT req FROM _wp_frame ORDER BY t DESC LIMIT ?)', FRAME_HISTORY);
	}
	// Close the frame KEPT: its rows stay, the log goes, deferred work runs.
	function frameKeep(db, state) {
		if (txnFrames) txnFrames = txnFrames.map((f) => ({ ...f, seq: 0 })); // a PHP txn spanning a commit point keeps what came before it
		setActive(db, false);
		db.exec('DELETE FROM _wp_undo');
		frameOpen = false;
		frameRow(db, armedReq, state);
		const work = deferred;
		deferred = [];
		for (const fn of work) {
			try { fn(); } catch (e) { log({ m: 'frame-deferred-failed', error: String((e && e.message) || e).slice(0, 160) }); }
		}
	}

	return {
		/** Arm a frame for this request (frames on). It opens at the first write. */
		arm(db, req) {
			if (!frames) return;
			armedReq = String(req || 'req-' + Date.now());
			points = 0;
			kinds = [];
			deferred = [];
		},
		frameOpen: () => frameOpen,
		phpTxnOpen: () => !!txnFrames,
		counts: () => ({ ...counts }),
		openedBy: () => openedBy,
		touch(k) {
			if (txnFrames) txnTouched.add(k);
		},
		/** Before every PHP statement: open the frame just before the first one that may write; a DDL is a commit point. */
		beforeStatement(db, sql) {
			if (!armedReq) return;
			if (frameOpen && isDdl(sql)) return this.commitPoint(db, 'ddl');
			if (!frameOpen && mayWrite(sql) && !isDdl(sql)) frameOpenNow(db, sql);
		},
		/** After a statement: a write while armed with no frame open is a MISS, counted and logged. */
		afterStatement(db, sql, rowsWritten) {
			if (armedReq && !frameOpen && rowsWritten > 0 && !isDdl(sql)) {
				counts.miss++;
				log({ m: 'frame-miss', req: armedReq, verb: (String(sql).match(/^\s*(\w+)/) || [, '?'])[1].toUpperCase(), rows: rowsWritten });
			}
		},
		/** Close the frame KEPT just before an effect that cannot be undone. */
		commitPoint(db, kind) {
			if (!armedReq || !frameOpen) return;
			points++;
			counts.points++;
			kinds.push(kind);
			frameKeep(db, 'open');
		},
		/** Run fn when the frame is kept; returns false (fn not taken) when no frame is open. */
		defer(fn) {
			if (!frameOpen) return false;
			deferred.push(fn);
			return true;
		},
		/** The request ended (PHP finished, a fatal included): a PHP transaction still open is rolled back, the frame kept. */
		end(db, storage) {
			if (txnFrames) {
				const n = undoTo(db, storage, txnFrames[0].seq);
				phpClose(db);
				if (frameOpen) setActive(db, true);
				log({ m: 'txn', rolledBackAtEnd: true, undone: n });
			}
			if (frameOpen) {
				counts.kept++;
				frameKeep(db, 'kept');
			} else if (armedReq && points > 0) {
				frameRow(db, armedReq, 'kept');
			}
			armedReq = null;
		},
		/** PHP's transaction ops (php/real-transactions.php). */
		txnOp(db, storage, op) {
			stats.txnOps++;
			try {
				const kind = op.op;
				if (kind === 'begin') {
					if (txnFrames && !frameOpen) phpClose(db); // MySQL commits an open transaction first
					if (armedReq && !frameOpen) frameOpenNow(db);
					undoSetup(db);
					undoTriggers(db);
					txnFrames = [{ name: null, seq: undoSeq(db) }];
					txnTouched.clear();
					setActive(db, true);
					return { ok: true };
				}
				if (kind === 'commit' || kind === 'ddl') {
					if (kind === 'ddl' && frameOpen) this.commitPoint(db, 'ddl');
					if (txnFrames) phpClose(db); // DDL: MySQL's implicit commit
					return { ok: true };
				}
				if (kind === 'rollback') {
					if (!txnFrames) return { ok: true };
					const n = undoTo(db, storage, txnFrames[0].seq);
					phpClose(db);
					if (frameOpen) setActive(db, true);
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
					setActive(db, true);
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
		},
		/** Once per isolate, before anything reads the database: undo what an isolate that died left open. */
		recover(db, storage) {
			if (recovered) return null;
			recovered = true;
			let active = 0;
			try {
				active = db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active;
			} catch {
				return null; // no undo tables yet: no transaction or frame was ever opened
			}
			if (!active) return null;
			const n = undoTo(db, storage, 0);
			db.exec('DELETE FROM _wp_undo');
			txnFrames = null;
			let req = null;
			try {
				const r = [...db.exec("SELECT req FROM _wp_frame WHERE state = 'open' ORDER BY t DESC LIMIT 1").raw()];
				if (r.length) {
					req = r[0][0];
					db.exec("UPDATE _wp_frame SET state = 'rolled-back', undone = ? WHERE req = ?", n, req);
				}
			} catch {
				// frames were never on here
			}
			log({ m: 'txn', recovered: true, undone: n, req });
			return { undone: n, req };
		},
		/** The outcome of a request, for the Worker's /_frame probe: null when unknown. */
		status(db, req) {
			try {
				const r = [...db.exec('SELECT req, state, points, kinds, undone, t FROM _wp_frame WHERE req = ?', String(req)).raw()];
				if (!r.length) return null;
				const [q, state, p, k, undone, t] = r[0];
				return { req: q, state, points: p, kinds: k, undone, t };
			} catch {
				return null;
			}
		},
	};
}
