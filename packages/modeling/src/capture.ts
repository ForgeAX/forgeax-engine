import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Model } from './model';
import type { Rig } from './rig';

/** Checkpoints retained per captured session. */
export const MAX_CHECKPOINTS = 8;

/** Step snapshots retained per captured session, in FXEM bytes. */
export const MAX_STEP_BYTES = 64 * 1024 * 1024;

export interface CaptureOptions {
  /** Keep an FXEM snapshot after every successful operation (step replay). */
  readonly steps?: boolean;
}

interface ActiveCapture {
  readonly sessions: Model[];
  readonly rigs: Rig[];
  readonly options: CaptureOptions;
}

/**
 * The capture in progress lives in one realm-wide slot, not in this module: a bundler
 * can load the kernel twice in one realm (a program-scoped copy for a Pack build and a
 * shared copy for its host), and a capture must still see the sessions the build makes.
 * It only routes registration; no output depends on it.
 */
const SLOT = Symbol.for('forgeax.modeling.capture');
const realm = globalThis as { [SLOT]?: ActiveCapture };

/** @internal Called by the Model constructor; returns the capture options of a captured session. */
export function registerCapturedSession(model: Model): CaptureOptions | undefined {
  const active = realm[SLOT];
  if (active === undefined) return undefined;
  active.sessions.push(model);
  return active.options;
}

/** @internal True while `captureModels` runs: deferred work (mesh jobs) then runs in place. */
export function captureActive(): boolean {
  return realm[SLOT] !== undefined;
}

/** @internal Called by the Rig constructor. */
export function registerCapturedRig(rig: Rig): void {
  realm[SLOT]?.rigs.push(rig);
}

/**
 * Run `body` (typically a Pack build) and return every modeling session and rig it
 * created. Captured sessions record checkpoints and export provenance; ordinary
 * builds pay nothing. Captures are single-flight: nesting returns an error.
 */
export async function captureModels<T>(
  body: () => T | Promise<T>,
  options: CaptureOptions = {},
): Promise<
  Result<
    { readonly value: T; readonly sessions: readonly Model[]; readonly rigs: readonly Rig[] },
    ModelingError
  >
> {
  if (realm[SLOT] !== undefined) {
    return err(modelingError('model-precondition', 'one capture runs at a time', {}));
  }
  const sessions: Model[] = [];
  const rigs: Rig[] = [];
  realm[SLOT] = { sessions, rigs, options };
  try {
    const value = await body();
    return ok({ value, sessions, rigs });
  } finally {
    delete realm[SLOT];
  }
}

/** Author source location of a journal entry or checkpoint (captured sessions only). */
export interface SourceSite {
  /** Absolute file path (file URLs are converted; query strings are dropped). */
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

const FRAME = /\(?((?:file|https?):\/\/[^\s)]+|\/[^\s)]+):(\d+):(\d+)\)?\s*$/;

/** A stack frame's location as a path (file URLs converted, query strings dropped). */
function framePath(line: string): { path: string; line: number; column: number } | undefined {
  const match = FRAME.exec(line);
  if (match === null) return undefined;
  const location = (match[1] as string).replace(/[?#].*$/, '');
  const path = location.startsWith('file://')
    ? decodeURIComponent(new URL(location).pathname)
    : location;
  return { path, line: Number(match[2]), column: Number(match[3]) };
}

/**
 * @internal The first stack frame outside the kernel: the author line that called
 * the operation. Lines are exact when the build source keeps its positions (Node
 * type stripping does); transpiled builds report the transpiled position.
 * The kernel's directory is taken from this function's own frame, as the host
 * reports it (built bundle, source file, or source-mapped back to the source).
 */
export function authorSite(): SourceSite | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  const frames = stack.split('\n').slice(1);
  const own = frames.map(framePath).find((f) => f !== undefined);
  if (own === undefined) return undefined;
  const kernel = own.path.slice(0, own.path.lastIndexOf('/') + 1);
  for (const line of frames) {
    const frame = framePath(line);
    // Run from source, the kernel's own tests sit under its root but are author code.
    if (
      frame === undefined ||
      (frame.path.startsWith(kernel) && !frame.path.includes('/__tests__/'))
    )
      continue;
    return frame;
  }
  return undefined;
}
