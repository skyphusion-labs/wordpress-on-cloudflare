// #566: drop a PHP runtime AND release it, once nothing can still be using it. Measured on pf394a (#394
// issuecomment-6878609371): a runtime dropped with a bare `bootPromise = null` stayed reachable through
// lastBootedPhp (live 1, collected 0, through a memory-pressure loop up to the isolate kill), so the
// next boot ran beside it: about 165 MiB of the isolate per drop.
//   boot   the dropped bootPromise (it resolves to { php, ... }), or null
//   held   the runtime lastBootedPhp held at the drop: the same one, or one whose boot failed after it
//          had set lastBootedPhp
//   after  the PHP queue at the drop (index.js phpQueue): every PHP run that could still be using the
//          runtime is in it, so the release waits for it to settle and never happens mid-use
//   release  releaseRuntime (clears lastBootedPhp when it still points at php, then php.exit)
// Keeps no reference after it settles. A release that throws is ignored: the runtime is finished.
export async function dropAndRelease({ boot, held, after, release }) {
	if (!boot && !held) return undefined;
	try {
		await after;
	} catch {
		// a failed run still settled: nothing is using the runtime any more
	}
	let php = null;
	if (boot) {
		try {
			const rt = await boot;
			php = (rt && rt.php) || null;
		} catch {
			php = null; // a failed boot: only what it left in lastBootedPhp (held) remains to release
		}
	}
	for (const p of new Set([php, held])) {
		if (!p) continue;
		try {
			release(p);
		} catch {
			// already exited, or exit threw: nothing more to release
		}
	}
	return undefined;
}
