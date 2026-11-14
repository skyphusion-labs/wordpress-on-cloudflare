// node --test spikes/b2-wordpress/tests/undo-log.test.mjs (#352, and #60's first CI coverage).
// undo-log.mjs on node:sqlite through an adapter shaped like the Durable Object's ctx.storage.sql
// (exec(sql, ...params) -> a cursor with raw(), one(), toArray(), columnNames, rowsWritten) and
// ctx.storage.transactionSync. A "new isolate" is a NEW createUndoLog on the SAME database: what the
// module keeps in memory is gone, as after an isolate reset; what SQLite stored stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createUndoLog, mayWrite, isDdl } from '../undo-log.mjs';

function objectSql() {
	const d = new DatabaseSync(':memory:');
	const cursor = (rows, cols, changes) => ({
		columnNames: cols,
		rowsRead: rows.length,
		rowsWritten: changes,
		raw: () => rows[Symbol.iterator](),
		toArray: () => rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))),
		one: () => Object.fromEntries(cols.map((c, i) => [c, rows[0][i]])),
	});
	const exec = (sql, ...params) => {
		const st = d.prepare(sql);
		const cols = st.columns().map((c) => c.name);
		if (cols.length) {
			st.setReturnArrays(true);
			return cursor(st.all(...params), cols, 0);
		}
		return cursor([], [], st.run(...params).changes);
	};
	const storage = {
		transactionSync(fn) {
			d.exec('SAVEPOINT ts');
			try { const r = fn(); d.exec('RELEASE ts'); return r; } catch (e) { d.exec('ROLLBACK TO ts'); d.exec('RELEASE ts'); throw e; }
		},
	};
	return { db: { exec, storage }, storage };
}
function isolate(frames = true) {
	const dropped = [];
	const logs = [];
	const stats = { txnOps: 0, undoRows: 0 };
	const u = createUndoLog({ stats, objectCacheDrop: (k) => dropped.push(k), log: (o) => logs.push(o), frames });
	return { u, stats, dropped, logs };
}
// What PHP's statements do through index.js sqlStatement: the statement runs inside u.statement(), which
// opens the frame just before it when it may write, and takes the open back if it changed nothing.
// The reply is shaped like sqlStatement's: changes from total_changes(), last_row_id after an insert.
function reply(db, sql, cur) {
	return { changes: cur.changes, last_row_id: cur.changes > 0 && /^\s*(INSERT|REPLACE)\b/i.test(sql) ? db.exec('SELECT last_insert_rowid() AS r').one().r : 0 };
}
function run(u, db, sql, ...p) {
	const storage = db.storage;
	return u.statement(db, storage, sql, () => {
		const before = db.exec('SELECT total_changes() AS c').one().c;
		const cur = db.exec(sql, ...p);
		const after = db.exec('SELECT total_changes() AS c').one().c;
		cur.changes = after === before ? 0 : db.exec('SELECT changes() AS c').one().c;
		u.afterStatement(db, sql, cur.rowsWritten);
		return cur;
	});
}
const ids = (db) => [...db.exec('SELECT v FROM t ORDER BY id').raw()].map((r) => r[0]);
function site() {
	const s = objectSql();
	s.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
	s.db.exec("INSERT INTO t (v) VALUES ('seed')");
	return s;
}

test('mayWrite: reads and statements that change no covered row never open a frame; everything else does (conservative)', () => {
	// A PRAGMA (a setter too), VACUUM, ANALYZE and REINDEX change no row of a table the undo triggers cover
	// (CI at 105776b: a PRAGMA opened the frame of 10 of 10 public GETs). They must also never run inside the
	// opening transaction: SQLite ignores PRAGMA foreign_keys there, and VACUUM refuses to run in one.
	for (const q of ['SELECT 1', ' select * from t', 'EXPLAIN SELECT 1', 'PRAGMA table_info(t)', 'PRAGMA foreign_keys', 'PRAGMA foreign_keys = ON', ' pragma journal_mode=WAL;', 'VACUUM', 'ANALYZE', 'REINDEX t']) assert.equal(mayWrite(q), false, q);
	for (const q of ['INSERT INTO t VALUES (1)', 'UPDATE t SET v = 1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'SELECT 1 RETURNING 1', 'CREATE TABLE z (a)']) assert.equal(mayWrite(q), true, q);
	assert.equal(isDdl('CREATE TABLE z (a)'), true);
	assert.equal(isDdl('INSERT INTO t VALUES (1)'), false);
});

test('LAZY: a request that only reads never opens a frame (it pays nothing)', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'r1');
	run(u, db, 'SELECT * FROM t');
	assert.equal(u.frameOpen(), false);
	u.end(db);
	assert.equal(u.status(db, 'r1'), null, 'no frame row at all');
});

test('the FIRST write opens the frame; a reset (a new isolate) rolls the whole request back', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r2');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(a.u.frameOpen(), true);
	run(a.u, db, "UPDATE t SET v = 'seed2' WHERE v = 'seed'");
	run(a.u, db, "INSERT INTO t (v) VALUES ('B')");
	// The isolate dies here: no end(). The next one recovers first.
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'A, B and the update are all undone');
	assert.deepEqual({ ...b.u.status(db, 'r2'), t: 0 }, { req: 'r2', state: 'rolled-back', points: 0, kinds: '', undone: 3, t: 0 });
});

test('a request that FINISHES keeps its writes, and a later recovery undoes nothing', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r3');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.end(db);
	assert.equal(a.u.frameOpen(), false);
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A']);
	assert.equal(b.u.status(db, 'r3').state, 'kept');
});

test('PHP transactions inside a frame are savepoints: a PHP ROLLBACK undoes only its part, the frame stays', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r4');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('P')");
	a.u.txnOp(db, storage, { op: 'rollback' });
	assert.deepEqual(ids(db), ['seed', 'A'], 'only the PHP transaction was undone');
	assert.equal(a.u.frameOpen(), true, 'the frame is still open');
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('Q')");
	a.u.txnOp(db, storage, { op: 'commit' });
	assert.equal(a.u.frameOpen(), true, 'a PHP COMMIT does not commit the frame');
	const b = isolate();
	b.u.recover(db, storage); // the isolate died before end(): the whole request goes
	assert.deepEqual(ids(db), ['seed']);
});

test('a PHP transaction still open at the end is rolled back (MySQL on close); the frame is then kept', () => {
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'r5');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.txnOp(db, objectSql().storage, { op: 'begin' }); // a storage object is only used by undo
	run(a.u, db, "INSERT INTO t (v) VALUES ('P')");
	a.u.end(db, { transactionSync: (fn) => fn() });
	assert.deepEqual(ids(db), ['seed', 'A']);
	assert.equal(a.u.status(db, 'r5').state, 'kept');
});

test('a COMMIT POINT keeps what came before it: a reset after it rolls back only what came after', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r6');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.commitPoint(db, 'http');
	assert.equal(a.u.frameOpen(), false, 'closed as kept; the next write opens a new frame');
	run(a.u, db, "INSERT INTO t (v) VALUES ('B')");
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A']);
	const st = b.u.status(db, 'r6');
	assert.equal(st.state, 'rolled-back');
	assert.equal(st.points, 1);
	assert.equal(st.kinds, 'http');
});

test('DDL inside a frame is a commit point (MySQL implicit commit); the new table is covered next frame', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r7');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	run(a.u, db, 'CREATE TABLE n (id INTEGER PRIMARY KEY, w TEXT)');
	assert.equal(a.u.status(db, 'r7').points, 1);
	run(a.u, db, "INSERT INTO n (w) VALUES ('N')");
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A'], 'before the DDL: kept');
	assert.equal(db.exec('SELECT COUNT(*) AS c FROM n').one().c, 0, 'the new table has triggers: its insert was undone');
});

test('the MISS guard: a write while armed with no frame open is counted and logged, never silent', () => {
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'r8');
	const cur = db.exec("INSERT INTO t (v) VALUES ('X')"); // bypasses beforeStatement on purpose
	a.u.afterStatement(db, 'INSERT INTO t', cur.rowsWritten);
	assert.equal(a.u.counts().miss, 1);
	assert.ok(a.logs.some((l) => l.m === 'frame-miss'));
});

test('deferred work (the KV L2 sets) runs only when the frame is KEPT, never after a reset', () => {
	const { db, storage } = site();
	const ran = [];
	const a = isolate();
	a.u.arm(db, 'r9');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(a.u.defer(() => ran.push('l2-a')), true, 'deferred: a frame is open');
	a.u.end(db);
	assert.deepEqual(ran, ['l2-a']);
	const b = isolate();
	b.u.arm(db, 'r10');
	run(b.u, db, "INSERT INTO t (v) VALUES ('B')");
	b.u.defer(() => ran.push('l2-b'));
	const c = isolate();
	c.u.recover(db, storage); // b died: its deferred work never ran
	assert.deepEqual(ran, ['l2-a']);
	assert.equal(isolate().u.defer(() => ran.push('now')), false, 'no frame: the caller runs it at once');
});

test('ROW-ID REUSE: a rolled-back insert id is reused; after a commit point it is not', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r11');
	const id1 = Number(run(a.u, db, "INSERT INTO t (v) VALUES ('A') RETURNING id").raw().next().value[0]);
	isolate().u.recover(db, storage);
	const b = isolate();
	b.u.arm(db, 'r12');
	const id2 = Number(run(b.u, db, "INSERT INTO t (v) VALUES ('A2') RETURNING id").raw().next().value[0]);
	assert.equal(id2, id1, 'REUSED: INTEGER PRIMARY KEY without AUTOINCREMENT takes max(rowid) + 1');
	// The commit-point rule: an id an outside party may hold is KEPT, so it is never handed out again.
	b.u.commitPoint(db, 'http');
	isolate().u.recover(db, storage);
	const c = isolate();
	c.u.arm(db, 'r13');
	const id3 = Number(run(c.u, db, "INSERT INTO t (v) VALUES ('A3') RETURNING id").raw().next().value[0]);
	assert.equal(id3, id2 + 1, 'kept before the commit point: not reused');
});

test('FRAMES OFF: #60 semantics exactly (begin, commit, rollback, savepoints, open-at-end, recover)', () => {
	const { db, storage } = site();
	const a = isolate(false);
	a.u.arm(db, 'x'); // a no-op with frames off
	run(a.u, db, "INSERT INTO t (v) VALUES ('auto')");
	assert.equal(a.u.frameOpen(), false);
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('r')");
	a.u.txnOp(db, storage, { op: 'rollback' });
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('c')");
	a.u.txnOp(db, storage, { op: 'commit' });
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('s1')");
	a.u.txnOp(db, storage, { op: 'savepoint', name: 'p' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('s2')");
	a.u.txnOp(db, storage, { op: 'rollback_to', name: 'p' });
	a.u.txnOp(db, storage, { op: 'commit' });
	assert.deepEqual(ids(db), ['seed', 'auto', 'c', 's1']);
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'nope' }), { ok: true }, 'outside a transaction: a no-op, as MySQL autocommit');
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('open')");
	const b = isolate(false);
	b.u.recover(db, storage); // the isolate died with a PHP transaction open
	assert.deepEqual(ids(db), ['seed', 'auto', 'c', 's1']);
});

test('status keeps a short history: the probe for a request still answers after a few more requests', () => {
	const { db } = site();
	const a = isolate();
	for (let i = 0; i < 5; i++) { a.u.arm(db, 'h' + i); run(a.u, db, "INSERT INTO t (v) VALUES ('h')"); a.u.end(db); }
	assert.equal(a.u.status(db, 'h0').state, 'kept');
	assert.equal(a.u.status(db, 'nope'), null);
});

// Found by a mutant that survived (the frame's durable active flag left at 0 after a PHP ROLLBACK):
// a PLAIN write after a PHP rollback inside a frame must still be logged, and undone by a reset.
test('after a PHP ROLLBACK inside a frame, a plain write is still logged and a reset undoes it', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r14');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('P')");
	a.u.txnOp(db, storage, { op: 'rollback' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('AFTER')");
	assert.equal(db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active, 1, 'the durable flag is still 1');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'A and AFTER are undone: the frame logged both');
});

test('shapeOf names the verb and table of the statement that opened a frame, never its values', async () => {
	const { shapeOf } = await import('../undo-log.mjs');
	assert.equal(shapeOf("INSERT OR IGNORE INTO wp_options (a) VALUES ('secret')"), 'INSERT OR IGNORE wp_options');
	assert.equal(shapeOf("UPDATE wp_options SET option_value = 'x' WHERE option_name = 'y'"), 'UPDATE wp_options');
	assert.equal(shapeOf('DELETE FROM wp_woocommerce_sessions WHERE session_expiry < 5'), 'DELETE wp_woocommerce_sessions');
	assert.equal(shapeOf("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING"), 'INSERT t ON CONFLICT');
	assert.equal(shapeOf('PRAGMA foreign_keys = ON'), 'PRAGMA foreign_keys');
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'by1');
	run(a.u, db, "UPDATE t SET v = 'x' WHERE v = 'seed'");
	assert.equal(a.u.openedBy(), 'UPDATE t');
});

// #352 laziness (CI red at 8d557c7: 10 of 10 public GETs opened a frame with 0 rows written). The open,
// the statement and its first undo row run in ONE storage transaction; a statement that changed no row
// takes the open back, so it commits nothing durable.
// No undo tables at all (the open was taken back before anything else created them) is active 0 too.
const activeFlag = (db) => { try { return db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active; } catch { return 0; } };
const frameRows = (db) => { try { return db.exec('SELECT COUNT(*) AS n FROM _wp_frame').one().n; } catch { return 0; } };
const NOOPS = ["UPDATE t SET v = 'x' WHERE v = 'none'", "DELETE FROM t WHERE v = 'none'", "INSERT OR IGNORE INTO t (id, v) VALUES (1, 'dup')"];

test('NO-OP WRITE: a write statement that changes no row leaves no frame (no _wp_frame row, active 0)', () => {
	for (const sql of NOOPS) {
		const { db } = site();
		const { u } = isolate();
		u.arm(db, 'n1');
		run(u, db, sql);
		assert.equal(u.frameOpen(), false, sql);
		u.end(db);
		assert.equal(u.status(db, 'n1'), null, 'no frame row: ' + sql);
		assert.equal(frameRows(db), 0, sql);
		assert.equal(activeFlag(db), 0, sql);
		assert.equal(u.counts().opened, 0, sql);
		assert.equal(u.counts().noop, 1, sql);
	}
});

test('NO-OP WRITE: what PHP sees is identical to frames off (changes 0, last insert id, no error)', () => {
	for (const sql of NOOPS) {
		const on = site();
		const off = site();
		const a = isolate(true);
		const b = isolate(false);
		a.u.arm(on.db, 'n2');
		b.u.arm(off.db, 'n2');
		// A real insert first on both, outside any frame, so last_insert_rowid has a value to keep.
		on.db.exec("INSERT INTO t (v) VALUES ('pre')");
		off.db.exec("INSERT INTO t (v) VALUES ('pre')");
		const rOn = run(a.u, on.db, sql);
		const rOff = run(b.u, off.db, sql);
		assert.deepEqual(reply(on.db, sql, rOn), reply(off.db, sql, rOff), sql);
		assert.equal(rOn.changes, 0, sql);
		assert.equal(on.db.exec('SELECT changes() AS c').one().c, off.db.exec('SELECT changes() AS c').one().c, 'changes(): ' + sql);
		assert.deepEqual(ids(on.db), ids(off.db), sql);
	}
});

test('NO-OP then a REAL write: the real write opens the frame and a reset rolls it back', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'n3');
	run(a.u, db, NOOPS[0]);
	assert.equal(a.u.frameOpen(), false);
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(a.u.frameOpen(), true);
	assert.equal(a.u.openedBy(), 'INSERT t');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
});

test('an UNDO ROW decides, not the reported row count: a write reported as 0 rows keeps its frame', () => {
	// The adapter reports rowsWritten 0 for a statement that returns rows (RETURNING), as a counter could
	// under-report: the trigger still logged the before-image, so the frame must stay and cover it.
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'n4');
	const cur = run(a.u, db, "UPDATE t SET v = 'changed' WHERE v = 'seed' RETURNING id");
	assert.equal(cur.rowsWritten, 0, 'the instrument under-reports here, by construction');
	assert.equal(a.u.frameOpen(), true, 'the undo row keeps the frame');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'the RETURNING update is undone');
});

test('a statement that THROWS inside the opening transaction takes the open back and rethrows the same error', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'n5');
	assert.throws(() => run(u, db, 'UPDATE no_such_table SET v = 1'), /no_such_table/);
	assert.equal(u.frameOpen(), false);
	assert.equal(frameRows(db), 0);
	assert.equal(activeFlag(db), 0);
});

test('a PRAGMA setter while armed opens no frame and still TAKES EFFECT (it never runs inside a transaction)', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'n6');
	// node:sqlite starts with foreign keys ON, so the setter that can be seen to change something is OFF.
	assert.equal(db.exec('PRAGMA foreign_keys').one().foreign_keys, 1, 'the instrument: it starts ON');
	run(u, db, 'PRAGMA foreign_keys = OFF');
	assert.equal(u.frameOpen(), false);
	assert.equal(db.exec('PRAGMA foreign_keys').one().foreign_keys, 0, 'the setting held');
	u.end(db);
	assert.equal(frameRows(db), 0);
	assert.equal(u.counts().opened, 0);
});

// pf352f, 2026-11-14: the deployed object never armed a frame. index.js created the one undo log per
// isolate at its FIRST use, and in a deployed object that is the PhpRuntime constructor's recovery, before
// any fetch has set ENV: frames was decided false for the whole isolate. Local workerd hid it (the Worker's
// fetch shares the isolate and sets ENV first). frames may be a function, asked when it matters.
test('frames as a FUNCTION is asked at arm time, not at creation (the undo log may be made before env is known)', () => {
	const { db, storage } = site();
	let on = false;
	const stats = { txnOps: 0, undoRows: 0 };
	const u = createUndoLog({ stats, frames: () => on });
	assert.equal(u.recover(db, storage), null, 'recovery first, as in the constructor, with frames still unknown');
	u.arm(db, 'f0');
	run(u, db, "INSERT INTO t (v) VALUES ('OFF')");
	assert.equal(u.frameOpen(), false, 'the function says off: no frame (a function is not truthy-on)');
	u.end(db);
	db.exec("DELETE FROM t WHERE v = 'OFF'");
	on = true;
	u.arm(db, 'f1');
	run(u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(u.frameOpen(), true, 'the frame opens: frames was read when the request armed');
	const b = createUndoLog({ stats, frames: () => true });
	b.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
	assert.equal(b.status(db, 'f1').state, 'rolled-back');
});

test('recovery ALWAYS logs one line, also when nothing was open (a blind spot otherwise)', () => {
	const { db, storage } = site();
	const logs = [];
	const u = createUndoLog({ stats: { txnOps: 0, undoRows: 0 }, log: (o) => logs.push(o), frames: true });
	u.recover(db, storage);
	assert.equal(logs.filter((l) => l.m === 'frame-recover').length, 1, JSON.stringify(logs));
	assert.equal(logs[0].active, 0);
	assert.equal(logs[0].frames, true);
});

test('a frame open logs one line once it is COMMITTED (never for a no-op that took the open back)', () => {
	const { db } = site();
	const logs = [];
	const u = createUndoLog({ stats: { txnOps: 0, undoRows: 0 }, log: (o) => logs.push(o), frames: true });
	u.arm(db, 'f3');
	run(u, db, "UPDATE t SET v = 'x' WHERE v = 'none'");
	assert.equal(logs.filter((l) => l.m === 'frame-open').length, 0);
	run(u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.deepEqual(logs.filter((l) => l.m === 'frame-open').map((l) => [l.req, l.by]), [['f3', 'INSERT t']]);
});

// The lead asked for the frame's OWN rows: x-db-rows counts PHP's statements (their undo-trigger rows
// included), never the frame's own (the open, the close, the history, the log cleared at close).
test('counts.own: the rows the frame itself writes, exactly; a no-op that took its open back adds none', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'o1');
	run(u, db, NOOPS[0]);
	assert.equal(u.counts().own, 0, 'the taken-back open is not counted');
	run(u, db, "INSERT INTO t (v) VALUES ('A')");
	run(u, db, "INSERT INTO t (v) VALUES ('B')");
	const atOpen = u.counts().own;
	// open: active 0 -> 1 (1) + the _wp_frame row (1) (+ the undo-state seed row the first time: 1)
	assert.ok(atOpen >= 2 && atOpen <= 3, 'open: ' + atOpen);
	u.end(db);
	// close: active 1 -> 0 (1) + the 2 undo rows cleared (2) + the _wp_frame row updated (1)
	assert.equal(u.counts().own - atOpen, 4, 'close');
});
