// @forgeax/engine-app -- error fan-out registry + console.error fallback (M4 / w11).
//
// Public surface (consumed only by createApp + frame-loop -- this module
// lives under `internal/` and is not re-exported from the package barrel):
//
//   const fan = new ErrorFanoutRegistry({ silenceUnhandledErrors: false });
//   const off = fan.add(cb);    // add listener; returns idempotent unsubscribe
//   off();                      // remove listener (safe to call twice)
//   fan.fire(err);              // fan out to all listeners; if none AND
//                               // silenceUnhandledErrors !== true, call
//                               // console.error(err)
//
// Wiring (per plan-strategy D-9 + research section 7.3
// createRenderer.ts:532-566 LostListenerRegistry side-evidence):
//
//   - Listener set is a Set so duplicate add() is idempotent (set semantics).
//   - fire() iterates over a snapshot so a listener that calls .add()/.remove()
//     mid-fire does not perturb the iteration.
//   - When the listener set is empty AND silenceUnhandledErrors !== true,
//     console.error(err) is invoked once with the structured error object as
//     the single argument. Tests pin reference equality via mock.calls[0][0]
//     so the AI-user contract (.code / .expected / .hint structure preserved)
//     is observable in browser devtools.
//   - late-attach replay is deliberately NOT implemented. rAF errors are
//     frame-time stream (each tick generates a fresh event); a replay
//     semantic would surface stale state to a freshly registered listener.
//     This is a deliberate divergence from runtime/createRenderer.ts:337-345
//     LostListenerRegistry which DOES replay (because device.lost is a
//     one-shot lifecycle event); see plan-strategy D-9 for the divergence
//     rationale.
//
// Architecture principle SSOT: the listener set + the silence flag are the
// only state owned by this module; createApp passes the silence flag in via
// constructor options and never reads it again, so the SSOT is the Registry
// instance state.

import type { AppDispatchError } from '../types';

/**
 * Listener callback for app-shell error fan-out.
 *
 * The narrow union (`AppDispatchError` = AppError | RhiError | RuntimeError)
 * deliberately excludes raw `Error` (charter P3 explicit failure: AI users
 * walk `.code` not message strings). `RuntimeError` is included so a
 * runtime-layer error fanned out by `Renderer.onError` (e.g.
 * `'equirect-projection-failed'`) reaches host App listeners verbatim
 * (feat-20260531-skybox-env-background F-1). `EngineEnvironmentError` does not
 * appear here because construction-time failure flows through
 * `Promise<Result<App, ...>>` of `createApp(canvas)` before the App handle
 * exists; once an App handle is alive, only frame-time errors (this union)
 * reach onError.
 */
export type ErrorFanoutListener = (err: AppDispatchError) => void;

/**
 * Constructor options for ErrorFanoutRegistry. Mirrors the
 * `silenceUnhandledErrors` field on CreateAppOptions / AppAssembleArgs;
 * createApp threads the field down into the registry verbatim.
 */
export interface ErrorFanoutOptions {
  readonly silenceUnhandledErrors?: boolean;
}

/**
 * ErrorFanoutRegistry shares its shape with the LostListenerRegistry
 * implementation in `packages/runtime/src/createRenderer.ts:532-566` per
 * plan-strategy D-9 -- listener set + fan-out fire + idempotent unsubscribe.
 * The two divergences from the runtime registry are intentional:
 *
 *   1. Late-attach replay is NOT implemented -- rAF errors are a frame-time
 *      stream (each tick produces fresh state) so replay semantics are
 *      meaningless and would mislead newly registered listeners.
 *   2. `console.error(err)` fallback fires when the listener set is empty
 *      and `silenceUnhandledErrors !== true` -- a charter P3 tribute that
 *      makes "unhandled" errors loud rather than silent.
 */
export class ErrorFanoutRegistry {
  private readonly listeners: Set<ErrorFanoutListener> = new Set();
  private readonly silenceUnhandledErrors: boolean;

  constructor(opts: ErrorFanoutOptions = {}) {
    this.silenceUnhandledErrors = opts.silenceUnhandledErrors === true;
  }

  /**
   * Register a listener. Returns an unsubscribe function. Calling
   * unsubscribe more than once is a safe no-op (Set.delete returns
   * false on the second call but does not throw). Re-registering the
   * same listener function is a no-op (Set semantics).
   */
  add(cb: ErrorFanoutListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Iterate over a snapshot of the listener set so a listener that
   * mutates the set mid-fire does not perturb the iteration. When the
   * set is empty AND silenceUnhandledErrors !== true, call
   * console.error(err) so the unhandled error is visible in devtools
   * (charter P3 explicit failure: silent drop is a footgun).
   */
  fire(err: AppDispatchError): void {
    if (this.listeners.size === 0) {
      if (!this.silenceUnhandledErrors) {
        // eslint-disable-next-line no-console -- charter P3 fallback
        console.error(err);
      }
      return;
    }
    const snapshot = Array.from(this.listeners);
    for (const cb of snapshot) {
      cb(err);
    }
  }

  /**
   * Number of currently registered listeners. Reserved for diagnostics +
   * test fixtures (e.g. asserting cleanup paths reach the registry); not
   * part of the public app-shell surface.
   *
   * @internal
   */
  _size(): number {
    return this.listeners.size;
  }
}
