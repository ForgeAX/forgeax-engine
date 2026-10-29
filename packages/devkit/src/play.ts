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
import { type ExecutionHealth, executionHealth } from './execution-health.js';
import { failureSummary } from './failure-summary.js';
import {
  collectLayout,
  DEFAULT_PLAY_VIEWPORTS,
  layoutIssues,
  MAX_LAYOUT_ISSUES,
  type PlayLayoutIssue,
  type PlayViewport,
  parsePlayViewports,
  viewportName,
} from './play-layout.js';
import { acquirePlayLock } from './play-lock.js';
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
  | 'lock-unavailable';
/**
 * Why a playthrough step threw; `script-error` covers assertions and any other script throw.
 * `advance-invalid`: `advance` arguments are out of range; `advance-failed`: the App refused a step.
 */
export type PlayStepFailureReason =
  | 'script-error'
  | 'wait-timeout'
  | 'state-unavailable'
  | 'advance-invalid'
  | 'advance-failed';
/** The first final runtime check that failed after a passing script. */
export type PlayRuntimeCheck =
  | 'fatal'
  | 'renderer-error'
  | 'browser-errors'
  | 'flat-canvas'
  | 'ui-missing'
  | 'execution-unhealthy'
  | 'execution-unavailable'
  | 'final-frame-timeout';

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
  /** Labels the enclosed work; a failure reports the innermost step name. */
  step<T>(name: string, run: () => Promise<T> | T): Promise<T>;
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
    /** Presses and releases with the same frame-observed hold as `keyboard.press`. */
    click(
      at: PlayPoint,
      options?: { readonly button?: 'left' | 'right' | 'middle' },
    ): Promise<void>;
    move(to: PlayPoint): Promise<void>;
    /** Drags with the left button, or `button: 'right'` for right-button look controls. */
    drag(
      from: PlayPoint,
      to: PlayPoint,
      options?: { readonly button?: 'left' | 'right' | 'middle' },
    ): Promise<void>;
  };
  wait(ms: number): Promise<void>;
  /** Captures the composed page (canvas and DOM UI) into the play output directory. */
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
   * one for a screenshot and the HUD layout check (warnings, never a failure).
   */
  readonly viewports?: string;
  /** Require a mounted child under `#game-ui` in the final frame. */
  readonly requireUi?: boolean;
  /** Script budget after input opens. Default 300000. */
  readonly timeoutMs?: number;
  /** Return the complete report instead of the compact summary. */
  readonly detail?: boolean;
  /** Progress lines on stderr: one at start, then at most one per 30 s. Default true. */
  readonly progress?: boolean;
}

export interface PlayStepRecord {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
}

/** One closed failure: `reason` narrows per `code`. */
export type PlayFailure = {
  readonly message: string;
  readonly step?: string;
  readonly action?: string;
  readonly screenshot?: string;
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
  readonly schemaVersion: '1.0.0';
  readonly passed: boolean;
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
  /** HUD layout warnings from every viewport; checked only after a passing final frame. */
  readonly layout: readonly PlayLayoutIssue[];
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
  readonly log: readonly string[];
  readonly failure?: PlayFailure;
}

const PRESS_MS = 50;
/** Frames an input must stay held so the frame-start scan observes it. */
const INPUT_FRAMES = 3;
const INPUT_FRAME_WAIT_MS = 2_000;
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
        const fatal = document.querySelector('#forgeax-fatal');
        if (fatal?.checkVisibility())
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

type PageAdvanceResult =
  | { readonly ok: true; readonly frames: number }
  | { readonly ok: false; readonly frames: number; readonly error: string };

/** @internal */
export interface PlayRecorder {
  readonly steps: PlayStepRecord[];
  readonly screenshots: PlayScreenshot[];
  readonly log: string[];
  step: string | undefined;
  action: string | undefined;
  readonly failedStep: WeakMap<object, string>;
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
  const act = (action: string) => {
    live();
    recorder.action = recorder.step === undefined ? action : `${recorder.step}: ${action}`;
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
        'The game inspection is unavailable; play reads state only from a development host.',
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
  const waitForState = async <T>(
    predicate: (state: T) => boolean,
    options: PlayWaitOptions = {},
  ): Promise<T> => {
    const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    // Each read keeps its own bound: a read near the deadline must report the
    // wait timeout with the last state, not a starved evaluation.
    let last: T = await readState<T>(options.read);
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
  /** Keeps an input held until the Engine completes INPUT_FRAMES more frames. */
  const holdForFrames = async () => {
    const start = await completedFrame();
    await page.waitForTimeout(PRESS_MS);
    if (start === null) return;
    const deadline = Date.now() + INPUT_FRAME_WAIT_MS;
    while (Date.now() < deadline && !signal.aborted) {
      const now = await completedFrame();
      if (now === null || now >= start + INPUT_FRAMES) return;
      await page.waitForTimeout(16);
    }
  };
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
  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    live();
    const parent = recorder.step;
    const path = parent === undefined ? name : `${parent} > ${name}`;
    recorder.step = path;
    const started = Date.now();
    const record = (ok: boolean) => {
      if (recorder.steps.length < MAX_STEPS)
        recorder.steps.push({ name: path, ok, ms: Date.now() - started });
    };
    try {
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
  /** Steps the paused App inside one page evaluation, then resumes it. */
  const advanceTime = async (seconds: number, stepSeconds: number, render: boolean) => {
    const range = advanceRangeError(seconds, stepSeconds);
    if (range !== undefined) throw new PlayHelperError('advance-invalid', range);
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
  return {
    page,
    signal,
    step,
    async state(read) {
      act(`state ${read ?? ''}`.trim());
      return await readState(read);
    },
    async waitFor(predicate, options) {
      act(`waitFor ${options?.read ?? ''}`.trim());
      return await waitForState(predicate, options);
    },
    async advance(seconds, options = {}) {
      act(`advance ${seconds} s`);
      return await step(`advance ${seconds} s`, async () => {
        await advanceTime(seconds, options.stepSeconds ?? 1 / 60, options.render === true);
        return await readState(options.read);
      });
    },
    keyboard: {
      async press(key) {
        act(`keyboard.press ${key}`);
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
        act(`keyboard.hold ${list.join('+')}`);
        try {
          for (const key of list) await page.keyboard.down(key);
          if (typeof until === 'number') {
            await page.waitForTimeout(until);
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
        act(`mouse.click ${JSON.stringify(at)}`);
        const point = await canvasPoint(at);
        const button = options?.button === undefined ? {} : { button: options.button };
        await page.mouse.move(point.x, point.y);
        try {
          await page.mouse.down(button);
          await holdForFrames();
        } finally {
          await release([() => page.mouse.up(button)]);
        }
      },
      async move(to) {
        act(`mouse.move ${JSON.stringify(to)}`);
        const point = await canvasPoint(to);
        await page.mouse.move(point.x, point.y, { steps: 4 });
      },
      async drag(from, to, options) {
        act(`mouse.drag ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
        const button = options?.button === undefined ? {} : { button: options.button };
        const start = await canvasPoint(from);
        const end = await canvasPoint(to);
        await page.mouse.move(start.x, start.y);
        try {
          await page.mouse.down(button);
          await holdForFrames();
          await page.mouse.move(end.x, end.y, { steps: 10 });
          await holdForFrames();
        } finally {
          await release([() => page.mouse.up(button)]);
        }
      },
    },
    async wait(ms) {
      act(`wait ${ms}`);
      await page.waitForTimeout(ms);
    },
    async screenshot(name) {
      act(`screenshot ${name}`);
      return takeScreenshot(session, recorder, outputDir, name);
    },
    async reload() {
      act('reload');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: startupTimeoutMs });
      const gate = await waitForInputOpen(page, startupTimeoutMs);
      if (gate.state !== 'open')
        throw new Error(
          gate.state === 'fatal'
            ? `Reload failed: ${clip(gate.message, 300)}`
            : `Input stayed closed for ${startupTimeoutMs} ms after reload`,
        );
    },
  };
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

/** Byte budget of the compact `value` or `error`; the CLI envelope adds about 60 bytes. */
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

/** One line per layout warning for the compact result. */
function layoutLines(issues: readonly PlayLayoutIssue[], keep = 3): readonly string[] {
  const lines = issues
    .slice(0, keep)
    .map((issue) =>
      clip(
        `${issue.viewport} ${issue.kind} ${issue.a}${issue.b === undefined ? '' : ` vs ${issue.b}`}`,
        140,
      ),
    );
  return issues.length > keep ? [...lines, `+${issues.length - keep} more`] : lines;
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
    ...(report.layout.length === 0 ? {} : { layout: layoutLines(report.layout) }),
    errors: { console: report.errors.console.length, page: report.errors.page.length },
    report: clip(relativeTo(report.root, report.report), 160),
  };
  // Layout warnings shrink to one line before screenshots go, and go last.
  let output = fitBytes(value, ['state', 'returned', 'rendererError'], PLAY_COMPACT_BYTES);
  if (jsonBytes(output) > PLAY_COMPACT_BYTES && 'layout' in output)
    output = { ...output, layout: layoutLines(report.layout, 1) };
  return fitBytes(output, ['screenshots', 'layout'], PLAY_COMPACT_BYTES);
}

const SCRIPT_INVALID = {
  expected: 'a playthrough module whose default export is an async function (play) => {}',
  hint: 'Fix the module path or export, then rerun.',
} as const;

/** Structured failure for a report that did not pass; `undefined` when it passed. */
const STEP_FAILURE_HINT =
  'Inspect the failing step, state and screenshot; fix the game or the script, then rerun.';
const STEP_FAILURE_HINTS: Readonly<Record<PlayStepFailureReason, string>> = {
  'script-error': STEP_FAILURE_HINT,
  'wait-timeout': STEP_FAILURE_HINT,
  'state-unavailable': 'Register the read projection the script reads, or pass its id.',
  'advance-invalid': `Pass 0 < seconds <= ${MAX_ADVANCE_SECONDS} and 0 < stepSeconds <= ${MAX_ADVANCE_STEP_SECONDS}, at most ${MAX_ADVANCE_FRAMES} frames.`,
  'advance-failed':
    'Inspect detail.message for the App step refusal; advance needs a development host.',
};

export function playFailureError(report: PlayReport): CommandError | undefined {
  const failure = report.failure;
  if (failure === undefined) return undefined;
  const firstError = report.errors.page[0] ?? report.errors.console[0];
  const raw: Record<string, unknown> = {
    reason: failure.reason,
    message: clip(failure.message, 200),
    ...(failure.step === undefined ? {} : { step: clip(failure.step, 80) }),
    ...(failure.action === undefined ? {} : { action: clip(failure.action, 100) }),
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
  const error = (expected: string, hint: string): CommandError => {
    const shape = playError(failure.code, expected, hint, {});
    const budget = PLAY_COMPACT_BYTES - jsonBytes(shape);
    return {
      ...shape,
      detail: fitBytes(raw, ['log', 'firstError', 'state', 'action', 'cause', 'message'], budget),
    };
  };
  switch (failure.code) {
    case 'play-script-invalid':
      return error(SCRIPT_INVALID.expected, SCRIPT_INVALID.hint);
    case 'play-not-ready':
      return error(
        'the game to open input (html[data-forgeax-input="open"]) after its first ready frame',
        failure.reason === 'startup-failed'
          ? 'Repair the startup fatal shown in the screenshot, then rerun.'
          : 'Inspect detail.cause, the capture report and screenshot for the startup blocker.',
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
 * Checks the HUD layout in the play viewport, then resizes the page to each
 * further viewport and applies the final-frame gate there (strict capture: no
 * fatal, no browser errors, a rendered canvas, and `--require-ui`'s `#game-ui`
 * child) before the same layout check. A
 * resize or DOM read that fails records an `incomplete` warning and ends the
 * check; a failed gate at a viewport fails the play.
 */
async function checkViewports(
  session: BrowserCaptureSession,
  recorder: PlayRecorder,
  outputDir: string,
  viewports: readonly PlayViewport[],
  requireUi: boolean,
): Promise<{ readonly issues: readonly PlayLayoutIssue[]; readonly failure?: PlayFailure }> {
  const issues: PlayLayoutIssue[] = [];
  // `incomplete` warnings lead, so the warning budget never hides an unfinished check.
  const done = (failure?: PlayFailure) => ({
    issues: [
      ...issues.filter((issue) => issue.kind === 'incomplete'),
      ...issues.filter((issue) => issue.kind !== 'incomplete'),
    ].slice(0, MAX_LAYOUT_ISSUES),
    ...(failure === undefined ? {} : { failure }),
  });
  for (const [index, viewport] of viewports.entries()) {
    const name = viewportName(viewport);
    const incomplete = (error: unknown) =>
      issues.push({ viewport: name, kind: 'incomplete', a: errorMessage(error) });
    try {
      if (index > 0) await session.page.setViewportSize(viewport);
      await settleFrames(session.page);
    } catch (error) {
      incomplete(error);
      return done();
    }
    if (index > 0) {
      const before = session.report().captures.length;
      try {
        await takeScreenshot(
          session,
          recorder,
          outputDir,
          `viewport ${name}`,
          'validate',
          requireUi,
        );
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
        return done({
          code: 'play-runtime-failed',
          reason: check,
          message: clip(`At viewport ${name}: ${runtimeCheckMessage(check, record, error)}`, 400),
          ...(record === undefined ? {} : { screenshot: record.output }),
        });
      }
    }
    try {
      issues.push(...layoutIssues(await collectLayout(session.page)));
    } catch (error) {
      incomplete(error);
      return done();
    }
  }
  return done();
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
  run: { readonly signal?: AbortSignal } = {},
): Promise<CommandResult<unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? process.cwd());
  const scriptPath = resolve(root, options.script ?? '');
  const viewports = parsePlayViewports(options.viewports ?? DEFAULT_PLAY_VIEWPORTS);
  if (!viewports.ok)
    return {
      ok: false,
      error: {
        code: 'tool-invalid-args',
        expected: '--viewports WxH[,WxH...]',
        hint: `Pass distinct viewports, for example ${DEFAULT_PLAY_VIEWPORTS}.`,
        detail: { message: viewports.message },
      },
    };
  const budget = await readProjectStartupTimeoutMs(root);
  if (!budget.ok) return budget;
  const startupTimeoutMs = budget.value ?? DEV_EXECUTION_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const write =
    options.progress === false
      ? () => undefined
      : (line: string) => void process.stderr.write(`forgeax project play: ${line}\n`);
  const script = relativeTo(root, scriptPath);
  const lockPath = resolve(root, '.forgeax/play/lock.json');
  const recorder: PlayRecorder = {
    steps: [],
    screenshots: [],
    log: [],
    step: undefined,
    action: undefined,
    failedStep: new WeakMap(),
  };
  // Only the module's own import and run are captured, not DevKit/Vite startup output.
  const restoreImportConsole = captureConsole(recorder.log);
  const loaded: LoadedScript = await (options.script === undefined
    ? Promise.resolve({
        ok: false,
        reason: 'missing',
        message: 'Pass the playthrough module path.',
      } as const)
    : loadScript(scriptPath)
  ).finally(() => restoreImportConsole());
  const status = { phase: 'opening the dev runtime and browser' };
  write(
    `started ${script}; stdout prints one JSON result when it ends (startup budget ${Math.round(startupTimeoutMs / 1000)} s, script budget ${Math.round(timeoutMs / 1000)} s); progress every ${PLAY_PROGRESS_INTERVAL_MS / 1000} s here on stderr`,
  );
  write(await playExpectationLine(resolve(playOutputDir(root, scriptPath), 'play.json')));
  // Elapsed time in progress lines includes any wait for the lock.
  const stopProgress = startPlayProgress(write, () =>
    status.phase === 'script'
      ? `running the script${recorder.step === undefined ? '' : ` (step "${clip(recorder.step, 80)}")`}, ${recorder.steps.length} steps done`
      : status.phase,
  );
  try {
    const lock = await acquirePlayLock(lockPath, {
      script,
      // An invalid script never queues: it reports at once unless the lock is free.
      timeoutMs: loaded.ok ? playLockWaitMs(timeoutMs, startupTimeoutMs) : 0,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      onWait: (holder) => {
        const who = holder === undefined ? '' : ` (pid ${holder.pid}, ${holder.script})`;
        status.phase = `waiting for another play of this project${who}`;
        const age =
          holder === undefined
            ? ''
            : `, ${Math.round((Date.now() - holder.startedAt) / 1000)} s in`;
        write(`${status.phase}${age}; plays of one project run one at a time (${lockPath})`);
      },
    });
    if (!lock.ok) {
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
    status.phase = 'opening the dev runtime and browser';
    try {
      return await playLocked(options, run, {
        started,
        root,
        scriptPath,
        loaded,
        startupTimeoutMs,
        timeoutMs,
        viewports: viewports.value,
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
export async function playExpectationLine(reportPath: string): Promise<string> {
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
  return `${expected}; wait for this command in one call (your shell tool's longest wait) instead of re-checking it`;
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
  layout: readonly PlayLayoutIssue[];
  restoreConsole: ((abandoned?: boolean) => void) | undefined;
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

async function openPlaySession(run: PlayRun, browser: BrowserCapture): Promise<void> {
  const { options, setup, outputDir } = run;
  const openStarted = Date.now();
  try {
    run.session = await browser.open({
      backend: options.backend ?? 'auto',
      launchProfile: 'development',
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
    await recordScriptError(run, error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  // Health is read for the play viewport, before any resize.
  run.execution = await readExecution(session.page);
  if (run.failure === undefined && run.execution !== 'healthy') {
    run.failure = {
      code: 'play-runtime-failed',
      reason: run.execution === 'unavailable' ? 'execution-unavailable' : 'execution-unhealthy',
      message: `Execution report: ${run.execution}`,
    };
  }
  if (run.failure === undefined) {
    const checked = await checkViewports(
      session,
      recorder,
      run.outputDir,
      viewports,
      run.requireUi,
    );
    run.layout = checked.issues;
    run.failure = checked.failure;
  }
  run.timings.verifyMs = Date.now() - verifyStarted;
}

/** Open, wait for input, run the script and verify; each phase may end the run with a failure. */
async function runPlayPhases(run: PlayRun, browser: BrowserCapture): Promise<void> {
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
    schemaVersion: '1.0.0',
    passed: failure === undefined,
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
    layout: run.layout,
    ...(run.returned === undefined ? {} : { returned: jsonSafe(run.returned) }),
    ...(run.state === undefined ? {} : { state: jsonSafe(run.state) }),
    ...(run.execution === undefined ? {} : { execution: run.execution }),
    ...rendererErrorField(browserReport?.captures ?? []),
    errors: {
      console: browserReport?.consoleErrors ?? [],
      page: browserReport?.pageErrors ?? [],
      inputWarnings: browserReport?.inputWarnings.length ?? 0,
    },
    log: [...setup.recorder.log],
    ...(failure === undefined ? {} : { failure }),
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
    layout: [],
    restoreConsole: undefined,
  };
  // External cancellation also closes the page so a startup wait ends promptly.
  const cancel = () => {
    run.cancelled = true;
    run.abort.abort();
    void run.session?.close().catch(() => undefined);
  };
  if (toolRun.signal?.aborted === true) cancel();
  toolRun.signal?.addEventListener('abort', cancel, { once: true });
  const browser = createBrowserCapture(setup.root);
  // The previous run of the same script is replaced so every path in the result is current.
  await clearPreviousRun(outputDir, run.reportPath);
  await mkdir(outputDir, { recursive: true });
  try {
    await runPlayPhases(run, browser);
  } finally {
    run.abort.abort();
    toolRun.signal?.removeEventListener('abort', cancel);
    await run.session?.close().catch(() => undefined);
    await browser.close();
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
