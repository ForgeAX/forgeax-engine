/**
 * Host frame-rate limit shared by the main-realm frame loop and the Worker
 * Host. A limited loop still receives every display callback; it admits one
 * only when the limit interval since the previous admission has elapsed,
 * within half a display refresh. Admissions therefore stay on display
 * callbacks and keep an even cadence (every second refresh for 30 FPS on a
 * 60 Hz display) instead of alternating short and long intervals.
 *
 * The pacer only selects which callbacks admit a frame. The admitted frame
 * measures its delta exactly as before, so World time stays the real elapsed
 * time and fixed-step simulation is unchanged.
 */
export interface FramePacer {
  /** `null` admits every callback; otherwise a finite positive frames-per-second limit. */
  setLimit(framesPerSecond: number | null): void;
  limit(): number | null;
  /** Whether a display callback observed at `nowMs` may admit a frame. */
  due(nowMs: number): boolean;
  /** Record an admitted frame at `nowMs`. */
  admitted(nowMs: number): void;
}

/** Validate a public frame-rate limit; `null` removes the limit. */
export function assertFrameRateLimit(framesPerSecond: number | null): void {
  if (framesPerSecond !== null && !(Number.isFinite(framesPerSecond) && framesPerSecond > 0))
    throw new RangeError(
      `frame-rate limit must be null or a finite positive number, got ${String(framesPerSecond)}`,
    );
}

/** No display refreshes faster than 250 Hz; shorter steps are callback jitter. */
const MIN_REFRESH_MS = 4;
const REFRESH_SAMPLES = 15;

export function createFramePacer(): FramePacer {
  let limitFps: number | null = null;
  let intervalMs: number | undefined;
  let lastAdmittedMs: number | undefined;
  // Display refresh estimated as the median of recent consecutive-callback
  // steps. A callback that follows a credit wait spans several refreshes and
  // is not a sample; nor is a step below MIN_REFRESH_MS, which only appears
  // when a delayed callback is followed by an on-time one. A minimum-based
  // estimate collapses on such a pair and leaves no vsync tolerance, so the
  // two-refresh callback misses on clock jitter and the frame lands at 50 ms.
  let lastCallbackMs: number | undefined;
  const steps: number[] = [];
  const sorted: number[] = [];
  let refreshMs: number | undefined;
  const sampleRefresh = (nowMs: number): void => {
    const step = lastCallbackMs === undefined ? 0 : nowMs - lastCallbackMs;
    lastCallbackMs = nowMs;
    if (step < MIN_REFRESH_MS || (intervalMs !== undefined && step >= intervalMs)) return;
    if (steps.length === REFRESH_SAMPLES) steps.shift();
    steps.push(step);
    sorted.length = 0;
    sorted.push(...steps);
    sorted.sort((a, b) => a - b);
    refreshMs = sorted[sorted.length >> 1];
  };
  return {
    setLimit(framesPerSecond) {
      assertFrameRateLimit(framesPerSecond);
      limitFps = framesPerSecond;
      intervalMs = framesPerSecond === null ? undefined : 1_000 / framesPerSecond;
    },
    limit: () => limitFps,
    due(nowMs) {
      sampleRefresh(nowMs);
      if (intervalMs === undefined || lastAdmittedMs === undefined) return true;
      const tolerance = refreshMs === undefined ? intervalMs / 4 : refreshMs / 2;
      return nowMs - lastAdmittedMs >= intervalMs - tolerance;
    },
    admitted(nowMs) {
      lastAdmittedMs = nowMs;
    },
  };
}
