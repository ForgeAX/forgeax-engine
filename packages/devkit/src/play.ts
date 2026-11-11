import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExecutionReport } from '@forgeax/engine-app';
import type { ArtifactRef } from '@forgeax/engine-tool-runtime';
import type { Page } from 'playwright';
import {
  type BrowserCapture,
  type BrowserCaptureRecord,
  type BrowserCaptureSession,
  createBrowserCapture,
  diagnosticCapturePath,
} from './browser-capture.js';
import { type CaptureRendererError, captureRenderFailure } from './capture-render-failure.js';
import { type DistManifest, verifyDist } from './dist.js';
import { type ExecutionHealth, executionHealth } from './execution-health.js';
import { failureSummary } from './failure-summary.js';
import type { StartupUiState } from './host/startup-ui.js';
import { liveOwnerRecorded } from './live-dev-owner.js';
import { clickTargetInPage } from './play-click-target.js';
import type { PlayClockStatus } from './play-clock.js';
import { acquirePlayLock } from './play-lock.js';
import { lookInPage } from './play-look.js';
import {
  DEFAULT_PLAY_VIEWPORTS,
  type PlayViewport,
  parsePlayViewports,
  viewportName,
} from './play-viewports.js';
import {
  groupPlayWarnings,
  type PlayWarning,
  SCENE_PREVIEW_HINT,
  warningsField,
} from './play-warnings.js';
import { readProjectStartupTimeoutMs } from './project.js';
import { DEV_EXECUTION_TIMEOUT_MS } from './startup-budget.js';
import type {
  CaptureBackend,
  CommandError,
  CommandResult,
  ProjectCommandOptions,
} from './types.js';

/** Closed failure codes of `forgeax project play`. */
export type PlayErrorCode =
  | 'play-script-invalid'
  | 'play-not-ready'
  | 'play-step-failed'
  | 'play-timeout'
  | 'play-runtime-failed';

export type PlayScriptInvalidReason = 'missing' | 'import-failed' | 'no-default-export';
/**
 * `busy`: another play of the project held its lock for the whole wait;
 * `lock-unavailable`: the lock file could not be created or inspected.
 */
export type PlayNotReadyReason =
  | 'session-failed'
  | 'startup-failed'
  | 'input-closed'
  | 'busy'
  | 'lock-unavailable'
  /** `--session` found no `forgeax dev start` owner able to host the play. */
  | 'session-unavailable'
  /** `--release` found no built distribution (no readable `forgeax-dist.json`). */
  | 'release-missing'
  /** `--release` found a distribution that does not verify or does not target the browser. */
  | 'release-invalid';
/**
 * Why a playthrough step threw; `script-error` covers assertions and any other script throw.
 * `advance-invalid`: `advance` arguments are out of range; `advance-failed`: the App refused a step.
 * `setup-missing`: a step range starts at a step without `setup`; `range-unmatched`: no
 * top-level step matched the range start, or its end came first. `clock-failed`: under
 * `--time-scale` the page clock refused to start or stopped on an App step error.
 */
export type PlayStepFailureReason =
  | 'script-error'
  | 'wait-timeout'
  | 'state-unavailable'
  | 'advance-invalid'
  | 'advance-failed'
  | 'setup-missing'
  | 'range-unmatched'
  | 'clock-failed';
/** The first final runtime check that failed after a passing script. */
export type PlayRuntimeCheck =
  | 'fatal'
  | 'renderer-error'
  | 'browser-errors'
  | 'flat-canvas'
  | 'ui-missing'
  | 'execution-unhealthy'
  | 'execution-unavailable'
  | 'final-frame-timeout'
  /** `--release`: the page requested a non-local host; play blocked and recorded it. */
  | 'external-request';

/** Canvas-normalized point: `[0, 0]` is the canvas top-left corner, `[1, 1]` its bottom-right. */
export type PlayPoint =
  | readonly [x: number, y: number]
  | { readonly x: number; readonly y: number };

export interface PlayWaitOptions {
  /** Game read projection id; defaults to the only registered read. */
  readonly read?: string;
  /** Default 10000. */
  readonly timeoutMs?: number;
}

export interface PlayAdvanceOptions {
  /** Game seconds per stepped frame, in (0, 0.1]. Default 1/60. */
  readonly stepSeconds?: number;
  /**
   * Default false: frames before the last run the World update only and the last
   * one renders. True renders every stepped frame (much slower), for games whose
   * logic reads the submitted picture (GPU picking, submitted terrain height).
   */
  readonly render?: boolean;
  /** Game read projection id returned afterwards; defaults to the only registered read. */
  readonly read?: string;
}

export interface PlayStepOptions {
  /**
   * Puts the world into the state this step expects when a step range (`--from`,
   * `--steps`) starts here, so the skipped earlier steps need not be replayed, for
   * example with `play.advance` or a development eval. Runs only as the first step of a
   * range; a range cannot start at a later step that has none.
   */
  readonly setup?: (play: PlayContext) => unknown;
}

/**
 * A run of consecutive top-level steps: `from` and `to` each name a step or give its
 * 1-based position among the top-level `play.step` calls; `to` defaults to the last.
 */
export interface PlayStepRange {
  readonly from: string;
  readonly to?: string;
}

export interface PlayScreenshot {
  readonly name: string;
  readonly path: string;
  /**
   * False when the canvas crop is one uniform color (for example a black frame)
   * or a renderer error in the recent frames stopped the canvas from presenting.
   */
  readonly rendered: boolean;
  readonly digest: string;
}

/**
 * The helper passed to a playthrough module's default export. Every input is a
 * real browser event through the game's ordinary input owner; `state` and
 * `waitFor` only read the game's registered projection.
 */
export interface PlayContext {
  /** The game page. Use native Playwright for DOM queries the helpers do not cover. */
  readonly page: Page;
  /**
   * Aborted when the playthrough times out or the command is cancelled. Helpers
   * reject after abort; raw `page` loops should stop on it too.
   */
  readonly signal: AbortSignal;
  /**
   * `true` under `--release` (the built static release). One playthrough serves both
   * runs: `state` and `waitFor` read the registered projection on either; `advance`
   * and `--time-scale` need the development host, so guard them with this flag.
   */
  readonly release: boolean;
  /**
   * Labels the enclosed work; a failure reports the innermost step name. Under a step
   * range, a top-level step outside it does not run and resolves `undefined`, and helpers
   * called between skipped steps send no input; read what a step needs with `state`
   * inside it rather than from an earlier step's return value.
   */
  step<T>(name: string, run: () => Promise<T> | T, options?: PlayStepOptions): Promise<T>;
  /** Reads `gameHost.gameProjection.registerRead({ id, read })`; defaults to the only read. */
  state<T = unknown>(read?: string): Promise<T>;
  /** Polls the read projection until `predicate` is true and returns that state. */
  waitFor<T = unknown>(predicate: (state: T) => boolean, options?: PlayWaitOptions): Promise<T>;
  /**
   * Advances game time by `seconds` (at most 600, at most 36000 frames) without
   * waiting real time: pauses the App, steps whole frames of `stepSeconds` (update
   * only except the last, rendered frame; see `render`), resumes, and returns the
   * read projection. It sends no input; keys or buttons held through the browser
   * stay held for every stepped frame.
   */
  advance<T = unknown>(seconds: number, options?: PlayAdvanceOptions): Promise<T>;
  readonly keyboard: {
    /**
     * Presses one key or chord (`KeyW`, `Space`, `Shift+KeyA`) and holds it until the
     * Engine completes three more frames (at least 50 ms; at most 2 s when frames stall).
     */
    press(key: string): Promise<void>;
    /** Holds keys for `until` milliseconds, or until the state predicate is true (returning it). */
    hold<T = unknown>(
      keys: string | readonly string[],
      until: number | ((state: T) => boolean),
      options?: PlayWaitOptions,
    ): Promise<T | undefined>;
  };
  readonly mouse: {
    /**
     * Presses and releases with the same frame-observed hold as `keyboard.press`. A
     * point covered by page content other than the canvas or a control (an opaque
     * display-only panel) adds a `warnings` entry naming that element.
     */
    click(
      at: PlayPoint,
      options?: { readonly button?: 'left' | 'right' | 'middle' },
    ): Promise<void>;
    /**
     * Moves the cursor to a canvas point. While the page holds pointer lock the game
     * receives only the movement delta, never the position; the report then carries a
     * `warnings` entry.
     */
    move(to: PlayPoint): Promise<void>;
    /**
     * Turns a mouse-look camera by `dx`, `dy` pixels of `movementDelta`, then waits until
     * a frame scan has read it. Under pointer lock the delta goes to the locked element
     * as one pointer move; otherwise the cursor moves by that offset from its last point
     * (a game that looks only while a button is held needs `drag` instead).
     */
    look(dx: number, dy: number): Promise<void>;
    /**
     * Drags with the left button, or `button: 'right'` for right-button look controls.
     * The press, the motion and the release each land in their own Engine frame.
     */
    drag(
      from: PlayPoint,
      to: PlayPoint,
      options?: { readonly button?: 'left' | 'right' | 'middle' },
    ): Promise<void>;
  };
  /** Waits `ms` of game time: wall time by default, stepped frames under `--time-scale`. */
  wait(ms: number): Promise<void>;
  /**
   * Captures the composed page (canvas and DOM UI) into the play output directory.
   * Nothing judges how the frame looks; open the PNG.
   */
  screenshot(name: string): Promise<PlayScreenshot>;
  /** Reloads the page and waits until input is open again. */
  reload(): Promise<void>;
}

export type PlayScript = (play: PlayContext) => unknown;

export interface PlayOptions extends ProjectCommandOptions {
  /** Playthrough module path relative to the project root. */
  readonly script?: string;
  readonly backend?: CaptureBackend;
  readonly headless?: boolean;
  /**
   * `WxH[,WxH...]`, default `1280x720,1280x600`. The script runs in the first
   * viewport; after the final frame passes, the page is resized to each further
   * one for a screenshot under the same final-frame gate.
   */
  readonly viewports?: string;
  /** Require a mounted child under `#game-ui` in the final frame. */
  readonly requireUi?: boolean;
  /** Script budget after input opens. Default 300000. */
  readonly timeoutMs?: number;
  /** Start at this top-level step (name or 1-based position) and run to the end. */
  readonly from?: string;
  /** `a..b`, `a..` or `a`: run only these top-level steps (names or 1-based positions). */
  readonly steps?: string;
  /**
   * Speed cap in game seconds per wall second, default 1 (the App's own real-time loop).
   * Any other value runs the game in lockstep with the script: the App stays paused and
   * steps fixed 1/60 s frames (physics and input included) only while a helper waits;
   * `waitFor` and predicate holds check the state every 3 frames, presses and clicks
   * hold for whole frames, and waits, holds and wait timeouts count game time. On average
   * game time runs at most this many times wall time (within one game second of that
   * line), so slow page evaluations slow the run down instead of changing it. Such a run
   * is not final acceptance.
   */
  readonly timeScale?: number;
  /** Return the complete report instead of the compact summary. */
  readonly detail?: boolean;
  /** Progress lines on stderr: one at start, then at most one per 30 s. Default true. */
  readonly progress?: boolean;
  /**
   * Run in the page of the project's running `forgeax dev start` owner instead of a
   * private browser and dev runtime: the owner reloads its page through its ordinary
   * reload, the script runs there, and the owner keeps running afterwards. The browser
   * backend, headless mode and port are the owner's. Without a running owner the play
   * fails with `play-not-ready` (`session-unavailable`); it never starts one.
   */
  readonly session?: boolean;
  /**
   * Play the built static release instead of the dev runtime: play serves the
   * distribution `forgeax project build` wrote (`--dist`, default `dist`) on its own
   * loopback server and loads it in a private browser. Every request to a host other
   * than this machine is blocked and listed in `externalRequests`; any such request
   * fails the run (`play-runtime-failed`, `external-request`). Input, screenshots,
   * `play.page` and the final frame work as in development. `state`, `waitFor` and
   * `keyboard.hold` predicates read the game's registered read projection, which every
   * build keeps (read-only; shipped builds expose what `registerRead` returns).
   * `advance` needs the development host and fails with `advance-failed`; `--time-scale`
   * and `--session` are refused.
   */
  readonly release?: boolean;
  /** `--release` distribution directory relative to the root. Default `dist`. */
  readonly dist?: string;
  /**
   * `--release` response headers. `isolated` (default) sends COOP/COEP/CORP like
   * `project preview`, so the page is cross-origin isolated; `none` sends none, like a
   * plain static host, and the App takes its non-isolated execution path.
   */
  readonly headers?: ReleaseHeaders;
}

/** The headers play's release server sends; see {@link PlayOptions.headers}. */
export type ReleaseHeaders = 'isolated' | 'none';

/**
 * @internal A page owned by someone else that hosts a play: the `dev start` owner
 * passes one so the play runs in its reloaded page. The play never closes it.
 */
export interface PlaySessionHost {
  /** Returns a freshly loaded page; rejects with the owner's error when it cannot. */
  open(): Promise<BrowserCaptureSession>;
}

export interface PlayStepRecord {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  /** Outside the step range: the step did not run. */
  readonly skipped?: true;
}

/** One closed failure: `reason` narrows per `code`. */
export type PlayFailure = {
  readonly message: string;
  readonly step?: string;
  readonly action?: string;
  readonly screenshot?: string;
  /** The top-level step that was running, the start of a `--from` rerun. */
  readonly rerunFrom?: string;
  /**
   * The failed top-level step is a later step without `setup`, so `--from` cannot start
   * there; the rerun starts at `rerunFrom` when present, else at the first step.
   */
  readonly stepWithoutSetup?: string;
  /** The owning error when another owner (browser capture, project facts) failed. */
  readonly cause?: { readonly code: string; readonly hint?: string; readonly detail?: unknown };
} & (
  | { readonly code: 'play-script-invalid'; readonly reason: PlayScriptInvalidReason }
  | { readonly code: 'play-not-ready'; readonly reason: PlayNotReadyReason }
  | { readonly code: 'play-step-failed'; readonly reason: PlayStepFailureReason }
  | { readonly code: 'play-timeout'; readonly reason: 'timeout' }
  /** The tool runtime's shared cancellation code, not a play-owned one. */
  | { readonly code: 'tool-run-cancelled'; readonly reason: 'cancelled' }
  | { readonly code: 'play-runtime-failed'; readonly reason: PlayRuntimeCheck }
);

export interface PlayReport {
  readonly schemaVersion: '1.1.0';
  readonly passed: boolean;
  /**
   * `private`: a temporary dev runtime and browser; `session`: the `dev start` owner's
   * page; `release`: the built static distribution on play's own server.
   */
  readonly mode: 'private' | 'session' | 'release';
  /** `release`: the distribution directory relative to the root. */
  readonly dist?: string;
  /** `release`: the headers play's server sent. */
  readonly headers?: ReleaseHeaders;
  /**
   * `release`: requests to non-local hosts, blocked and failing the run (each URL
   * clipped, at most 10 listed, then `+N more`).
   */
  readonly externalRequests?: readonly string[];
  readonly root: string;
  readonly script: string;
  readonly outputDir: string;
  readonly report: string;
  readonly captureReport?: string;
  readonly url?: string;
  readonly backend?: string;
  readonly timings: {
    /** Time spent waiting for another play of the project. */
    readonly lockMs?: number;
    readonly openMs?: number;
    readonly readyMs?: number;
    readonly scriptMs?: number;
    readonly verifyMs?: number;
    readonly totalMs: number;
  };
  readonly steps: readonly PlayStepRecord[];
  readonly screenshots: readonly PlayScreenshot[];
  readonly viewports: readonly string[];
  readonly returned?: unknown;
  readonly state?: unknown;
  readonly execution?: ExecutionHealth | 'unavailable';
  /** The latest renderer error seen by any capture of this run, even an old one. */
  readonly rendererError?: CaptureRendererError;
  readonly errors: {
    readonly console: readonly string[];
    readonly page: readonly string[];
    readonly inputWarnings: number;
  };
  /**
   * Advisory script-usage warnings (a cursor move while the page held pointer lock, a
   * click off the game canvas). Grouped by kind, in the order first seen, with the occurrence count and the screenshots it hit; the
   * compact result and failure detail carry the same shape, trimmed to a byte budget.
   */
  readonly warnings?: readonly PlayWarning[];
  readonly log: readonly string[];
  /** The step range this run was limited to. */
  readonly range?: PlayStepRange;
  /** Game seconds per wall second the script ran at; 1 is the App's real-time loop. */
  readonly timeScale?: number;
  /** The lockstep clock behind a time scale other than 1, as it stopped. */
  readonly clock?: PlayClockReport;
  /**
   * False when the run cannot stand as final acceptance, with `nonFinal` naming why: a
   * step range skipped part of the journey, or a time scale other than 1 replaced the
   * real-time loop. Absent for a complete real-time run.
   */
  readonly final?: false;
  readonly nonFinal?: readonly string[];
  readonly failure?: PlayFailure;
}

const PRESS_MS = 50;
/** Frames an input must stay held so the frame-start scan observes it. */
const INPUT_FRAMES = 3;
const INPUT_FRAME_WAIT_MS = 2_000;
/** Frames a drag waits after its press and after its motion. */
const DRAG_FRAMES = 2;
/** Intermediate pointer moves in one drag. */
const DRAG_STEPS = 3;
const POINTER_FRAME_POLL_MS = 16;
const EVALUATE_MS = 5_000;
const WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
const SCRIPT_TIMEOUT_MS = 300_000;
const FINAL_FRAME_TIMEOUT_MS = 15_000;
const MAX_STEPS = 500;
const MAX_ADVANCE_SECONDS = 600;
const MAX_ADVANCE_FRAMES = 36_000;
/** ECS Time clamps one frame delta to 0.1 s by default; a longer step would drop game time. */
const MAX_ADVANCE_STEP_SECONDS = 0.1;
const ADVANCE_TIMEOUT_MS = 120_000;
const MAX_LOG_LINES = 200;
const SUMMARY_BYTES = 320;
/** Recorded once when `mouse.move` runs while the page holds pointer lock. */
export const POINTER_LOCK_MOVE_WARNING =
  'mouse.move ran under pointer lock: the game read a movement delta, not a cursor position. A cursor-aimed game calls gameHost.setPointerLockAllowed(false).';

/** Recorded when `mouse.click` lands on page content that is neither the canvas nor a control. */
export function clickBlockedWarning(at: PlayPoint, target: string): string {
  return `mouse.click ${JSON.stringify(at)} hit ${target}, not the game canvas, so the game did not receive it. Display-only UI is click-through by default: drop its pointer-events: auto, or make it a button or data-ui-action element if it is a control.`;
}

export {
  PLAY_WARNING_BYTES,
  PLAY_WARNING_KINDS,
  type PlayWarning,
  SCENE_PREVIEW_HINT,
  warningsField,
} from './play-warnings.js';

/** External request URLs kept in the report, each clipped. */
const MAX_EXTERNAL_REQUESTS = 10;

/** Thrown by helpers used after the playthrough was aborted. */
class PlayAbortedError extends Error {
  constructor() {
    super('The playthrough was aborted; helpers no longer drive the page.');
    this.name = 'PlayAbortedError';
  }
}

class PlayHelperError extends Error {
  constructor(
    readonly reason: Exclude<PlayStepFailureReason, 'script-error'>,
    message: string,
    readonly state?: unknown,
  ) {
    super(message);
    this.name = 'PlayHelperError';
  }
}

function playError(
  code: PlayFailure['code'],
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CommandError {
  return { code, expected, hint, detail };
}

/** Clips to at most `max` UTF-8 bytes, so byte budgets hold for CJK text and paths too. */
function clip(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let output = '';
  let bytes = 0;
  // `…` is three bytes.
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max - 3) break;
    output += char;
    bytes += size;
  }
  return `${output}…`;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function shallow(value: unknown): unknown {
  if (typeof value === 'string') return clip(value, 60);
  if (value === null || typeof value !== 'object') return value;
  if (jsonBytes(value) <= 60) return value;
  return Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`;
}

/**
 * Bounded projection of a game state or script return value for the compact
 * result: scalars are kept, large nested values collapse to their size, and
 * keys beyond the byte budget are counted instead of listed.
 */
export function summarizeValue(value: unknown, maxBytes = SUMMARY_BYTES): unknown {
  const safe = jsonSafe(value);
  if (jsonBytes(safe) <= maxBytes) return safe;
  if (safe === null || typeof safe !== 'object') return shallow(safe);
  const entries: Array<[string, unknown]> = Array.isArray(safe)
    ? safe.map((item, index) => [String(index), item])
    : Object.entries(safe);
  const output: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, item] of entries) {
    const next = { ...output, [key]: shallow(item) };
    if (jsonBytes(next) > maxBytes - 16) break;
    output[key] = shallow(item);
    kept += 1;
  }
  if (kept < entries.length) output['…'] = `+${entries.length - kept}`;
  return Array.isArray(safe) ? Object.values(output) : output;
}

function pointXY(point: PlayPoint): { readonly x: number; readonly y: number } {
  const [x, y] = Array.isArray(point)
    ? point
    : [(point as { readonly x: number }).x, (point as { readonly y: number }).y];
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(
      `play point must be canvas-normalized [x, y]; got ${JSON.stringify(point)}`,
    );
  }
  return { x, y };
}

type InputGate =
  | { readonly state: 'open' }
  | { readonly state: 'fatal'; readonly message: string }
  | { readonly state: 'closed' };

/** Waits for the generated startup owner's `<html data-forgeax-input="open">` or a fatal. */
async function waitForInputOpen(page: Page, timeoutMs: number): Promise<InputGate> {
  try {
    const handle = await page.waitForFunction(
      () => {
        const startup = (
          Reflect.get(globalThis, '__forgeaxStartup') as { inspect?(): StartupUiState } | undefined
        )?.inspect?.();
        if (startup?.phase === 'failed' && startup.recovery !== 'retrying')
          return (startup.diagnostics || startup.message || 'Engine startup failed').slice(
            0,
            2_000,
          );
        const fatal = document.querySelector('#forgeax-fatal');
        if (startup === undefined && fatal?.checkVisibility())
          return (
            document.querySelector('#forgeax-fatal-details')?.textContent?.trim() ||
            fatal.textContent?.trim() ||
            'Engine startup failed'
          ).slice(0, 2_000);
        return document.documentElement.dataset.forgeaxInput === 'open';
      },
      undefined,
      { timeout: timeoutMs, polling: 100 },
    );
    const value: unknown = await handle.jsonValue();
    await handle.dispose();
    return typeof value === 'string' ? { state: 'fatal', message: value } : { state: 'open' };
  } catch {
    return { state: 'closed' };
  }
}

/** Fixed frame length of the lockstep page clock behind a time scale other than 1. */
export const PLAY_CLOCK_STEP_SECONDS = 1 / 60;
/**
 * Frames the lockstep clock steps between two predicate checks of `waitFor` / `hold`:
 * the game-time granularity of the real-time poll (50 ms).
 */
export const LOCKSTEP_CHECK_FRAMES = 3;
/** Frames one lockstep wait request steps at most (one game second). */
const LOCKSTEP_WAIT_FRAMES = 60;
/** `--time-scale` bounds: slow motion down to 1/16, fast-forward up to 16 times. */
export const MAX_TIME_SCALE = 16;
const MIN_TIME_SCALE = 1 / 16;

/** Why a `--time-scale` value is unusable, or undefined. */
export function timeScaleError(scale: number): string | undefined {
  if (!Number.isFinite(scale) || scale < MIN_TIME_SCALE || scale > MAX_TIME_SCALE)
    return `--time-scale must be a number from ${MIN_TIME_SCALE} to ${MAX_TIME_SCALE}; got ${scale}`;
  return undefined;
}

type PlayClockRequest =
  | { readonly action: 'start'; readonly scale: number; readonly stepSeconds: number }
  | { readonly action: 'status' | 'stop' };

/** One call of the page clock; null when the page exposes none. */
async function readPlayClock(
  page: Page,
  request: PlayClockRequest,
): Promise<PlayClockStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(async (value: PlayClockRequest) => {
        const inspection = (
          globalThis as {
            __forgeaxGameInspection?: { clock?(request: unknown): unknown };
          }
        ).__forgeaxGameInspection;
        return ((await inspection?.clock?.(value)) ?? null) as PlayClockStatus | null;
      }, request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`page evaluation exceeded ${EVALUATE_MS} ms`)),
          EVALUATE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Starts the page clock; the status, or why it could not start. */
async function startPlayClock(page: Page, scale: number): Promise<PlayClockStatus | string> {
  const status = await readPlayClock(page, {
    action: 'start',
    scale,
    stepSeconds: PLAY_CLOCK_STEP_SECONDS,
  }).catch(
    (cause: unknown) => `Starting the play clock failed: ${clip(failureSummary(cause), 300)}`,
  );
  if (typeof status === 'string') return status;
  if (status === null)
    return 'The game inspection exposes no play clock; --time-scale runs only on a development host.';
  if (!status.running)
    return `The play clock did not start: ${clip(status.error ?? 'unknown reason', 300)}`;
  return status;
}

/** Returns why `advance(seconds, { stepSeconds })` is out of range, or undefined. */
function advanceRangeError(seconds: number, stepSeconds: number): string | undefined {
  if (!(seconds > 0 && seconds <= MAX_ADVANCE_SECONDS))
    return `advance seconds must be in (0, ${MAX_ADVANCE_SECONDS}]; got ${seconds}`;
  if (!(stepSeconds > 0 && stepSeconds <= MAX_ADVANCE_STEP_SECONDS))
    return `advance stepSeconds must be in (0, ${MAX_ADVANCE_STEP_SECONDS}]; got ${stepSeconds}`;
  if (Math.ceil(seconds / stepSeconds - 1e-9) > MAX_ADVANCE_FRAMES)
    return `advance would step more than ${MAX_ADVANCE_FRAMES} frames; raise stepSeconds`;
  return undefined;
}

/** The page clock of a `--time-scale` run, read when the script ended. */
export interface PlayClockReport {
  readonly stepSeconds: number;
  /** Fixed frames the clock stepped (advance frames are counted in gameSeconds only). */
  readonly frames: number;
  readonly gameSeconds: number;
  readonly wallSeconds: number;
  /** Step requests: one per predicate check or wait chunk. */
  readonly checks: number;
  /** Wall time the speed cap held steps back; near zero means the script set the pace. */
  readonly heldSeconds: number;
}

type PageAdvanceResult =
  | { readonly ok: true; readonly frames: number }
  | { readonly ok: false; readonly frames: number; readonly error: string };

/** @internal */
export interface PlayRecorder {
  readonly steps: PlayStepRecord[];
  readonly screenshots: PlayScreenshot[];
  readonly log: string[];
  readonly warnings: string[];
  step: string | undefined;
  action: string | undefined;
  readonly failedStep: WeakMap<object, string>;
  /** Present for a step-range run. */
  readonly range?: PlayRangeTracker;
  /** The top-level step running when the script failed. */
  failedTop?: string | undefined;
  /** That step is a later step without setup: `--from` cannot start there. */
  failedTopWithoutSetup?: boolean;
  /** Present for a time scale other than 1: the page clock rate and its last status. */
  timeScale?: number;
  clock?: PlayClockStatus | undefined;
  /** The page is a release build: development inspection is absent by design. */
  release?: boolean;
}

/** @internal Progress of a step-range run through the top-level steps. */
export interface PlayRangeTracker {
  readonly range: PlayStepRange;
  phase: 'before' | 'in' | 'after';
  /** Top-level `play.step` calls so far. */
  index: number;
  /** Their names, in order, for the unmatched-range message. */
  readonly seen: string[];
  /** The step the range started at. */
  start?: { readonly name: string; readonly index: number };
}

/** Ends a step-range run at the first top-level step or helper after the range. */
class PlayRangeEnd extends Error {
  constructor() {
    super('The step range ended.');
    this.name = 'PlayRangeEnd';
  }
}

const POSITION = /^[1-9]\d*$/;

const selects = (selector: string, name: string, index: number) =>
  POSITION.test(selector) ? Number(selector) === index : selector === name;

/** Reads `--from` or `--steps` into a range; `undefined` for a complete run. */
export function parsePlayStepRange(options: {
  readonly from?: string;
  readonly steps?: string;
}):
  | { readonly ok: true; readonly value?: PlayStepRange }
  | { readonly ok: false; readonly message: string } {
  const { from, steps } = options;
  if (from !== undefined && steps !== undefined)
    return { ok: false, message: 'Pass either --from or --steps, not both.' };
  if (from !== undefined)
    return from.trim() === ''
      ? { ok: false, message: '--from needs a step name or 1-based position.' }
      : { ok: true, value: { from: from.trim() } };
  if (steps === undefined) return { ok: true };
  const split = steps.indexOf('..');
  const start = (split < 0 ? steps : steps.slice(0, split)).trim();
  const end = (split < 0 ? steps : steps.slice(split + 2)).trim();
  if (start === '' && end === '')
    return { ok: false, message: '--steps needs a..b, a.. or a (names or 1-based positions).' };
  if (POSITION.test(start) && POSITION.test(end) && Number(end) < Number(start))
    return { ok: false, message: `--steps ${steps} ends before it starts.` };
  return {
    ok: true,
    value: { from: start === '' ? '1' : start, ...(end === '' ? {} : { to: end }) },
  };
}

/** `a..b` for a range, the form `--steps` takes. */
export function stepRangeLabel(range: PlayStepRange): string {
  return range.to === undefined ? `${range.from}..` : `${range.from}..${range.to}`;
}

/** @internal Exported for helper unit tests; `playCommand` is the public entry. */
export function createPlayContext(
  session: BrowserCaptureSession,
  recorder: PlayRecorder,
  outputDir: string,
  startupTimeoutMs: number,
  signal: AbortSignal = new AbortController().signal,
): PlayContext {
  const page = session.page;
  let defaultRead: string | undefined;
  const live = () => {
    if (signal.aborted) throw new PlayAbortedError();
  };
  const tracker = recorder.range;
  /** Top-level steps of a complete run so far. */
  let topSteps = 0;
  /**
   * Records the action; true when it must not run because a step range has not started
   * yet (between skipped top-level steps). After the range it ends the script.
   */
  const act = (action: string): boolean => {
    live();
    if (tracker !== undefined && recorder.step === undefined) {
      if (tracker.phase === 'after') throw new PlayRangeEnd();
      if (tracker.phase === 'before') return true;
    }
    recorder.action = recorder.step === undefined ? action : `${recorder.step}: ${action}`;
    return false;
  };
  /** One page evaluation bounded by `timeoutMs`, so a stalled realm cannot outlive a wait. */
  const evaluate = async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A, timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.evaluate(fn as never, arg) as Promise<R>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`page evaluation exceeded ${timeoutMs} ms`)),
            Math.max(1, timeoutMs),
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const resolveRead = async (read: string | undefined, timeoutMs: number): Promise<string> => {
    if (read !== undefined) return read;
    if (defaultRead !== undefined) return defaultRead;
    const reads = await evaluate(
      async () => {
        const inspection = (globalThis as { __forgeaxGameInspection?: { list(): unknown } })
          .__forgeaxGameInspection;
        const listed = (await inspection?.list()) as { readonly reads?: unknown } | undefined;
        return Array.isArray(listed?.reads) ? (listed.reads as string[]) : null;
      },
      undefined,
      timeoutMs,
    );
    if (reads === null)
      throw new PlayHelperError(
        'state-unavailable',
        'The game inspection is unavailable; the game registers its read projection with gameHost.gameProjection.registerRead({ id, read }).',
      );
    if (reads.length !== 1)
      throw new PlayHelperError(
        'state-unavailable',
        reads.length === 0
          ? 'The game registers no read projection. Register one with gameHost.gameProjection.registerRead({ id, read }).'
          : `Several read projections are registered (${reads.join(', ')}); pass the id.`,
      );
    defaultRead = reads[0] as string;
    return defaultRead;
  };
  const readState = async <T>(read: string | undefined, timeoutMs = EVALUATE_MS): Promise<T> => {
    live();
    const id = await resolveRead(read, timeoutMs);
    try {
      return (await evaluate(
        async (selected: string) =>
          (
            Reflect.get(globalThis, '__forgeaxGameInspection') as {
              read(id: string): unknown;
            }
          ).read(selected),
        id,
        timeoutMs,
      )) as T;
    } catch (cause) {
      live();
      throw new PlayHelperError(
        'state-unavailable',
        `Reading game projection ${id} failed: ${clip(failureSummary(cause), 300)}`,
      );
    }
  };
  const scale = recorder.timeScale ?? 1;
  /** Whole fixed frames covering `ms` of game time. */
  const framesFor = (ms: number) =>
    Math.max(0, Math.ceil(ms / 1000 / PLAY_CLOCK_STEP_SECONDS - 1e-9));
  /**
   * Lockstep under a time scale: steps `frames` frames on the page clock and, in the same
   * evaluation, reads projection `read`. The App stays paused around the call.
   */
  const stepClock = async (frames: number, read?: string): Promise<unknown> => {
    live();
    const wallMs = (frames * PLAY_CLOCK_STEP_SECONDS * 1000) / scale;
    const result = await evaluate(
      async (request: { frames: number; read: string | undefined }) => {
        const inspection = (
          globalThis as {
            __forgeaxGameInspection?: {
              clock?(request: unknown): unknown;
              read(id: string): unknown;
            };
          }
        ).__forgeaxGameInspection;
        const status = (await inspection?.clock?.({ action: 'step', frames: request.frames })) as
          | PlayClockStatus
          | undefined;
        if (status?.running !== true || request.read === undefined) return { status };
        try {
          return { status, state: await inspection?.read(request.read) };
        } catch (cause) {
          return { status, readError: String(cause) };
        }
      },
      { frames, read },
      EVALUATE_MS + wallMs,
    ).catch((cause: unknown) => {
      live();
      throw new PlayHelperError(
        'clock-failed',
        `Stepping the play clock failed: ${clip(failureSummary(cause), 300)}`,
      );
    });
    const { status, state, readError } = result as {
      status?: PlayClockStatus;
      state?: unknown;
      readError?: string;
    };
    if (status?.running !== true)
      throw new PlayHelperError(
        'clock-failed',
        status?.error === undefined
          ? 'The play clock is not running.'
          : `The play clock stopped: ${clip(status.error, 300)}`,
      );
    recorder.clock = status;
    if (readError !== undefined)
      throw new PlayHelperError(
        'state-unavailable',
        `Reading game projection ${read} failed: ${clip(readError, 300)}`,
      );
    return state;
  };
  /** Waits `ms` of game time: wall time on the real-time loop, stepped frames otherwise. */
  const sleep = async (ms: number) => {
    if (scale === 1) {
      await page.waitForTimeout(ms);
      return;
    }
    for (let left = framesFor(ms); left > 0; left -= LOCKSTEP_WAIT_FRAMES)
      await stepClock(Math.min(left, LOCKSTEP_WAIT_FRAMES));
  };
  const waitForState = async <T>(
    predicate: (state: T) => boolean,
    options: PlayWaitOptions = {},
  ): Promise<T> => {
    const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
    // Each read keeps its own bound: a read near the deadline must report the
    // wait timeout with the last state, not a starved evaluation.
    let last: T = await readState<T>(options.read);
    if (scale !== 1) {
      // Lockstep: the timeout counts game time, and the predicate sees the state after
      // every LOCKSTEP_CHECK_FRAMES frames however long a page evaluation takes.
      const id = await resolveRead(options.read, EVALUATE_MS);
      const limit = framesFor(timeoutMs);
      for (let stepped = 0; !predicate(last); ) {
        if (stepped >= limit)
          throw new PlayHelperError(
            'wait-timeout',
            `State predicate stayed false for ${timeoutMs} ms of game time`,
            last,
          );
        const frames = Math.min(LOCKSTEP_CHECK_FRAMES, limit - stepped);
        last = (await stepClock(frames, id)) as T;
        stepped += frames;
      }
      return last;
    }
    const deadline = Date.now() + timeoutMs;
    while (!predicate(last)) {
      if (Date.now() >= deadline)
        throw new PlayHelperError(
          'wait-timeout',
          `State predicate stayed false for ${timeoutMs} ms`,
          last,
        );
      await page.waitForTimeout(POLL_MS);
      last = await readState<T>(options.read);
    }
    return last;
  };
  const completedFrame = () =>
    evaluate(
      () => {
        const inspection = (
          globalThis as {
            __forgeaxGameInspection?: {
              renderer?(): { execution?: { frame?: { completed?: unknown } } };
            };
          }
        ).__forgeaxGameInspection;
        const completed = inspection?.renderer?.().execution?.frame?.completed;
        return typeof completed === 'number' ? completed : null;
      },
      undefined,
      EVALUATE_MS,
    ).catch(() => null);
  /**
   * Keeps an input held until the Engine completes `frames` more frames (and at least
   * `minMs`). Two frames guarantee one frame-start input scan after the event.
   */
  const holdForFrames = async (frames = INPUT_FRAMES, minMs = PRESS_MS) => {
    // Lockstep: the frames themselves are stepped, so the edges land on fixed frames.
    if (scale !== 1) {
      await stepClock(Math.max(frames, framesFor(minMs)));
      return;
    }
    const start = await completedFrame();
    if (minMs > 0) await page.waitForTimeout(minMs);
    if (start === null) return;
    const deadline = Date.now() + INPUT_FRAME_WAIT_MS;
    while (Date.now() < deadline && !signal.aborted) {
      const now = await completedFrame();
      if (now === null || now >= start + frames) return;
      await page.waitForTimeout(POINTER_FRAME_POLL_MS);
    }
  };
  /** Last viewport cursor position this context moved to; relative looks continue from it. */
  let cursor: { x: number; y: number } | undefined;
  /** Releases held inputs without masking the error that ended the hold. */
  const release = async (actions: readonly (() => Promise<void>)[]) => {
    for (const action of actions) await action().catch(() => undefined);
  };
  const chord = (key: string) => (key === '+' ? ['+'] : key.split('+'));
  const canvasPoint = async (point: PlayPoint) => {
    const { x, y } = pointXY(point);
    const box = await page.locator('canvas#app, canvas').first().boundingBox();
    if (box === null) throw new TypeError('The game canvas is not visible');
    return { x: box.x + x * box.width, y: box.y + y * box.height };
  };
  const runStep = async <T>(
    name: string,
    run: () => Promise<T> | T,
    setup?: () => unknown,
  ): Promise<T> => {
    const parent = recorder.step;
    const path = parent === undefined ? name : `${parent} > ${name}`;
    recorder.step = path;
    const started = Date.now();
    const record = (ok: boolean) => {
      if (recorder.steps.length < MAX_STEPS)
        recorder.steps.push({ name: path, ok, ms: Date.now() - started });
    };
    try {
      if (setup !== undefined) await runStep('setup', setup);
      const value = await run();
      record(true);
      return value;
    } catch (error) {
      record(false);
      if (error !== null && typeof error === 'object' && !recorder.failedStep.has(error))
        recorder.failedStep.set(error, path);
      throw error;
    } finally {
      recorder.step = parent;
    }
  };
  /** A top-level `play.step` under a step range: skip, start with setup, run, or end. */
  const rangeStep = async <T>(
    range: PlayRangeTracker,
    name: string,
    run: () => Promise<T> | T,
    options: PlayStepOptions,
  ): Promise<T> => {
    if (range.phase === 'after') throw new PlayRangeEnd();
    range.index += 1;
    const index = range.index;
    if (range.seen.length < MAX_STEPS) range.seen.push(name);
    const { from, to } = range.range;
    const ends = to !== undefined && selects(to, name, index);
    let setup: (() => unknown) | undefined;
    if (range.phase === 'before') {
      if (!selects(from, name, index)) {
        if (ends)
          throw new PlayHelperError(
            'range-unmatched',
            `The step range ends at step "${name}" (#${index}) before its start ${from} was reached.`,
          );
        if (recorder.steps.length < MAX_STEPS)
          recorder.steps.push({ name, ok: true, ms: 0, skipped: true });
        return undefined as T;
      }
      range.phase = 'in';
      range.start = { name, index };
      if (index > 1) {
        const hook = options.setup;
        if (hook === undefined)
          throw new PlayHelperError(
            'setup-missing',
            `Step "${name}" (#${index}) has no setup, so a step range cannot start there: the skipped steps would leave the world in the wrong state. Pass one as play.step(${JSON.stringify(name)}, run, { setup: async (play) => { /* reach the state this step expects, for example play.advance(...) */ } }), or start the range at an earlier step.`,
          );
        setup = () => hook(context);
      }
    }
    recorder.failedTop = undefined;
    try {
      return await runStep(name, run, setup);
    } catch (error) {
      if (!(error instanceof PlayRangeEnd)) {
        recorder.failedTop = name;
        recorder.failedTopWithoutSetup = index > 1 && options.setup === undefined;
      }
      throw error;
    } finally {
      if (ends) range.phase = 'after';
    }
  };
  const step = async <T>(
    name: string,
    run: () => Promise<T> | T,
    options: PlayStepOptions = {},
  ): Promise<T> => {
    live();
    if (recorder.step !== undefined) return await runStep(name, run);
    if (tracker !== undefined) return await rangeStep(tracker, name, run, options);
    topSteps += 1;
    const later = topSteps > 1 && options.setup === undefined;
    try {
      return await runStep(name, run);
    } catch (error) {
      recorder.failedTop = name;
      recorder.failedTopWithoutSetup = later;
      throw error;
    }
  };
  /** Steps the paused App inside one page evaluation, then resumes it. */
  const advanceTime = async (seconds: number, stepSeconds: number, render: boolean) => {
    const range = advanceRangeError(seconds, stepSeconds);
    if (range !== undefined) throw new PlayHelperError('advance-invalid', range);
    if (recorder.release === true)
      throw new PlayHelperError(
        'advance-failed',
        'advance steps the App through development-only inspection, which a release build omits; drive time with real input and play.wait in --release.',
      );
    const result = await evaluate(
      async (request) => {
        const inspection = (
          globalThis as {
            __forgeaxGameInspection?: { advance?(request: unknown): Promise<PageAdvanceResult> };
          }
        ).__forgeaxGameInspection;
        return (await inspection?.advance?.(request)) ?? null;
      },
      { seconds, stepSeconds, render, timeoutMs: ADVANCE_TIMEOUT_MS },
      ADVANCE_TIMEOUT_MS + EVALUATE_MS,
    ).catch((cause: unknown) => {
      live();
      throw new PlayHelperError(
        'advance-failed',
        `advance failed: ${clip(failureSummary(cause), 300)}`,
      );
    });
    if (result === null)
      throw new PlayHelperError(
        'advance-failed',
        'The game inspection exposes no advance; play advances time only on a development host.',
      );
    if (!result.ok)
      throw new PlayHelperError(
        'advance-failed',
        `advance stopped after ${result.frames} frames: ${clip(result.error, 300)}`,
      );
  };
  const context: PlayContext = {
    page,
    signal,
    release: recorder.release === true,
    step,
    async state(read) {
      act(`state ${read ?? ''}`.trim());
      return await readState(read);
    },
    async waitFor(predicate, options) {
      // Before a step range the world is not where the full journey would be: no wait.
      if (act(`waitFor ${options?.read ?? ''}`.trim())) return await readState(options?.read);
      return await waitForState(predicate, options);
    },
    async advance(seconds, options = {}) {
      if (act(`advance ${seconds} s`)) return undefined as never;
      return await runStep(`advance ${seconds} s`, async () => {
        await advanceTime(seconds, options.stepSeconds ?? 1 / 60, options.render === true);
        return await readState(options.read);
      });
    },
    keyboard: {
      async press(key) {
        if (act(`keyboard.press ${key}`)) return;
        const keys = chord(key);
        try {
          for (const part of keys) await page.keyboard.down(part);
          await holdForFrames();
        } finally {
          await release(keys.reverse().map((part) => () => page.keyboard.up(part)));
        }
      },
      async hold(keys, until, options) {
        const list = typeof keys === 'string' ? [keys] : [...keys];
        if (act(`keyboard.hold ${list.join('+')}`)) return undefined;
        try {
          for (const key of list) await page.keyboard.down(key);
          if (typeof until === 'number') {
            await sleep(until);
            return undefined;
          }
          return await waitForState(until, options);
        } finally {
          await release(list.reverse().map((key) => () => page.keyboard.up(key)));
        }
      },
    },
    mouse: {
      async click(at, options) {
        if (act(`mouse.click ${JSON.stringify(at)}`)) return;
        const point = await canvasPoint(at);
        const button = options?.button === undefined ? {} : { button: options.button };
        await page.mouse.move(point.x, point.y);
        cursor = point;
        const blocker = await evaluate(clickTargetInPage, point, EVALUATE_MS).catch(() => null);
        if (blocker !== null) {
          const warning = clickBlockedWarning(at, blocker);
          if (!recorder.warnings.includes(warning)) recorder.warnings.push(warning);
        }
        try {
          await page.mouse.down(button);
          await holdForFrames();
        } finally {
          await release([() => page.mouse.up(button)]);
        }
      },
      async move(to) {
        if (act(`mouse.move ${JSON.stringify(to)}`)) return;
        const point = await canvasPoint(to);
        await page.mouse.move(point.x, point.y, { steps: 4 });
        cursor = point;
        const locked = await evaluate(
          () => document.pointerLockElement !== null,
          undefined,
          EVALUATE_MS,
        ).catch(() => false);
        if (locked && !recorder.warnings.includes(POINTER_LOCK_MOVE_WARNING))
          recorder.warnings.push(POINTER_LOCK_MOVE_WARNING);
      },
      async drag(from, to, options) {
        if (act(`mouse.drag ${JSON.stringify(from)} -> ${JSON.stringify(to)}`)) return;
        const button = options?.button === undefined ? {} : { button: options.button };
        const start = await canvasPoint(from);
        const end = await canvasPoint(to);
        await page.mouse.move(start.x, start.y);
        try {
          await page.mouse.down(button);
          // A frame scan sees the press before the motion, and the motion before the
          // release; frame-observed, not the timed hold of a click.
          await holdForFrames(DRAG_FRAMES, 0);
          await page.mouse.move(end.x, end.y, { steps: DRAG_STEPS });
          cursor = end;
          await holdForFrames(DRAG_FRAMES, 0);
        } finally {
          await release([() => page.mouse.up(button)]);
        }
      },
      async look(dx, dy) {
        if (act(`mouse.look ${dx},${dy}`)) return;
        if (!Number.isFinite(dx) || !Number.isFinite(dy))
          throw new TypeError('mouse.look takes finite pixel deltas');
        // Under pointer lock the cursor has no position: deliver the delta itself.
        const locked = await evaluate(lookInPage, { dx, dy }, EVALUATE_MS).catch(() => false);
        if (!locked) {
          const from = cursor ?? (await canvasPoint([0.5, 0.5]));
          cursor = { x: from.x + dx, y: from.y + dy };
          await page.mouse.move(from.x, from.y);
          await page.mouse.move(cursor.x, cursor.y);
        }
        await holdForFrames(DRAG_FRAMES, 0);
      },
    },
    async wait(ms) {
      if (act(`wait ${ms}`)) return;
      await sleep(ms);
    },
    async screenshot(name) {
      // Not input: a screenshot between skipped steps still captures the current frame.
      act(`screenshot ${name}`);
      return takeScreenshot(session, recorder, outputDir, name);
    },
    async reload() {
      if (act('reload')) return;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: startupTimeoutMs });
      const gate = await waitForInputOpen(page, startupTimeoutMs);
      if (gate.state !== 'open')
        throw new Error(
          gate.state === 'fatal'
            ? `Reload failed: ${clip(gate.message, 300)}`
            : `Input stayed closed for ${startupTimeoutMs} ms after reload`,
        );
      // The reload dropped the page clock; the new page runs at the same scale.
      if (scale !== 1) {
        const restarted = await startPlayClock(page, scale);
        if (typeof restarted === 'string') throw new PlayHelperError('clock-failed', restarted);
        recorder.clock = restarted;
      }
    },
  };
  return context;
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'shot';
}

async function takeScreenshot(
  session: BrowserCaptureSession,
  recorder: PlayRecorder,
  outputDir: string,
  name: string,
  purpose: 'observe' | 'validate' = 'observe',
  requireUi = false,
): Promise<PlayScreenshot> {
  const index = recorder.screenshots.length + 1;
  const output = resolve(outputDir, `${String(index).padStart(2, '0')}-${slug(name)}.png`);
  const record = await session.capture(undefined, {
    purpose,
    output,
    requireUi,
    timeoutMs: purpose === 'validate' ? FINAL_FRAME_TIMEOUT_MS : 30_000,
  });
  return pushScreenshot(recorder, name, record);
}

function pushScreenshot(
  recorder: PlayRecorder,
  name: string,
  record: BrowserCaptureRecord,
): PlayScreenshot {
  const shot = {
    name,
    path: record.output,
    rendered: captureRenderFailure(record) === undefined,
    digest: record.digest,
  };
  recorder.screenshots.push(shot);
  return shot;
}

function captureFailureCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}

/** Maps a failed strict final capture to the first failing runtime check. */
export function finalCaptureCheck(
  error: unknown,
  record: BrowserCaptureRecord | undefined,
  browserErrors: number,
  requireUi: boolean,
): PlayRuntimeCheck {
  if (captureFailureCode(error) === 'browser-capture-ui-missing') return 'ui-missing';
  if (captureFailureCode(error) !== 'browser-capture-runtime-failed' || record === undefined)
    return 'final-frame-timeout';
  if (record.runtime.fatalError !== null) return 'fatal';
  // Before browser errors: the development host also logs the renderer error once.
  if (captureRenderFailure(record)?.reason === 'renderer-error') return 'renderer-error';
  if (browserErrors > 0) return 'browser-errors';
  if (!record.pixels.rendered) return 'flat-canvas';
  if (requireUi && record.runtime.domUi.rootChildren === 0) return 'ui-missing';
  return 'final-frame-timeout';
}

const RUNTIME_HINTS: Readonly<Record<PlayRuntimeCheck, string>> = {
  fatal: 'Repair the Engine startup or runtime fault shown in the final screenshot.',
  'renderer-error':
    'The renderer failed every frame and the canvas is not presented; capture the frame with skills/forgeax-engine-rhi-debug.',
  'browser-errors':
    'Repair the first console or page error; a playthrough passes only without them.',
  'flat-canvas':
    'The final canvas is one uniform color; check the camera and visible content, or a black render.',
  'ui-missing': 'Mount game UI under #game-ui, or omit --require-ui for a canvas-only game.',
  'execution-unhealthy': 'Inspect the execution report in the play report and repair its fault.',
  'execution-unavailable':
    'The page exposed no execution report; check that the generated development host loaded.',
  'final-frame-timeout': 'No final frame was captured in time; inspect the capture report.',
  'external-request':
    'A release build must not load from other hosts: bundle the asset, font or script listed in detail.externalRequests into the build (or remove the call), rebuild and rerun.',
};

/** The failure message for a runtime check: the fatal text or renderer hint when there is one. */
function runtimeCheckMessage(
  check: PlayRuntimeCheck,
  record: BrowserCaptureRecord | undefined,
  error: unknown,
): string {
  if (check === 'fatal') return record?.runtime.fatalError ?? 'Engine fatal';
  if (check === 'renderer-error' && record !== undefined)
    return captureRenderFailure(record)?.hint ?? errorMessage(error);
  return errorMessage(error);
}

/**
 * Byte budget of the compact `value` or `error` without its `warnings` (see
 * `PLAY_WARNING_BYTES`); the CLI envelope adds about 60 bytes.
 */
export const PLAY_COMPACT_BYTES = 900;

function relativeTo(root: string, path: string): string {
  const value = relative(root, path);
  return value.startsWith('..') ? path : value;
}

/** Drops optional keys, in order, until the JSON form fits `maxBytes`. */
function fitBytes(
  value: Record<string, unknown>,
  dropOrder: readonly string[],
  maxBytes: number,
): Record<string, unknown> {
  const output = { ...value };
  for (const key of dropOrder) {
    if (jsonBytes(output) <= maxBytes) break;
    delete output[key];
  }
  return output;
}

/** Appends `warnings` after the fitted fields, keeping `report` last. */
function withWarnings(
  fitted: Record<string, unknown>,
  report: Pick<PlayReport, 'warnings'>,
): Record<string, unknown> {
  const { report: path, ...rest } = fitted;
  return { ...rest, ...warningsField(report), ...(path === undefined ? {} : { report: path }) };
}

/** Quotes a command-line argument only when the shell would split or expand it. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that replays a failed run from `step` (from the first step without one),
 * keeping its other run options.
 */
export function rerunCommand(
  report: Pick<PlayReport, 'script' | 'timeScale'> &
    Partial<Pick<PlayReport, 'mode' | 'dist' | 'headers'>>,
  step?: string,
): string {
  const scale =
    report.timeScale === undefined || report.timeScale === 1
      ? ''
      : ` --time-scale ${report.timeScale}`;
  const session =
    report.mode === 'session'
      ? ' --session'
      : report.mode === 'release'
        ? ` --release${report.dist === undefined || report.dist === 'dist' ? '' : ` --dist ${shellArg(report.dist)}`}${report.headers === 'none' ? ' --headers none' : ''}`
        : '';
  const from = step === undefined ? '' : ` --from ${shellArg(step)}`;
  return `forgeax project play ${shellArg(report.script)}${from}${scale}${session} --json`;
}

/** The suggested speed-up for iteration runs; final acceptance stays real-time. */
const ITERATION_SCALE = '--time-scale 4';

/** `detail.rerun` and, for a later step without setup, `detail.setupHint`. */
function rerunDetail(
  report: PlayReport,
  failure: Pick<PlayFailure, 'rerunFrom' | 'stepWithoutSetup'>,
): Record<string, unknown> {
  const missing = failure.stepWithoutSetup;
  if (missing === undefined)
    return failure.rerunFrom === undefined
      ? {}
      : { rerun: clip(rerunCommand(report, failure.rerunFrom), 240) };
  const realTime = (report.timeScale ?? 1) === 1;
  const start = failure.rerunFrom === undefined ? 'the first step' : `"${failure.rerunFrom}"`;
  return {
    rerun: clip(rerunCommand(report, failure.rerunFrom), 240),
    setupHint: clip(
      `"${missing}" has no setup, so --from ${shellArg(missing)} fails; rerun starts at ${start}${realTime ? ` (iterate with ${ITERATION_SCALE})` : ''}. Add play.step(${JSON.stringify(missing)}, run, { setup: async (play) => {} }).`,
      300,
    ),
  };
}

function nonFinalField(report: Pick<PlayReport, 'final' | 'nonFinal'>): Record<string, unknown> {
  return report.final === false ? { final: false, nonFinal: report.nonFinal ?? [] } : {};
}

/** A passing real-time private run this long suggests a faster iteration run. */
const NEXT_HINT_MIN_MS = 60_000;
const NEXT_ITERATION_HINT = `iteration runs can pass ${ITERATION_SCALE} (and --from <step> once steps have setups); final acceptance stays real-time`;

function iterationHintDue(report: PlayReport): boolean {
  return (
    report.passed &&
    report.mode === 'private' &&
    (report.timeScale ?? 1) === 1 &&
    report.range === undefined &&
    report.timings.totalMs >= NEXT_HINT_MIN_MS
  );
}

/** Compact, decision-relevant result value (under 1 KB) or the complete report. */
export function playResultValue(report: PlayReport, detail: boolean): unknown {
  if (detail) return report;
  const shots = report.screenshots.map((shot) => relativeTo(report.root, shot.path));
  const final = report.screenshots.find((shot) => shot.name === 'final');
  const value: Record<string, unknown> = {
    passed: report.passed,
    script: clip(report.script, 120),
    ms: report.timings.totalMs,
    steps: report.steps.length,
    ...(report.mode === 'private' ? {} : { mode: report.mode }),
    ...(report.headers === undefined ? {} : { headers: report.headers }),
    ...nonFinalField(report),
    ...(report.returned === undefined ? {} : { returned: summarizeValue(report.returned, 200) }),
    ...(report.state === undefined ? {} : { state: summarizeValue(report.state, 240) }),
    screenshots:
      shots.length <= 4
        ? shots.map((shot) => clip(shot, 120))
        : [...shots.slice(0, 3).map((shot) => clip(shot, 120)), `+${shots.length - 3} more`],
    ...(final === undefined ? {} : { rendered: final.rendered }),
    ...(report.rendererError === undefined
      ? {}
      : {
          rendererError: clip(
            `${report.rendererError.code} x${report.rendererError.count}, last frame ${report.rendererError.frame}: ${report.rendererError.message}`,
            200,
          ),
        }),
    errors: { console: report.errors.console.length, page: report.errors.page.length },
    ...(iterationHintDue(report) ? { next: NEXT_ITERATION_HINT } : {}),
    report: clip(relativeTo(report.root, report.report), 160),
  };
  const output = fitBytes(
    value,
    ['next', 'state', 'returned', 'rendererError'],
    PLAY_COMPACT_BYTES,
  );
  return withWarnings(fitBytes(output, ['screenshots'], PLAY_COMPACT_BYTES), report);
}

const SESSION_UNAVAILABLE_HINT =
  'Start the owner with `forgeax dev start` (or inspect `forgeax dev status`), or rerun without --session for a private runtime.';

const RELEASE_BUILD_HINT =
  'Run `forgeax project build` first (pass --dist <dir> when it wrote elsewhere, for example with --out-dir), then rerun with --release.';

const SCRIPT_INVALID = {
  expected: 'a playthrough module whose default export is an async function (play) => {}',
  hint: 'Fix the module path or export, then rerun.',
} as const;

/** Structured failure for a report that did not pass; `undefined` when it passed. */
const STEP_FAILURE_HINT = `Inspect the failing step, state and screenshot; fix the game or the script, then run detail.rerun. ${SCENE_PREVIEW_HINT}`;
const STEP_FAILURE_HINTS: Readonly<Record<PlayStepFailureReason, string>> = {
  'script-error': STEP_FAILURE_HINT,
  'wait-timeout': STEP_FAILURE_HINT,
  'state-unavailable': 'Register the read projection the script reads, or pass its id.',
  'advance-invalid': `Pass 0 < seconds <= ${MAX_ADVANCE_SECONDS} and 0 < stepSeconds <= ${MAX_ADVANCE_STEP_SECONDS}, at most ${MAX_ADVANCE_FRAMES} frames.`,
  'advance-failed':
    'Inspect detail.message for the App step refusal; advance needs a development host.',
  'setup-missing':
    'Give the step a setup that reaches its starting state, or start the range at an earlier step.',
  'range-unmatched':
    'Pass a top-level step name or 1-based position from detail.message, start before end.',
  'clock-failed':
    'Inspect detail.message for the App step refusal; a time scale needs a development host. Rerun without --time-scale to compare.',
};

function playNotReadyHint(reason: string): string {
  if (reason === 'startup-failed')
    return `Repair the startup fatal shown in the screenshot, then rerun. ${SCENE_PREVIEW_HINT}`;
  if (reason === 'session-unavailable') return SESSION_UNAVAILABLE_HINT;
  if (reason === 'release-missing' || reason === 'release-invalid') return RELEASE_BUILD_HINT;
  return 'Inspect detail.cause, the capture report and screenshot for the startup blocker.';
}

/** The compact, byte-budgeted fields of a failed play; the budget trims them in priority order. */
function playFailureRaw(report: PlayReport, failure: PlayFailure): Record<string, unknown> {
  const firstError = report.errors.page[0] ?? report.errors.console[0];
  return {
    reason: failure.reason,
    message: clip(failure.message, 200),
    ...(failure.step === undefined ? {} : { step: clip(failure.step, 80) }),
    ...(failure.action === undefined ? {} : { action: clip(failure.action, 100) }),
    ...(failure.code === 'play-step-failed' ? rerunDetail(report, failure) : {}),
    ...nonFinalField(report),
    ...(report.externalRequests === undefined || report.externalRequests.length === 0
      ? {}
      : { externalRequests: report.externalRequests.slice(0, 3).map((url) => clip(url, 120)) }),
    ...(failure.screenshot === undefined
      ? {}
      : { screenshot: clip(relativeTo(report.root, failure.screenshot), 120) }),
    ...(failure.cause === undefined
      ? {}
      : {
          cause: {
            code: clip(failure.cause.code, 60),
            ...(failure.cause.hint === undefined ? {} : { hint: clip(failure.cause.hint, 120) }),
            ...(failure.cause.detail === undefined
              ? {}
              : { detail: summarizeValue(failure.cause.detail, 120) }),
          },
        }),
    ...(report.state === undefined ? {} : { state: summarizeValue(report.state, 160) }),
    errors: { console: report.errors.console.length, page: report.errors.page.length },
    ...(firstError === undefined ? {} : { firstError: clip(firstError, 160) }),
    ...(report.log.length === 0
      ? {}
      : { log: report.log.slice(-2).map((line) => clip(line, 100)) }),
    report: clip(relativeTo(report.root, report.report), 160),
  };
}

export function playFailureError(report: PlayReport): CommandError | undefined {
  const failure = report.failure;
  if (failure === undefined) return undefined;
  const raw = playFailureRaw(report, failure);
  const error = (expected: string, hint: string): CommandError => {
    const shape = playError(failure.code, expected, hint, {});
    const budget = PLAY_COMPACT_BYTES - jsonBytes(shape);
    return {
      ...shape,
      detail: withWarnings(
        fitBytes(
          raw,
          [
            'log',
            'firstError',
            'state',
            'action',
            'cause',
            'message',
            'setupHint',
            'externalRequests',
          ],
          budget,
        ),
        report,
      ),
    };
  };
  switch (failure.code) {
    case 'play-script-invalid':
      return error(SCRIPT_INVALID.expected, SCRIPT_INVALID.hint);
    case 'play-not-ready':
      return error(
        'the game to open input (html[data-forgeax-input="open"]) after its first ready frame',
        playNotReadyHint(failure.reason),
      );
    case 'play-step-failed':
      return error('every playthrough step to complete', STEP_FAILURE_HINTS[failure.reason]);
    case 'play-timeout':
      return error(
        'the playthrough to finish within --timeout-ms',
        'Bound waits with waitFor timeouts, or raise --timeout-ms for a long playthrough.',
      );
    case 'tool-run-cancelled':
      return error(
        'the tool run not to be cancelled',
        'Retry the command after resolving the cancellation source.',
      );
    case 'play-runtime-failed':
      return error(
        'a healthy execution, a rendered final frame and no browser errors after the script',
        RUNTIME_HINTS[failure.reason],
      );
  }
}

async function readExecution(page: Page): Promise<ExecutionHealth | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = await Promise.race([
    page.evaluate(() => {
      const inspection = (
        globalThis as { __forgeaxGameInspection?: { renderer?(): { execution?: unknown } } }
      ).__forgeaxGameInspection;
      return inspection?.renderer?.().execution ?? null;
    }),
    new Promise<null>((done) => {
      timer = setTimeout(() => done(null), EVALUATE_MS);
    }),
  ])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
  return isExecutionReport(execution) ? executionHealth(execution) : 'unavailable';
}

type LoadedScript =
  | { readonly ok: true; readonly run: PlayScript }
  | { readonly ok: false; readonly reason: PlayScriptInvalidReason; readonly message: string };

async function loadScript(path: string): Promise<LoadedScript> {
  let mtime: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    mtime = info.mtimeMs;
  } catch {
    return { ok: false, reason: 'missing', message: `No playthrough module at ${path}` };
  }
  let module: { readonly default?: unknown };
  try {
    // A long-lived embedding process re-imports an edited module instead of its cached copy.
    const url = `${pathToFileURL(path).href}?v=${Math.trunc(mtime)}`;
    module = (await import(url)) as { readonly default?: unknown };
  } catch (cause) {
    return {
      ok: false,
      reason: 'import-failed',
      message: clip(failureSummary(cause), 400),
    };
  }
  return typeof module.default === 'function'
    ? { ok: true, run: module.default as PlayScript }
    : {
        ok: false,
        reason: 'no-default-export',
        message: 'The module must `export default async function (play) { ... }`.',
      };
}

/**
 * The play output directory, keyed by the script path relative to the project
 * root (`scripts/a.mjs` -> `artifacts/play/scripts/a`). A script outside the
 * root is keyed by its name and a digest of its absolute path.
 */
export function playOutputDir(root: string, scriptPath: string): string {
  const relativePath = relative(root, scriptPath);
  const stem = (path: string) => path.slice(0, path.length - extname(path).length) || 'play';
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    const digest = createHash('sha256').update(scriptPath).digest('hex').slice(0, 8);
    return resolve(root, 'artifacts/play/external', `${stem(basename(scriptPath))}-${digest}`);
  }
  return resolve(root, 'artifacts/play', ...stem(relativePath).split(sep));
}

const OWNED_FILE = /^(?:\d{2,}-[A-Za-z0-9_-]+\.png|capture\.json|play\.json)$/;

/**
 * Removes only files a previous run recorded that are plain files directly in
 * `outputDir` with play's own names; recorded paths are untrusted input.
 * Removal failures are ignored per file and never fail the run.
 */
export async function clearPreviousRun(outputDir: string, reportPath: string): Promise<void> {
  let previous: Partial<PlayReport>;
  try {
    previous = JSON.parse(await readFile(reportPath, 'utf8')) as Partial<PlayReport>;
  } catch {
    return;
  }
  const recorded: unknown[] = [
    ...(Array.isArray(previous.screenshots)
      ? previous.screenshots.map((shot: Partial<PlayScreenshot> | null) => shot?.path)
      : []),
    previous.captureReport,
    reportPath,
  ];
  for (const entry of recorded) {
    if (typeof entry !== 'string') continue;
    const path = resolve(outputDir, entry);
    const inside = relative(outputDir, path);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.includes(sep))
      continue;
    if (!OWNED_FILE.test(inside)) continue;
    try {
      if ((await lstat(path)).isFile()) await rm(path, { force: true });
    } catch {
      // A file that cannot be inspected or removed is left in place.
    }
  }
}

/** Routes script console output into the bounded report so `--json` stdout stays one document. */
function captureConsole(log: string[]): (abandoned?: boolean) => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  // biome-ignore lint/suspicious/noConsole: the playthrough's own console is redirected, not used.
  const original = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...values: unknown[]) => {
      const line = values
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(jsonSafe(value))))
        .join(' ');
      if (log.length >= MAX_LOG_LINES) log.shift();
      log.push(clip(line, 500));
    };
  }
  return (abandoned = false) => {
    methods.forEach((method, index) => {
      console[method] = original[index] as (typeof console)[typeof method];
    });
    // An abandoned module may still log; its stdout methods write to stderr so a
    // JSON result on stdout stays one document while embedders keep a console.
    if (abandoned) {
      const toStderr = original[methods.indexOf('error')] as typeof console.error;
      console.log = toStderr;
      console.info = toStderr;
      console.debug = toStderr;
    }
  };
}

/** Resolves after two animation frames, bounded so a stalled page cannot hold verification. */
async function settleFrames(page: Page): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    ),
    new Promise<void>((done) => {
      timer = setTimeout(done, EVALUATE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  return clip(failureSummary(error), 160);
}

/**
 * Resizes the page to each further viewport and applies the final-frame gate there
 * (strict capture: no fatal, no browser errors, a rendered canvas, and `--require-ui`'s
 * `#game-ui` child). A failed resize or gate at a viewport fails the play.
 */
async function checkViewports(
  session: BrowserCaptureSession,
  recorder: PlayRecorder,
  outputDir: string,
  viewports: readonly PlayViewport[],
  requireUi: boolean,
): Promise<PlayFailure | undefined> {
  for (const viewport of viewports.slice(1)) {
    const name = viewportName(viewport);
    const before = session.report().captures.length;
    try {
      await session.page.setViewportSize(viewport);
      await settleFrames(session.page);
      await takeScreenshot(session, recorder, outputDir, `viewport ${name}`, 'validate', requireUi);
    } catch (error) {
      const browserReport = session.report();
      const record =
        browserReport.captures.length > before ? browserReport.captures.at(-1) : undefined;
      if (record !== undefined) pushScreenshot(recorder, `viewport ${name}`, record);
      const check = finalCaptureCheck(
        error,
        record,
        browserReport.consoleErrors.length + browserReport.pageErrors.length,
        requireUi,
      );
      return {
        code: 'play-runtime-failed',
        reason: check,
        message: clip(`At viewport ${name}: ${runtimeCheckMessage(check, record, error)}`, 400),
        ...(record === undefined ? {} : { screenshot: record.output }),
      };
    }
  }
  return undefined;
}

/**
 * Runs one playthrough module against a temporary development runtime and a
 * private sandboxed browser, then applies the runtime verification gate to the
 * final frame. The module receives {@link PlayContext}.
 *
 * The module runs in this process (it borrows the live Playwright Page). Its
 * console output (import and run) goes to the report. On timeout or
 * cancellation its helpers reject and the browser closes; if it is still
 * running, the console is restored with stdout methods diverted to stderr, and
 * the CLI exits after printing. A synchronous infinite loop cannot be interrupted.
 *
 * The console redirect is process-global and the lock is per project, so an
 * embedder runs in-process plays sequentially; concurrent ones (of different
 * projects, or while a queued play imports its module) can mix their logs.
 *
 * Plays of one project run one at a time under a project lock; stdout stays one
 * JSON document while stderr carries a start line and at most one progress line
 * per {@link PLAY_PROGRESS_INTERVAL_MS}.
 */
export async function playCommand(
  options: PlayOptions,
  run: { readonly signal?: AbortSignal; readonly sessionHost?: PlaySessionHost } = {},
): Promise<CommandResult<unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? process.cwd());
  const scriptPath = resolve(root, options.script ?? '');
  const args = parsePlayArgs(options);
  if (!args.ok) return args;
  const { viewports, range, timeScale } = args.value;
  const admission = await admitPlayRelease(options, root);
  if (!admission.ok) return admission;
  const release = admission.value;
  const budget = await readProjectStartupTimeoutMs(root);
  if (!budget.ok) return budget;
  const startupTimeoutMs = budget.value ?? DEV_EXECUTION_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const write =
    options.progress === false
      ? () => undefined
      : (line: string) => void process.stderr.write(`forgeax project play: ${line}\n`);
  if (options.session === true && run.sessionHost === undefined)
    return playInDevOwner(options, root, playLockWaitMs(timeoutMs, startupTimeoutMs), write, run);
  const script = relativeTo(root, scriptPath);
  const lockPath = resolve(root, '.forgeax/play/lock.json');
  const recorder = newPlayRecorder(range, timeScale, release);
  const loaded = await importPlayScript(
    options.script === undefined ? undefined : scriptPath,
    recorder,
  );
  const opening = playOpeningPhase(release);
  const status = { phase: opening };
  await announcePlay(write, {
    script,
    startupTimeoutMs,
    timeoutMs,
    reportPath: resolve(playOutputDir(root, scriptPath), 'play.json'),
    faster: await iterationSuggestion(options, run, root, timeScale, release),
  });
  // Elapsed time in progress lines includes any wait for the lock.
  const stopProgress = startPlayProgress(write, () => describePlayProgress(status, recorder));
  try {
    const lock = await acquirePlayLock(lockPath, {
      script,
      // An invalid script never queues: it reports at once unless the lock is free.
      timeoutMs: loaded.ok ? playLockWaitMs(timeoutMs, startupTimeoutMs) : 0,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      onWait: (holder) => announceLockWait(holder, status, write, lockPath),
    });
    if (!lock.ok) return lockRefusal(lock, loaded, lockPath);
    status.phase = opening;
    try {
      return await playLocked(options, run, {
        ...(run.sessionHost === undefined ? {} : { host: run.sessionHost }),
        ...(release === undefined ? {} : { release }),
        started,
        root,
        scriptPath,
        loaded,
        startupTimeoutMs,
        timeoutMs,
        viewports,
        lockMs: lock.waitedMs,
        recorder,
        status,
      });
    } finally {
      await lock.release();
    }
  } finally {
    stopProgress();
  }
}

/** The start line and the expectation line on stderr; the latter needs the previous report. */
async function announcePlay(
  write: (line: string) => void,
  info: {
    readonly script: string;
    readonly startupTimeoutMs: number;
    readonly timeoutMs: number;
    readonly reportPath: string;
    readonly faster: { readonly ownerRunning: boolean } | undefined;
  },
): Promise<void> {
  write(
    `started ${info.script}; stdout prints one JSON result when it ends (startup budget ${Math.round(info.startupTimeoutMs / 1000)} s per stage: Pack catalog, page load, first frame, open input; script budget ${Math.round(info.timeoutMs / 1000)} s); progress every ${PLAY_PROGRESS_INTERVAL_MS / 1000} s here on stderr`,
  );
  write(await playExpectationLine(info.reportPath, info.faster));
}

function announceLockWait(
  holder: { readonly pid: number; readonly script: string; readonly startedAt: number } | undefined,
  status: { phase: string },
  write: (line: string) => void,
  lockPath: string,
): void {
  const who = holder === undefined ? '' : ` (pid ${holder.pid}, ${holder.script})`;
  status.phase = `waiting for another play of this project${who}`;
  const age =
    holder === undefined ? '' : `, ${Math.round((Date.now() - holder.startedAt) / 1000)} s in`;
  write(`${status.phase}${age}; plays of one project run one at a time (${lockPath})`);
}

/** `--release` verifies its distribution before the lock; any other play has none. */
async function admitPlayRelease(
  options: PlayOptions,
  root: string,
): Promise<CommandResult<PlayRelease | undefined>> {
  if (options.release !== true) return { ok: true, value: undefined };
  const admitted = await admitRelease(root, options.dist ?? 'dist');
  if (!admitted.ok) return admitted;
  return { ok: true, value: { ...admitted.value, headers: options.headers ?? 'isolated' } };
}

/** A real-time private run with progress output suggests the faster iteration flags. */
async function iterationSuggestion(
  options: PlayOptions,
  run: { readonly sessionHost?: PlaySessionHost },
  root: string,
  timeScale: number,
  release: PlayRelease | undefined,
): Promise<{ readonly ownerRunning: boolean } | undefined> {
  const realTime =
    timeScale === 1 &&
    run.sessionHost === undefined &&
    release === undefined &&
    options.progress !== false;
  return realTime ? { ownerRunning: await liveOwnerRecorded(root) } : undefined;
}

function playOpeningPhase(release: PlayRelease | undefined): string {
  if (release === undefined) return 'opening the dev runtime and browser';
  const headers =
    release.headers === 'none' ? 'no isolation headers' : 'COOP/COEP isolation headers';
  return `serving the release build ${release.dist} (${headers}) and opening the browser`;
}

function describePlayProgress(status: { phase: string }, recorder: PlayRecorder): string {
  if (status.phase !== 'script') return status.phase;
  const step = recorder.step === undefined ? '' : ` (step "${clip(recorder.step, 80)}")`;
  return `running the script${step}, ${recorder.steps.length} steps done`;
}

/** Parse failures are `tool-invalid-args` carrying the parser's message. */
function invalidPlayArgs(expected: string, hint: string, message: string): CommandResult<never> {
  return {
    ok: false,
    error: { code: 'tool-invalid-args', expected, hint, detail: { message } },
  };
}

interface PlayArgs {
  readonly viewports: readonly PlayViewport[];
  readonly range: PlayStepRange | undefined;
  readonly timeScale: number;
}

/** The host-side orchestration options: viewports, step range, time scale and release flags. */
function parsePlayArgs(options: PlayOptions): CommandResult<PlayArgs> {
  const viewports = parsePlayViewports(options.viewports ?? DEFAULT_PLAY_VIEWPORTS);
  if (!viewports.ok)
    return invalidPlayArgs(
      '--viewports WxH[,WxH...]',
      `Pass distinct viewports, for example ${DEFAULT_PLAY_VIEWPORTS}.`,
      viewports.message,
    );
  const range = parsePlayStepRange(options);
  if (!range.ok)
    return invalidPlayArgs(
      '--from <step> or --steps a..b (top-level step names or 1-based positions)',
      'Pass one range option, for example --from walk or --steps 2..3.',
      range.message,
    );
  const timeScale = options.timeScale ?? 1;
  const scaleError = timeScaleError(timeScale);
  if (scaleError !== undefined)
    return invalidPlayArgs(
      `--time-scale <n> from 1/16 to ${MAX_TIME_SCALE}; 1 (the default) is real time`,
      'Pass for example --time-scale 4, or omit it for real time.',
      scaleError,
    );
  const releaseArgs = releaseArgsError(options, timeScale);
  if (releaseArgs !== undefined) return { ok: false, error: releaseArgs };
  return { ok: true, value: { viewports: viewports.value, range: range.value, timeScale } };
}

function newPlayRecorder(
  range: PlayStepRange | undefined,
  timeScale: number,
  release: PlayRelease | undefined,
): PlayRecorder {
  return {
    steps: [],
    screenshots: [],
    log: [],
    warnings: [],
    step: undefined,
    action: undefined,
    failedStep: new WeakMap(),
    ...(range === undefined ? {} : { range: { range, phase: 'before', index: 0, seen: [] } }),
    ...(timeScale === 1 ? {} : { timeScale }),
    ...(release === undefined ? {} : { release: true }),
  };
}

/** Only the module's own import and run are captured, not DevKit/Vite startup output. */
async function importPlayScript(
  scriptPath: string | undefined,
  recorder: PlayRecorder,
): Promise<LoadedScript> {
  const restoreImportConsole = captureConsole(recorder.log);
  return await (scriptPath === undefined
    ? Promise.resolve({
        ok: false,
        reason: 'missing',
        message: 'Pass the playthrough module path.',
      } as const)
    : loadScript(scriptPath)
  ).finally(() => restoreImportConsole());
}

/** An unacquired lock reports an invalid script first, then the lock's own refusal. */
function lockRefusal(
  lock: Exclude<Awaited<ReturnType<typeof acquirePlayLock>>, { ok: true }>,
  loaded: LoadedScript,
  lockPath: string,
): CommandResult<never> {
  if (!loaded.ok)
    return {
      ok: false,
      error: playError('play-script-invalid', SCRIPT_INVALID.expected, SCRIPT_INVALID.hint, {
        reason: loaded.reason,
        message: clip(loaded.message, 200),
      }),
    };
  return { ok: false, error: lockError(lock, lockPath) };
}

/** A verified browser distribution for `--release`. */
interface PlayRelease {
  /** As passed, relative to the root. */
  readonly dist: string;
  readonly distRoot: string;
  readonly manifest: DistManifest;
  readonly headers: ReleaseHeaders;
}

/** `--release` runs on the App's real-time loop in a private browser only. */
export function releaseArgsError(
  options: Pick<PlayOptions, 'release' | 'session' | 'headers'>,
  timeScale: number,
): CommandError | undefined {
  if (options.headers !== undefined && options.headers !== 'isolated' && options.headers !== 'none')
    return {
      code: 'tool-invalid-args',
      expected: '--headers isolated or --headers none',
      hint: 'isolated (the default) sends COOP/COEP like `project preview`; none serves like a plain static host.',
      detail: { reason: 'release-headers-invalid', headers: String(options.headers) },
    };
  if (options.release !== true) {
    if (options.headers === undefined) return undefined;
    return {
      code: 'tool-invalid-args',
      expected: '--headers together with --release',
      hint: 'The dev runtime always serves isolated; add --release to choose the headers of the built release.',
      detail: { reason: 'release-headers-without-release' },
    };
  }
  const refused = [
    ...(timeScale === 1 ? [] : ['--time-scale']),
    ...(options.session === true ? ['--session'] : []),
  ];
  if (refused.length === 0) return undefined;
  return {
    code: 'tool-invalid-args',
    expected: '--release without --time-scale or --session',
    hint: 'A release build has no development clock or dev start owner: iterate with those flags on the dev runtime, then run the same script once with --release alone to check the built output.',
    detail: {
      reason: 'release-unsupported-flag',
      flags: refused,
      message: `${refused.join(' and ')} ${refused.length === 1 ? 'needs' : 'need'} the development runtime; --release plays the built static distribution.`,
    },
  };
}

/** Verifies the `--release` distribution before the play takes its lock. */
export async function admitRelease(
  root: string,
  dist: string,
): Promise<CommandResult<Omit<PlayRelease, 'headers'>>> {
  const distRoot = resolve(root, dist);
  const verified = await verifyDist(distRoot);
  if (!verified.ok) {
    const missing = verified.error.code === 'dist-manifest-unreadable';
    return {
      ok: false,
      error: playError(
        'play-not-ready',
        'a built browser distribution with a verified forgeax-dist.json',
        missing ? RELEASE_BUILD_HINT : `${clip(verified.error.hint, 160)} ${RELEASE_BUILD_HINT}`,
        {
          reason: missing ? 'release-missing' : 'release-invalid',
          dist: relativeTo(root, distRoot),
          cause: { code: verified.error.code, hint: clip(verified.error.hint, 160) },
        },
      ),
    };
  }
  if ((verified.value.target ?? 'browser') !== 'browser')
    return {
      ok: false,
      error: playError(
        'play-not-ready',
        'a distribution built for the browser target',
        `${relativeTo(root, distRoot)} targets ${verified.value.target}; build the browser target with \`forgeax project build\` and pass its --dist.`,
        { reason: 'release-invalid', dist: relativeTo(root, distRoot) },
      ),
    };
  return { ok: true, value: { dist, distRoot, manifest: verified.value } };
}

/** Owner replies that belong to the play itself and pass through unchanged. */
const PLAY_RESULT_CODES: ReadonlySet<string> = new Set([
  'tool-invalid-args',
  'tool-run-cancelled',
  'play-script-invalid',
  'play-not-ready',
  'play-step-failed',
  'play-timeout',
  'play-runtime-failed',
]);

/**
 * `--session`: sends the play to the project's `dev start` owner, which reloads its page
 * and runs the play there. Any owner-side refusal (none running, unreachable, a page
 * that did not become ready) is `play-not-ready` with reason `session-unavailable`.
 */
async function playInDevOwner(
  options: PlayOptions,
  root: string,
  playBudgetMs: number,
  write: (line: string) => void,
  run: { readonly signal?: AbortSignal },
): Promise<CommandResult<unknown>> {
  const { root: _root, session: _session, progress: _progress, ...forwarded } = options;
  write(
    "running in the page of this project's `forgeax dev start` owner: it reloads that page, runs the script there and prints one JSON result on stdout",
  );
  const { liveDevControl } = await import('./live-dev.js');
  const reply = (await liveDevControl(root, 'play', forwarded, {
    // The owner may first wait for an earlier play of the project, then runs this one.
    requestTimeoutMs: 2 * playBudgetMs + 60_000,
    ...(run.signal === undefined ? {} : { signal: run.signal }),
  })) as {
    readonly ok?: unknown;
    readonly error?: {
      readonly code?: unknown;
      readonly hint?: unknown;
      readonly detail?: unknown;
    };
  } | null;
  if (reply?.ok === true) return reply as CommandResult<unknown>;
  const code = typeof reply?.error?.code === 'string' ? reply.error.code : 'live-operation-failed';
  if (reply?.ok === false && PLAY_RESULT_CODES.has(code)) return reply as CommandResult<unknown>;
  if (run.signal?.aborted === true)
    return {
      ok: false,
      error: playError(
        'tool-run-cancelled',
        'the tool run not to be cancelled',
        'Retry the command after resolving the cancellation source.',
        { reason: 'cancelled' },
      ),
    };
  return {
    ok: false,
    error: playError(
      'play-not-ready',
      'a running `forgeax dev start` owner that admits the play',
      SESSION_UNAVAILABLE_HINT,
      {
        reason: 'session-unavailable',
        cause: {
          code: clip(code, 60),
          ...(typeof reply?.error?.hint === 'string' ? { hint: clip(reply.error.hint, 160) } : {}),
          ...(reply?.error?.detail === undefined
            ? {}
            : { detail: summarizeValue(reply.error.detail, 200) }),
        },
      },
    ),
  };
}

/**
 * A queued play waits up to one ordinary play budget (script budget plus
 * startup budget) for the holder before `busy`.
 */
export function playLockWaitMs(timeoutMs: number, startupTimeoutMs: number): number {
  return timeoutMs + startupTimeoutMs;
}

function lockError(
  lock: Exclude<Awaited<ReturnType<typeof acquirePlayLock>>, { ok: true }>,
  lockPath: string,
): CommandError {
  switch (lock.reason) {
    case 'cancelled':
      return playError(
        'tool-run-cancelled',
        'the tool run not to be cancelled',
        'Retry the command after resolving the cancellation source.',
        { reason: 'cancelled', waitedMs: lock.waitedMs, lock: lockPath },
      );
    case 'busy':
      return playError(
        'play-not-ready',
        'the project play lock to be released within the wait budget',
        `Another play of this project holds ${lockPath}; wait for it to print its result or stop it. If no play is running, delete that file.`,
        {
          reason: 'busy',
          waitedMs: lock.waitedMs,
          lock: lockPath,
          ...(lock.holder === undefined
            ? {}
            : {
                holder: {
                  pid: lock.holder.pid,
                  host: clip(lock.holder.host, 60),
                  script: clip(lock.holder.script, 120),
                },
              }),
        },
      );
    case 'unavailable':
      return playError(
        'play-not-ready',
        'a writable project play lock',
        `Make ${lockPath} creatable and removable (permissions, read-only file system), then rerun.`,
        { reason: 'lock-unavailable', lock: lockPath, message: clip(lock.message, 200) },
      );
  }
}

/**
 * @internal The early stderr line telling a waiting agent how long this play
 * should take (the previous run of the script, when its report is readable).
 */
export async function playExpectationLine(
  reportPath: string,
  /** A real-time private run: suggest the faster iteration flags. */
  faster?: { readonly ownerRunning: boolean },
): Promise<string> {
  let previous: Partial<PlayReport> | undefined;
  try {
    previous = JSON.parse(await readFile(reportPath, 'utf8')) as Partial<PlayReport>;
  } catch {
    previous = undefined;
  }
  const totalMs = previous?.timings?.totalMs;
  const expected =
    typeof totalMs === 'number' && Number.isFinite(totalMs) && Array.isArray(previous?.steps)
      ? `the previous run of this script took ${Math.round(totalMs / 1000)} s over ${previous.steps.length} steps`
      : 'a play usually takes 1-3 minutes';
  const iterate =
    faster === undefined
      ? ''
      : `; iteration runs can pass ${ITERATION_SCALE}${faster.ownerRunning ? ' --session (a dev start owner is running)' : ''}; final acceptance stays real-time`;
  return `${expected}; wait for this command in one call (your shell tool's longest wait) instead of re-checking it${iterate}`;
}

/** Minimum interval between progress lines; a harness need not poll more often. */
export const PLAY_PROGRESS_INTERVAL_MS = 30_000;

/** @internal Writes one `describe()` line per interval until stopped, never more often. */
export function startPlayProgress(
  write: (line: string) => void,
  describe: () => string,
  intervalMs = PLAY_PROGRESS_INTERVAL_MS,
): () => void {
  const started = Date.now();
  const timer = setInterval(
    () => write(`${Math.round((Date.now() - started) / 1000)} s, ${describe()}`),
    intervalMs,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

interface PlaySetup {
  /** A borrowed page instead of a private dev runtime and browser. */
  readonly host?: PlaySessionHost;
  /** `--release`: the verified distribution play serves instead of the dev runtime. */
  readonly release?: PlayRelease;
  readonly started: number;
  readonly root: string;
  readonly scriptPath: string;
  readonly loaded: LoadedScript;
  readonly startupTimeoutMs: number;
  readonly timeoutMs: number;
  readonly viewports: readonly PlayViewport[];
  readonly lockMs: number;
  readonly recorder: PlayRecorder;
  readonly status: { phase: string };
}

/** Mutable facts of one locked playthrough, shared by its phases. */
interface PlayRun {
  readonly options: PlayOptions;
  readonly setup: PlaySetup;
  readonly outputDir: string;
  readonly reportPath: string;
  readonly timings: { -readonly [K in keyof PlayReport['timings']]?: number };
  readonly abort: AbortController;
  readonly requireUi: boolean;
  session: BrowserCaptureSession | undefined;
  cancelled: boolean;
  failure: PlayFailure | undefined;
  returned: unknown;
  state: unknown;
  execution: PlayReport['execution'];
  scriptSettled: boolean;
  restoreConsole: ((abandoned?: boolean) => void) | undefined;
  /** A borrowed page's own size, restored after the play. */
  restoreViewport?: { readonly width: number; readonly height: number } | undefined;
  /** `--release`: play's static server, closed after the play. */
  releaseServer?: { close(): Promise<void> } | undefined;
  /** `--release`: blocked requests to non-local hosts, in order, deduplicated. */
  readonly externalRequests: string[];
}

function cancelledPlayFailure(): PlayFailure {
  return {
    code: 'tool-run-cancelled',
    reason: 'cancelled',
    message: 'The playthrough was cancelled.',
  };
}

/** A rejected capture still names the diagnostic image it wrote, when it wrote one. */
function rejectedCaptureOutput(error: unknown): string | undefined {
  const output = (error as { readonly detail?: { readonly output?: unknown } } | null)?.detail
    ?.output;
  return typeof output === 'string' ? output : undefined;
}

async function failWithScreenshot(run: PlayRun, next: PlayFailure): Promise<void> {
  let screenshot: string | undefined;
  if (run.session !== undefined) {
    // Failure frames are diagnostics: keep them out of the run's artifacts/.
    const diagnostics = diagnosticCapturePath(run.setup.root, run.outputDir);
    screenshot = await takeScreenshot(run.session, run.setup.recorder, diagnostics, 'failure')
      .then((shot) => shot.path)
      .catch(rejectedCaptureOutput);
  }
  run.failure = { ...next, ...(screenshot === undefined ? {} : { screenshot }) };
}

/** The play-not-ready failure for a browser session that could not open. */
export function sessionOpenFailure(cause: unknown): PlayFailure {
  const owner = cause as Partial<CommandError> | undefined;
  return {
    code: 'play-not-ready',
    reason: 'session-failed',
    // Startup failures are often structured objects; String() would print [object Object].
    message: clip(failureSummary(cause), 400),
    cause: {
      code: captureFailureCode(cause) ?? 'browser-capture-failed',
      ...(typeof owner?.hint === 'string' ? { hint: owner.hint } : {}),
      ...(owner?.detail === undefined ? {} : { detail: jsonSafe(owner.detail) }),
    },
  };
}

async function openPlaySession(run: PlayRun, browser: BrowserCapture | undefined): Promise<void> {
  const { options, setup, outputDir } = run;
  const openStarted = Date.now();
  if (setup.host !== undefined) {
    try {
      const session = await setup.host.open();
      run.session = session;
      // The owner's page keeps its own size; the script runs in the first play viewport.
      run.restoreViewport = session.page.viewportSize() ?? undefined;
      const first = setup.viewports[0];
      if (first !== undefined) await session.page.setViewportSize(first);
    } catch (cause) {
      run.failure = sessionOpenFailure(cause);
    }
    run.timings.openMs = Date.now() - openStarted;
    return;
  }
  if (browser === undefined) throw new Error('A private play needs a browser capture.');
  let serverUrl: string | undefined;
  if (setup.release !== undefined) {
    try {
      const { serveBrowserDist } = await import('./host.js');
      const { distRoot, manifest, headers } = setup.release;
      const server = await serveBrowserDist(
        setup.root,
        distRoot,
        manifest,
        options.port === undefined
          ? { port: 0, strictPort: false }
          : { port: options.port, strictPort: options.port !== 0 },
        'private',
        headers,
      );
      run.releaseServer = server;
      serverUrl = server.resolvedUrls?.local[0];
      if (serverUrl === undefined) throw new Error('the release server reported no local URL');
    } catch (cause) {
      run.failure = {
        code: 'play-not-ready',
        reason: 'release-invalid',
        message: clip(`The release server did not start: ${failureSummary(cause)}`, 400),
      };
      run.timings.openMs = Date.now() - openStarted;
      return;
    }
  }
  const external = run.externalRequests;
  try {
    run.session = await browser.open({
      backend: options.backend ?? 'auto',
      ...(serverUrl === undefined
        ? { launchProfile: 'development' as const }
        : {
            // The browser a player has: no development WebGPU flags.
            launchProfile: 'release' as const,
            serverUrl,
            onExternalRequest: (url: string) => {
              if (!external.includes(url)) external.push(url);
            },
          }),
      // Headless by default: no virtual display to orphan on Linux.
      headless: options.headless ?? true,
      width: setup.viewports[0]?.width ?? 1280,
      height: setup.viewports[0]?.height ?? 720,
      startupTimeoutMs: setup.startupTimeoutMs,
      // A play-owned dependency cache never races a `dev start` Vite child's optimizer;
      // the play-owned generated root (under the play lock) keeps that cache valid.
      viteCacheDir: resolve(setup.root, '.forgeax/play/vite'),
      generatedRoot: resolve(setup.root, '.forgeax/generated/play'),
      ...(options.port === undefined ? {} : { port: options.port }),
      outputDir,
      report: resolve(outputDir, 'capture.json'),
    });
  } catch (cause) {
    run.failure = sessionOpenFailure(cause);
  }
  run.timings.openMs = Date.now() - openStarted;
}

/** Wait for the game to open input; false when the run must stop here. */
async function awaitPlayInput(run: PlayRun, session: BrowserCaptureSession): Promise<boolean> {
  const { startupTimeoutMs, status } = run.setup;
  status.phase = 'waiting for the game to open input';
  const readyStarted = Date.now();
  const gate = await waitForInputOpen(session.page, startupTimeoutMs);
  run.timings.readyMs = Date.now() - readyStarted;
  if (run.cancelled) {
    run.failure = cancelledPlayFailure();
    return false;
  }
  if (gate.state === 'open') return true;
  await failWithScreenshot(run, {
    code: 'play-not-ready',
    reason: gate.state === 'fatal' ? 'startup-failed' : 'input-closed',
    message:
      gate.state === 'fatal'
        ? clip(gate.message, 400)
        : `Input stayed closed for ${startupTimeoutMs} ms after the page loaded`,
  });
  return false;
}

/**
 * @internal Where a rerun of a failed script starts: the failed top-level step when
 * `--from` can start there, else the start of the step range (a step with setup) or
 * the first step, naming the step without setup.
 */
export function playRerunFields(
  recorder: Pick<PlayRecorder, 'failedTop' | 'failedTopWithoutSetup' | 'range'>,
): Pick<PlayFailure, 'rerunFrom' | 'stepWithoutSetup'> {
  const failed = recorder.failedTop;
  if (failed === undefined) return {};
  if (recorder.failedTopWithoutSetup !== true) return { rerunFrom: failed };
  const start = recorder.range?.start;
  return start !== undefined && start.index > 1
    ? { rerunFrom: start.name, stepWithoutSetup: failed }
    : { stepWithoutSetup: failed };
}

async function recordScriptError(run: PlayRun, error: unknown): Promise<void> {
  const { recorder } = run.setup;
  const step =
    error !== null && typeof error === 'object'
      ? (recorder.failedStep.get(error) ?? recorder.step)
      : recorder.step;
  const helper = error instanceof PlayHelperError ? error : undefined;
  if (helper?.state !== undefined) run.state = helper.state;
  const located = {
    message: clip(failureSummary(error), 400),
    ...(step === undefined ? {} : { step }),
    ...(recorder.action === undefined ? {} : { action: recorder.action }),
    ...(helper?.reason === 'setup-missing' || helper?.reason === 'range-unmatched'
      ? {}
      : playRerunFields(recorder)),
  };
  if (error instanceof PlayTimeout && error.cancelled) {
    run.failure = cancelledPlayFailure();
    return;
  }
  await failWithScreenshot(
    run,
    error instanceof PlayTimeout
      ? { code: 'play-timeout', reason: 'timeout', ...located }
      : { code: 'play-step-failed', reason: helper?.reason ?? 'script-error', ...located },
  );
}

async function runPlayScript(
  run: PlayRun,
  script: PlayScript,
  context: PlayContext,
): Promise<void> {
  const { timeoutMs, recorder, status } = run.setup;
  status.phase = 'script';
  const scriptStarted = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  run.scriptSettled = false;
  if (recorder.timeScale !== undefined && recorder.timeScale !== 1) {
    const started = await startPlayClock(run.session?.page ?? context.page, recorder.timeScale);
    if (typeof started === 'string') {
      await failWithScreenshot(run, {
        code: 'play-step-failed',
        reason: 'clock-failed',
        message: started,
      });
      run.timings.scriptMs = Date.now() - scriptStarted;
      return;
    }
    recorder.clock = started;
  }
  run.restoreConsole = captureConsole(recorder.log);
  const running = Promise.resolve()
    .then(() => script(context))
    .finally(() => {
      run.scriptSettled = true;
    });
  try {
    run.returned = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PlayTimeout(timeoutMs)), timeoutMs);
        run.abort.signal.addEventListener(
          'abort',
          () => reject(new PlayTimeout(timeoutMs, run.cancelled)),
          { once: true },
        );
      }),
    ]);
  } catch (error) {
    // Later helper calls of an abandoned module reject instead of driving the page.
    if (error instanceof PlayTimeout) run.abort.abort();
    running.catch(() => undefined);
    // The first top-level step after a step range ends the script as a pass.
    if (!(error instanceof PlayRangeEnd)) await recordScriptError(run, error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // The final frame and viewport checks run on the App's own real-time loop.
  if (recorder.clock !== undefined) {
    const stopped = await readPlayClock(context.page, { action: 'stop' }).catch(() => null);
    if (stopped !== null && stopped.frames !== undefined) recorder.clock = stopped;
  }
  const tracker = recorder.range;
  if (run.failure === undefined && tracker?.phase === 'before') {
    const seen = tracker.seen.map((name, index) => `#${index + 1} ${name}`).join(', ');
    await failWithScreenshot(run, {
      code: 'play-step-failed',
      reason: 'range-unmatched',
      message: clip(
        `No top-level step matched the range start ${tracker.range.from}; the script ran ${seen === '' ? 'no top-level steps' : seen}.`,
        400,
      ),
    });
  }
  run.timings.scriptMs = Date.now() - scriptStarted;
}

function finalFrameFailure(
  run: PlayRun,
  session: BrowserCaptureSession,
  error: unknown,
  capturesBefore: number,
): PlayFailure {
  const browserReport = session.report();
  // The strict capture records its frame before rejecting; a timeout may record none.
  const record =
    browserReport.captures.length > capturesBefore ? browserReport.captures.at(-1) : undefined;
  if (record !== undefined) pushScreenshot(run.setup.recorder, 'final', record);
  const check = finalCaptureCheck(
    error,
    record,
    browserReport.consoleErrors.length + browserReport.pageErrors.length,
    run.requireUi,
  );
  return {
    code: 'play-runtime-failed',
    reason: check,
    message: clip(runtimeCheckMessage(check, record, error), 400),
    ...(record === undefined ? {} : { screenshot: record.output }),
  };
}

async function verifyPlayFinal(run: PlayRun, session: BrowserCaptureSession): Promise<void> {
  const { recorder, status, viewports } = run.setup;
  status.phase = 'verifying the final frame and viewports';
  const verifyStarted = Date.now();
  const capturesBefore = session.report().captures.length;
  try {
    await takeScreenshot(session, recorder, run.outputDir, 'final', 'validate', run.requireUi);
  } catch (error) {
    run.failure = finalFrameFailure(run, session, error, capturesBefore);
  }
  // Health is read for the play viewport, before any resize. A release build omits the
  // development execution report, so release health is the final frame and errors alone.
  if (run.setup.release === undefined) run.execution = await readExecution(session.page);
  if (run.failure === undefined && run.execution !== undefined && run.execution !== 'healthy') {
    run.failure = {
      code: 'play-runtime-failed',
      reason: run.execution === 'unavailable' ? 'execution-unavailable' : 'execution-unhealthy',
      message: `Execution report: ${run.execution}`,
    };
  }
  if (run.failure === undefined) {
    run.failure = await checkViewports(session, recorder, run.outputDir, viewports, run.requireUi);
  }
  // A blocked request also logs a console error (and may break what it loaded), so
  // external requests are the reported cause of any final runtime failure.
  const external = externalRequestFailure(run.externalRequests);
  if (
    external !== undefined &&
    (run.failure === undefined || run.failure.code === 'play-runtime-failed')
  )
    run.failure = {
      ...external,
      ...(run.failure?.screenshot === undefined ? {} : { screenshot: run.failure.screenshot }),
    };
  run.timings.verifyMs = Date.now() - verifyStarted;
}

/** `--release`: any blocked request to a non-local host fails an otherwise passing run. */
export function externalRequestFailure(urls: readonly string[]): PlayFailure | undefined {
  if (urls.length === 0) return undefined;
  return {
    code: 'play-runtime-failed',
    reason: 'external-request',
    message: clip(
      `The release page requested ${urls.length} non-local URL${urls.length === 1 ? '' : 's'} (blocked), first ${urls[0]}`,
      400,
    ),
  };
}

/** The report's `externalRequests`: clipped URLs, at most `MAX_EXTERNAL_REQUESTS`. */
export function externalRequestsField(urls: readonly string[]): readonly string[] {
  const kept = urls.slice(0, MAX_EXTERNAL_REQUESTS).map((url) => clip(url, 160));
  return urls.length > MAX_EXTERNAL_REQUESTS
    ? [...kept, `+${urls.length - MAX_EXTERNAL_REQUESTS} more`]
    : kept;
}

/** Open, wait for input, run the script and verify; each phase may end the run with a failure. */
async function runPlayPhases(run: PlayRun, browser: BrowserCapture | undefined): Promise<void> {
  const { loaded, recorder, startupTimeoutMs } = run.setup;
  if (!loaded.ok) {
    run.failure = { code: 'play-script-invalid', reason: loaded.reason, message: loaded.message };
    return;
  }
  if (run.cancelled) {
    run.failure = cancelledPlayFailure();
    return;
  }
  await openPlaySession(run, browser);
  if (run.cancelled) {
    run.failure = cancelledPlayFailure();
    return;
  }
  const session = run.session;
  if (session === undefined || !(await awaitPlayInput(run, session))) return;
  const context = createPlayContext(
    session,
    recorder,
    run.outputDir,
    startupTimeoutMs,
    run.abort.signal,
  );
  await runPlayScript(run, loaded.run, context);
  if (run.failure === undefined) await verifyPlayFinal(run, session);
  if (run.state === undefined && !run.abort.signal.aborted) {
    run.state = await context.state().catch(() => undefined);
  }
}

function rendererErrorField(captures: readonly BrowserCaptureRecord[]): {
  readonly rendererError?: CaptureRendererError;
} {
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const rendererError = captures[index]?.runtime.rendererError;
    if (rendererError != null) return { rendererError };
  }
  return {};
}

function buildPlayReport(run: PlayRun): PlayReport {
  const { setup, failure } = run;
  const browserReport = run.session?.report();
  return {
    schemaVersion: '1.1.0',
    passed: failure === undefined,
    mode:
      setup.release !== undefined ? 'release' : setup.host === undefined ? 'private' : 'session',
    ...(setup.release === undefined
      ? {}
      : {
          dist: relativeTo(setup.root, setup.release.distRoot),
          headers: setup.release.headers,
          externalRequests: externalRequestsField(run.externalRequests),
        }),
    root: setup.root,
    script: relativeTo(setup.root, setup.scriptPath),
    outputDir: run.outputDir,
    report: run.reportPath,
    ...(browserReport === undefined ? {} : { captureReport: browserReport.report }),
    ...(browserReport === undefined
      ? {}
      : { url: browserReport.url, backend: browserReport.backend }),
    timings: { ...run.timings, totalMs: Date.now() - setup.started },
    steps: setup.recorder.steps,
    screenshots: setup.recorder.screenshots,
    viewports: setup.viewports.map(viewportName),
    ...(run.returned === undefined ? {} : { returned: jsonSafe(run.returned) }),
    ...(run.state === undefined ? {} : { state: jsonSafe(run.state) }),
    ...(run.execution === undefined ? {} : { execution: run.execution }),
    ...rendererErrorField(browserReport?.captures ?? []),
    errors: {
      console: browserReport?.consoleErrors ?? [],
      page: browserReport?.pageErrors ?? [],
      inputWarnings: browserReport?.inputWarnings.length ?? 0,
    },
    ...(setup.recorder.warnings.length === 0
      ? {}
      : { warnings: groupPlayWarnings(setup.recorder.warnings) }),
    log: [...setup.recorder.log],
    ...finalFields(setup.recorder),
    ...(failure === undefined ? {} : { failure }),
  };
}

/**
 * Records the time scale, and marks a run that skipped part of the journey or left the
 * real-time loop as not final acceptance.
 */
export function finalFields(
  recorder: Pick<PlayRecorder, 'range' | 'timeScale' | 'clock'>,
): Pick<PlayReport, 'range' | 'timeScale' | 'clock' | 'final' | 'nonFinal'> {
  const range = recorder.range?.range;
  const scale = recorder.timeScale ?? 1;
  const nonFinal = [
    ...(range === undefined ? [] : [`step range ${stepRangeLabel(range)}`]),
    ...(scale === 1 ? [] : [`time scale ${scale}`]),
  ];
  const clock = recorder.clock;
  return {
    ...(range === undefined ? {} : { range }),
    timeScale: scale,
    ...(scale === 1 || clock === undefined
      ? {}
      : {
          clock: {
            stepSeconds: clock.stepSeconds,
            frames: clock.frames,
            gameSeconds: clock.gameSeconds,
            wallSeconds: clock.wallSeconds,
            checks: clock.checks,
            heldSeconds: clock.heldSeconds,
          },
        }),
    ...(nonFinal.length === 0 ? {} : { final: false as const, nonFinal }),
  };
}

async function playCommandResult(
  report: PlayReport,
  reportPath: string,
  detail: boolean,
): Promise<CommandResult<unknown>> {
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, bytes);
  // The compact result already names the report; `--detail` adds its digest reference.
  const artifacts: readonly ArtifactRef[] = detail
    ? [
        {
          kind: 'tool-result',
          uri: reportPath,
          mediaType: 'application/json',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
      ]
    : [];
  const error = playFailureError(report);
  return error === undefined
    ? { ok: true, value: playResultValue(report, detail), artifacts }
    : {
        ok: false,
        error: detail ? { ...error, detail: { ...error.detail, play: report } } : error,
        artifacts,
      };
}

async function playLocked(
  options: PlayOptions,
  toolRun: { readonly signal?: AbortSignal },
  setup: PlaySetup,
): Promise<CommandResult<unknown>> {
  const outputDir = playOutputDir(setup.root, setup.scriptPath);
  const run: PlayRun = {
    options,
    setup,
    outputDir,
    reportPath: resolve(outputDir, 'play.json'),
    timings: setup.lockMs >= 1_000 ? { lockMs: setup.lockMs } : {},
    abort: new AbortController(),
    requireUi: options.requireUi === true,
    session: undefined,
    cancelled: false,
    failure: undefined,
    returned: undefined,
    state: undefined,
    execution: undefined,
    scriptSettled: true,
    restoreConsole: undefined,
    externalRequests: [],
  };
  // External cancellation also closes the page so a startup wait ends promptly.
  // A borrowed page stays open: only the play's own helpers stop.
  const cancel = () => {
    run.cancelled = true;
    run.abort.abort();
    if (setup.host === undefined) void run.session?.close().catch(() => undefined);
  };
  if (toolRun.signal?.aborted === true) cancel();
  toolRun.signal?.addEventListener('abort', cancel, { once: true });
  const browser = setup.host === undefined ? createBrowserCapture(setup.root) : undefined;
  // The previous run of the same script is replaced so every path in the result is current.
  await clearPreviousRun(outputDir, run.reportPath);
  await mkdir(outputDir, { recursive: true });
  try {
    await runPlayPhases(run, browser);
  } finally {
    run.abort.abort();
    toolRun.signal?.removeEventListener('abort', cancel);
    if (browser === undefined) {
      if (run.restoreViewport !== undefined)
        await run.session?.page.setViewportSize(run.restoreViewport).catch(() => undefined);
    } else {
      await run.session?.close().catch(() => undefined);
      await browser.close();
      await run.releaseServer?.close().catch(() => undefined);
    }
    run.restoreConsole?.(!run.scriptSettled);
  }
  return playCommandResult(buildPlayReport(run), run.reportPath, options.detail === true);
}

class PlayTimeout extends Error {
  constructor(
    timeoutMs: number,
    readonly cancelled = false,
  ) {
    super(
      cancelled
        ? 'The playthrough was cancelled'
        : `The playthrough did not finish within ${timeoutMs} ms`,
    );
    this.name = 'PlayTimeout';
  }
}
