// A request whose writes were lost to an isolate memory reset must never answer success (#350).
//
// When the PHP object's isolate exceeds its memory and the platform resets it in the middle of a
// request, every storage statement after that point fails with "Durable Object's isolate exceeded
// its memory limit and was reset." PHP does not stop: WordPress sees a failed query, carries on, and
// the request answered success. Seen live on fdprobe1112h (2026-11-12): a login answered 302 with its
// auth cookies, but the session_tokens write had failed (x-d1-failures 3, x-db-rows written=0), so
// the next request asked to log in again. A checkout can lose its writes the same way.
//
// Measured on the same site: the statements that ran BEFORE the reset are durable (a marker row
// written first survived, the one written after did not). So the state may be partly saved, and a
// blind retry can repeat what was saved (a second order). The answer is therefore a 500 that says
// so, with no Retry-After and no Set-Cookie: never a 503 "try again", never PHP's own answer.
import { MEMORY_RESET } from './object-error.mjs';

/** How many of a run's statement failures are the isolate memory reset. */
export function resetFailures(failures) {
	let n = 0;
	for (const f of failures || []) if (f && MEMORY_RESET.test(String(f.error || ''))) n++;
	return n;
}

export const WRITE_LOSS_MESSAGE = 'The request did not complete, and some changes may have been saved. Check before you try again.';
export const WRITE_LOSS_BODY = WRITE_LOSS_MESSAGE + '\n';
export const WRITE_LOSS_CODE = 'skyphusion_write_loss';
// #352: the request frame was rolled back, PROVEN by the object's /_frame probe (state rolled-back, no
// commit point passed): nothing of the request was kept, so a retry is safe. Never sent without the proof.
export const ROLLED_BACK_MESSAGE = 'The request did not complete. Nothing was saved. You can try again.';
/** The #352 answer when the frame is proven rolled back: still a 500, never a 302 with half a save. */
export function rolledBackResponse(json = false, kind = 'memory', undone = 0) {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-isolate-reset': kind === 'storage' ? 'storage' : 'memory',
		'x-write-loss': 'rolled-back',
		'x-write-undone': String(Number(undone) || 0),
	};
	const body = json ? JSON.stringify({ code: WRITE_LOSS_CODE, message: ROLLED_BACK_MESSAGE, data: { status: 500, rolledBack: true } }) : ROLLED_BACK_MESSAGE + '\n';
	return { status: 500, headers, body };
}
/** Whether a /_frame answer PROVES the request kept nothing: rolled back, and no commit point passed. */
export function frameProvesRollback(frame) {
	return !!(frame && frame.state === 'rolled-back' && Number(frame.points) === 0);
}

/**
 * An API call gets JSON (the lead's ruling): a REST route (/wp-json/ or ?rest_route=) or a client
 * that asks for JSON. The Store API checkout client then shows the message instead of failing to
 * parse a text body.
 */
export function wantsJson(pathname, search, accept) {
	if (String(pathname || '').startsWith('/wp-json/')) return true;
	if (/(^|[?&])rest_route=/.test(String(search || ''))) return true;
	return /application\/json/i.test(String(accept || ''));
}

/**
 * The answer for a request whose writes may be partly saved: status, headers, body. n is the
 * number of statements that failed in the reset, or 'unknown' when the reset killed the whole
 * request (the object answered nothing). kind is the reset (object-error.mjs): 'memory', or
 * 'storage' for a storage reset (#398). No Retry-After, no Set-Cookie, never cached.
 */
export function writeLossResponse(n, json = false, kind = 'memory') {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-isolate-reset': kind === 'storage' ? 'storage' : 'memory',
		'x-write-loss': String(n),
	};
	const body = json ? JSON.stringify({ code: WRITE_LOSS_CODE, message: WRITE_LOSS_MESSAGE, data: { status: 500 } }) : WRITE_LOSS_BODY;
	return { status: 500, headers, body };
}

/**
 * The mail a request collected, when the request's writes may be partly lost (#368, the lead's
 * ruling: HOLD). With lostWrites > 0 nothing is sent: the client gets the #353 500 ("check before
 * you try again"), so a mail must not confirm a change that may not be saved, and a client retry
 * must not send a second one. The cost, accepted: a change that WAS saved loses its mail. Each held
 * mail is one structured event (never silent); it names the subject and the recipient count, never
 * an address (Workers Logs is not a mail log). Returns { send: [...], events: [...] }.
 */
export function heldRequestMail(pending, lostWrites, req = {}) {
	const list = Array.isArray(pending) ? pending : [];
	if (!(Number(lostWrites) > 0)) return { send: list, events: [] };
	const events = list.map((e) => ({
		'@event': 'email-held',
		m: 'email-held',
		where: 'request',
		lostWrites: Number(lostWrites),
		method: req.method || null,
		path: req.path || null,
		subject: String((e && e.subject) || '').slice(0, 80),
		recipients: (Array.isArray(e && e.to) ? e.to : [e && e.to]).filter(Boolean).length,
	}));
	return { send: [], events };
}

/**
 * The verb and the table of a SQL statement, for a log line: never its values. A store's statements
 * can hold an email or an address, and Workers Logs is not a data store. "OTHER" when it is not one
 * of the verbs below (the binary form, an empty string).
 */
export function sqlShape(sql) {
	const m = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b[\s\S]*?\b(?:FROM|INTO|UPDATE)?\s*`?([A-Za-z0-9_]+)`?/i.exec(String(sql || ''));
	if (!m) return 'OTHER';
	const verb = m[1].toUpperCase();
	let table = m[2];
	if (verb === 'SELECT') {
		const f = /\bFROM\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = f ? f[1] : '?';
	} else if (verb === 'INSERT' || verb === 'REPLACE') {
		const i = /\bINTO\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = i ? i[1] : table;
	} else if (verb === 'DELETE') {
		const f = /\bFROM\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = f ? f[1] : table;
	} else if (verb === 'UPDATE') {
		const u = /^\s*UPDATE\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = u ? u[1] : table;
	}
	return verb + ' ' + table;
}
