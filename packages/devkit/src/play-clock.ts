/**
 * Lockstep game clock behind `project play --time-scale`.
 *
 * The clock pauses the App and steps it only when asked: `step(frames)` runs that many
 * whole frames of `stepSeconds`, then returns. The play script asks while it waits, a
 * few frames between two predicate checks, so game time stands still while the script
 * reads state, checks a predicate or sends input, and every check and input edge lands
 * on a deterministic frame whatever the page or evaluation latency is.
 *
 * `scale` is a speed cap, not the pace: a token bucket refilled at `scale` frames per
 * frame of wall time holds a step back while the clock is ahead of `scale` times the
 * wall time. It banks at most `burstFrames` (one game second by default), so slow page
 * evaluations earn back the time of fast ones and the cap bounds the average pace,
 * while game time never runs more than the burst ahead of the line. Each step is one App frame, so
 * the World update, its physics and the input scan at frame start all see the same
 * fixed delta. The last step of a request renders, and so does any step the cap held
 * back (slow motion then shows every frame).
 *
 * `createPlayClock` is embedded as source text into the generated development page, so
 * it must stay self-contained: no imports, no module bindings, no TypeScript-only
 * runtime helpers.
 */

/** The App surface the clock drives. */
export interface PlayClockApp {
  pause(): { readonly ok: boolean };
  resume(): { readonly ok: boolean };
  stepFrame(
    deltaSeconds: number,
    options: { readonly render: boolean },
  ):
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly detail?: { readonly reason?: unknown } };
      };
}

/** Wall clock and waiting of the page. */
export interface PlayClockEnvironment {
  now(): number;
  /** Resolves after about `ms` of wall time (a timer). */
  delay(ms: number): Promise<void>;
  /**
   * Resolves once the page is idle (a posted task). A frame still in flight refuses the
   * next rendering step; the clock retries after this instead of a display frame.
   */
  idle(): Promise<void>;
}

export interface PlayClockStatus {
  readonly running: boolean;
  readonly scale: number;
  readonly stepSeconds: number;
  /** Frames the clock stepped. */
  readonly frames: number;
  /** Game time: stepped frames plus time other callers stepped while it was suspended. */
  readonly gameSeconds: number;
  /** Wall time since the clock started. */
  readonly wallSeconds: number;
  /** Step requests served: one per predicate check or wait chunk. */
  readonly checks: number;
  /** Wall time steps were held back to keep game time within `scale` times wall time. */
  readonly heldSeconds: number;
  readonly error?: string;
}

export interface PlayClock {
  status(): PlayClockStatus;
  /** Stops the clock and resumes the App's own frame loop. */
  stop(): PlayClockStatus;
  /**
   * Marks another caller stepping the App itself (an explicit advance); the returned
   * release adds the seconds that caller stepped to game time.
   */
  suspend(): (steppedSeconds: number) => void;
  /** Steps `frames` whole frames under the speed cap; the status afterwards. */
  step(frames: number): Promise<PlayClockStatus>;
}

/** Starts a clock on a running App. */
export function createPlayClock(
  app: PlayClockApp,
  scale: number,
  stepSeconds: number,
  environment: PlayClockEnvironment,
  burstFrames = Math.round(1 / stepSeconds),
): PlayClock {
  // A refused rendering step retries for at most this long before the clock fails.
  const creditWaitMs = 10_000;
  const paused = app.pause().ok;
  const started = environment.now();
  const stepMs = stepSeconds * 1000;
  let running = true;
  let frames = 0;
  let checks = 0;
  let extraSeconds = 0;
  let heldMs = 0;
  let tokens = burstFrames;
  let refilled = started;
  let error: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const status = (): PlayClockStatus => ({
    running,
    scale,
    stepSeconds,
    frames,
    gameSeconds: frames * stepSeconds + extraSeconds,
    wallSeconds: (environment.now() - started) / 1000,
    checks,
    heldSeconds: heldMs / 1000,
    ...(error === undefined ? {} : { error }),
  });
  const stop = (): PlayClockStatus => {
    if (running) {
      running = false;
      if (paused) app.resume();
    }
    return status();
  };
  const fail = (message: string) => {
    error = message;
    stop();
  };
  const refill = () => {
    const now = environment.now();
    tokens = Math.min(burstFrames, tokens + ((now - refilled) * scale) / stepMs);
    refilled = now;
  };
  const run = async (count: number) => {
    checks += 1;
    for (let index = 0; index < count && running; index += 1) {
      refill();
      let capped = false;
      while (tokens < 1 - 1e-9 && running) {
        const wait = ((1 - tokens) * stepMs) / scale;
        const before = environment.now();
        await environment.delay(Math.max(1, Math.ceil(wait)));
        heldMs += environment.now() - before;
        capped = true;
        refill();
      }
      if (!running) break;
      const render = capped || index === count - 1;
      const deadline = environment.now() + creditWaitMs;
      for (;;) {
        const result = app.stepFrame(stepSeconds, { render });
        if (result.ok) break;
        if (result.error.detail?.reason !== 'credit' || environment.now() > deadline) {
          fail(`${result.error.code} ${JSON.stringify(result.error.detail ?? {})}`);
          return;
        }
        await environment.idle();
        if (!running) return;
      }
      tokens -= 1;
      frames += 1;
    }
  };
  const step = (count: number): Promise<PlayClockStatus> => {
    // Requests run one after another, so concurrent waits never interleave frames.
    const next = queue.then(async () => {
      if (running && Number.isSafeInteger(count) && count > 0) await run(count);
      return status();
    });
    queue = next.catch(() => undefined);
    return next.catch((cause: unknown) => {
      fail(String(cause));
      return status();
    });
  };
  const suspend = () => {
    let released = false;
    return (steppedSeconds: number) => {
      if (released) return;
      released = true;
      extraSeconds += steppedSeconds;
      // Time the other caller stepped does not bank speed-cap credit.
      refilled = environment.now();
    };
  };
  if (!paused) {
    error = 'the App frame loop could not be paused';
    running = false;
  }
  return { status, stop, suspend, step };
}
