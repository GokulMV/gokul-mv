/* ==========================================================================
 * Background work — runs time-sliced CPU work (precomputed tables, procedural
 * geometry) in the main thread's idle periods, independent of the frame rate.
 *
 * `runInBackground(step)` calls `step(budgetMs)` from requestIdleCallback
 * with the idle time left (at most `sliceMs`), or one short `forcedSliceMs`
 * slice when the browser has had no idle period for `timeoutMs` (a busy
 * device still makes progress). Browsers without requestIdleCallback (Safari)
 * get `forcedSliceMs` slices on a timer. `step` returns true once the work
 * is done. Nothing here touches React state.
 *
 * Every task stays far below the 50 ms long-task line as long as one
 * indivisible unit of the work (one generator step) is small; the callers
 * keep theirs at a few milliseconds.
 * ========================================================================== */

export interface BackgroundWorkOptions {
  /** Longest slice taken from an idle period (ms). Default 10. */
  sliceMs?: number;
  /** Slice when no idle period came within `timeoutMs`, or without requestIdleCallback (ms). Default 4. */
  forcedSliceMs?: number;
  /** Longest wait for an idle period before a forced slice (ms). Default 200. */
  timeoutMs?: number;
}

type IdleCallbackApi = {
  requestIdleCallback: (cb: (deadline: IdleDeadline) => void, options?: { timeout: number }) => number;
  cancelIdleCallback: (handle: number) => void;
};

/** Starts pumping `step(budgetMs)` until it returns true; returns a cancel function (idempotent). */
export function runInBackground(step: (budgetMs: number) => boolean, options: BackgroundWorkOptions = {}): () => void {
  const sliceMs = options.sliceMs ?? 10;
  const forcedSliceMs = options.forcedSliceMs ?? 4;
  const timeoutMs = options.timeoutMs ?? 200;
  if (typeof window === 'undefined') return () => undefined;
  const idle = 'requestIdleCallback' in window ? (window as unknown as IdleCallbackApi) : null;
  let cancelled = false;
  let idleHandle = 0;
  let timer = 0;

  const run = (deadline: IdleDeadline | null): void => {
    idleHandle = 0;
    timer = 0;
    if (cancelled) return;
    const budget = deadline && !deadline.didTimeout ? Math.min(sliceMs, Math.max(1, deadline.timeRemaining() - 1)) : forcedSliceMs;
    let done = false;
    try {
      done = step(budget);
    } catch (error) {
      console.warn('[backgroundWork] task failed', error);
      done = true;
    }
    if (!done) schedule();
  };

  function schedule(): void {
    if (cancelled) return;
    if (idle) idleHandle = idle.requestIdleCallback(run, { timeout: timeoutMs });
    else timer = window.setTimeout(run, 16, null);
  }

  schedule();
  return () => {
    cancelled = true;
    if (idleHandle && idle) idle.cancelIdleCallback(idleHandle);
    if (timer) window.clearTimeout(timer);
    idleHandle = 0;
    timer = 0;
  };
}

export default runInBackground;
