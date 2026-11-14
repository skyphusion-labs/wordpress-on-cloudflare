// #566: release a dropped PHP runtime SYNCHRONOUSLY, at a point where nothing can be using it, with no
// promise continuation in between. #568 chained the release on the PHP queue and registered it nowhere;
// workerd drops the continuations of a finished or aborted request, so on pf394a the release never ran
// (the ledger still read wasmMiB 86.7 after /_evict, #394).
//   running   PHP runs executing now (index.js withPhp brackets each one with runStart / runEnd;
//             more than one only after a stale lock)
//   retire    queue a runtime for release, and release the queue at once when no run executes
//   retire(php, true)   queue only (a boot that finished after a drop: a caller may still await it)
//   runEnd    a run finished: when none executes any more, release the queue, in this call
// release is releaseRuntime (it clears lastBootedPhp when it still points at php, then php.exit). A
// release that throws is ignored. Nothing is kept once released.
export function createRetirer(release) {
	let running = 0;
	const queued = new Set();
	const reap = () => {
		if (running > 0) return 0;
		let n = 0;
		for (const php of queued) {
			queued.delete(php);
			n++;
			try {
				release(php);
			} catch {
				// already exited, or exit threw: the runtime is finished either way
			}
		}
		return n;
	};
	return {
		retire(php, deferOnly = false) {
			if (php) queued.add(php);
			return deferOnly ? 0 : reap();
		},
		runStart() {
			running++;
		},
		runEnd() {
			running = Math.max(0, running - 1);
			return reap();
		},
		get running() { return running; },
		get pending() { return queued.size; },
	};
}
