// @forgeax/engine-app -- AppError + closed AppErrorCode union (14 members) +
// APP_ERROR_HINTS / APP_EXPECTED + discriminated AppErrorDetail per code.
//
// Shape:
//   - AppErrorCode = closed union 14 members (charter P4 closed-union
//     exhaustive switch needs no default fallback; tsc strict mode guards
//     completeness; AGENTS.md "Errors are structured" + AC-07).
//     Members:
//       - 'app-not-started'
//       - 'app-already-running'
//       - 'app-canvas-detached'
//       - 'app-system-update-failed'
//       - 'app-pointer-lock-failed'
//     Plan-strategy D-3 lock: device-lost stays on RhiErrorCode (18-member
//     union); the AppError surface does NOT add a seventh 'app-device-lost'
//     member. Host onError listener receives RhiError({code:'device-lost'})
//     verbatim through the fan-out.
//
//   - AppError class = 4-field surface (.code / .expected / .hint /
//     .detail) byte-for-byte parallel to RhiError (packages/rhi/src/errors.ts).
//     The class extends Error so debug surfaces (stack, name) work in host
//     environments; AI users walk .code / .detail by property access (charter
//     P3 explicit failure: never parse the message string).
//
//   - AppError is exposed as a discriminated union (variant per code) so AI
//     users get .detail narrowing for free after `if (err.code === '...')`:
//
//       if (err.code === 'app-canvas-detached') {
//         console.warn('reattach canvas', err.detail.canvasId);
//       }
//
//     Constructor accepts a generic args object and infers the variant from
//     the literal `code` argument; `detail` must satisfy the per-code
//     payload (`AppErrorDetailFor<C>`). Callers therefore cannot supply
//     non-canonical fields like `{ state: 'running' }` on the
//     'app-already-running' arm.
//
//   - APP_ERROR_HINTS / APP_EXPECTED are 14-key Records keyed by AppErrorCode;
//     one private policy owner supplies both projections. The focused policy-owner
//     proof asserts that every code has the exact expected and hint strings.
//
// Related: requirements AC-07 / AC-04 / AC-09; plan-strategy section 2 D-3
// (6-member lock) + D-4 ('app-system-update-failed' detail = { cause,
// systemName? }) + D-6 (dual-layer instanceof + switch consumption form);
// research section 2.7 (AppErrorCode lands in AGENTS.md Error model table
// alongside RhiErrorCode et al.); charter P3 (explicit failure) + P4
// (closed-union exhaustive switch).

import type { RhiError } from '@forgeax/engine-rhi/errors';
import type { ExecutionCapabilityName, ExecutionWorker } from './execution/types';

/**
 * Closed AppErrorCode union (14 members).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'app-not-started'` | `stop()` / `pause()` / `resume()` invoked while the rAF loop is in the terminal `'idle'` or `'stopped'` state (post-device-lost terminal sink). The handle has no live frame to interrupt; AI users either call `start()` first or accept that this handle is dead and rebuild via `createApp({...})`. |
 * | `'app-already-running'` | second `start()` invocation against an already-running handle; the call is a no-op state-machine-wise (state preserved). |
 * | `'app-canvas-detached'` | `createApp(canvas)` thin wrapper found `canvas.isConnected === false` at entry. Detail carries optional `canvasId` so the host can surface the offending canvas in a multi-canvas page (D-2 minor). |
 * | `'app-system-update-failed'` | World update, renderer draw, or a frame-loop callback failed; the original failure value is forwarded on `detail.cause`. `detail.systemName` is optional when the call site can name the failing owner. |
 * | `'app-pointer-lock-failed'` | `attachInputAuto`'s `onLockError` callback received a lock failure from the input backend. `detail.path` carries `'w3c'` (W3C `requestPointerLock` rejection) or `'provider'` (host-injected `lockProvider.requestLock` throw/reject). `detail.cause` carries the original rejection value verbatim. The host recovers by remaining in unlocked state; the next trusted click will retry the lock request. |
 * | `'app-renderer-inspection-unavailable'` | Read-only inspection is unavailable, cancelled, stale, invalid or cannot be delivered; `detail.reason` is closed and `detail.cause` retains producer failure. This is returned to the observer, not emitted as a frame fault. |
 *
 * Plan-strategy D-4 locked the count at 6; device-lost rides RhiErrorCode.
 */
export type AppErrorCode = keyof typeof appErrorPolicy;

/**
 * Detail variant for the `'app-canvas-detached'` arm.
 *
 * `canvasId` carries an optional identifier the host can surface to AI
 * users when multiple canvases live on the page (e.g. preview vs live
 * canvas). `undefined` when the host did not assign an id.
 */
export interface AppDetailCanvasDetached {
  readonly canvasId?: string | undefined;
}

/**
 * Detail variant for the `'app-system-update-failed'` arm (plan-strategy D-4).
 *
 * `cause` carries the original thrown value verbatim so AI users can
 * `cause instanceof EcsError` / `cause instanceof RhiError` narrow without
 * losing structure. `systemName` is populated when the call site can name
 * the offending system (input-attach cleanup path forwards
 * `FRAME_START_SCAN_SYSTEM_NAME`).
 */
export interface AppDetailSystemUpdateFailed {
  readonly cause: unknown;
  readonly systemName?: string | undefined;
}

/**
 * Detail variant for the `'app-pointer-lock-failed'` arm (plan-strategy D-4).
 *
 * `path` discriminates between W3C `requestPointerLock` rejections (`'w3c'`)
 * and host-injected `lockProvider.requestLock` throw/reject (`'provider'`).
 * `cause` carries the original rejection value verbatim so AI users can
 * narrow further (e.g. `cause instanceof DOMException` for W3C timeout
 * rejections).
 */
export interface AppDetailPointerLockFailed {
  readonly path: 'w3c' | 'provider';
  readonly cause: unknown;
}

/** Why a host-requested deterministic frame could not run. */
export interface AppDetailFrameStepInvalid {
  readonly state: 'idle' | 'running' | 'paused' | 'stopped';
  readonly deltaSeconds: number;
  readonly reason: 'state' | 'delta' | 'credit';
}

export interface AppDetailExecutionWorkerUnavailable {
  readonly worker: ExecutionWorker;
  readonly reason: 'engine-disabled' | 'capability-unavailable';
  readonly missingCapabilities: readonly ExecutionCapabilityName[];
}

export interface AppDetailExecutionBootstrapFailed {
  readonly phase: 'import' | 'export' | 'prepare' | 'bootstrap' | 'data';
  readonly moduleUrl: string;
  readonly cause: unknown;
}

/** Original startup failure thrown by a Cordis plugin fiber. */
export interface AppDetailPluginActivationFailed {
  readonly cause: unknown;
}

export interface AppDetailExecutionDeadlineExceeded {
  readonly phase: 'startup' | 'handshake' | 'frame' | 'dispose';
  readonly timeoutMs: number;
}

export interface AppDetailExecutionKernelFailed {
  readonly kernelName: string;
  readonly worldIdentity: string;
  readonly cause: unknown;
  readonly partialWrite: true;
  readonly retryable: false;
}

export interface AppDetailExecutionStaleWorld {
  readonly expectedIdentity: string;
  readonly receivedIdentity: string;
  readonly messageKind: string;
}

/** Closed failure reasons for read-only inspection, distinct from frame faults. */
export type RendererInspectionFailureReason =
  | 'unavailable'
  | 'not-ready'
  | 'stale-session'
  | 'cancelled'
  | 'request-limit'
  | 'session-ended'
  | 'disposed'
  | 'timeout'
  | 'transport'
  | 'inspection'
  | 'invalid-result';

export interface AppDetailRendererInspectionUnavailable {
  readonly reason: RendererInspectionFailureReason;
  readonly cause?: unknown;
}

export interface AppDetailExecutionRebuildFailed {
  readonly worldIdentity: string | null;
  readonly cause: unknown;
}

/**
 * Empty-detail shape for the 2 codes that carry no payload
 * (`'app-not-started'`, `'app-already-running'`).
 *
 * Modelled as `Readonly<Record<string, never>>` so literal builders use
 * `{}` while still narrowing under tsc strict (no extra property allowed).
 */
export type AppDetailEmpty = Readonly<Record<string, never>>;

/**
 * Conditional resolver from `AppErrorCode` to its detail payload type.
 *
 * Used by the constructor signature so `new AppError({ code: 'X', ... })`
 * narrows the `detail` parameter to the variant payload at compile time.
 */
export type AppErrorDetailFor<C extends AppErrorCode> = C extends 'app-canvas-detached'
  ? AppDetailCanvasDetached
  : C extends 'app-frame-step-invalid'
    ? AppDetailFrameStepInvalid
    : C extends 'app-system-update-failed'
      ? AppDetailSystemUpdateFailed
      : C extends 'app-pointer-lock-failed'
        ? AppDetailPointerLockFailed
        : C extends 'app-plugin-activation-failed'
          ? AppDetailPluginActivationFailed
          : C extends 'app-execution-worker-unavailable'
            ? AppDetailExecutionWorkerUnavailable
            : C extends 'app-execution-bootstrap-failed'
              ? AppDetailExecutionBootstrapFailed
              : C extends 'app-execution-deadline-exceeded'
                ? AppDetailExecutionDeadlineExceeded
                : C extends 'app-execution-kernel-failed'
                  ? AppDetailExecutionKernelFailed
                  : C extends 'app-execution-stale-world'
                    ? AppDetailExecutionStaleWorld
                    : C extends 'app-execution-rebuild-failed'
                      ? AppDetailExecutionRebuildFailed
                      : C extends 'app-renderer-inspection-unavailable'
                        ? AppDetailRendererInspectionUnavailable
                        : AppDetailEmpty;

/**
 * Tagged union of `.detail` payloads carried by structured AppError.
 *
 * Each variant maps to its `AppErrorCode` arm via `AppErrorDetailFor<C>`;
 * the variants are unique by structural fields (`AppDetailCanvasDetached`
 * has `canvasId`, `AppDetailSystemUpdateFailed` has `cause`, the empty
 * shape has neither).
 */
export type AppErrorDetail = AppErrorDetailFor<AppErrorCode>;

/**
 * Render a one-line summary of `detail.cause` for embedding in
 * `AppError.message`. `cause` is structurally typed (`unknown`) because
 * upstream may throw any value; callers downstream still get the verbatim
 * value via `err.detail.cause` — this helper exists so tools that only see
 * `err.message` (`console.error(err)`, raw stringification) still surface
 * the root cause without consumers manually expanding `detail`.
 *
 * Closed precedence:
 *   1. Structured engine errors (RhiError / EcsError / RenderGraphError /
 *      AssetError / ShaderError / ...) carry `.code` + `.message`; render
 *      `<Name> <code>: <message>`.
 *   2. Plain `Error`: render `<name>: <message>`.
 *   3. Anything else: `String(cause)` (covers thrown strings, numbers, null).
 *
 * Newlines are replaced with `' / '` so the final AppError message stays a
 * single line (callers already split on `\n` in stack traces, so a multiline
 * message would corrupt their parsing).
 */
function summarizeCause(cause: unknown): string {
  if (cause === null || cause === undefined) return String(cause);
  if (typeof cause !== 'object') return String(cause);
  const r = cause as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof r.name === 'string' && r.name.length > 0 ? r.name : 'Error';
  const code = typeof r.code === 'string' && r.code.length > 0 ? r.code : '';
  const message = typeof r.message === 'string' ? r.message : '';
  const head = code !== '' ? `${name} ${code}` : name;
  const body = message !== '' ? `: ${message}` : '';
  return `${head}${body}`.replace(/\s*\n+\s*/g, ' / ');
}

class AppErrorClass extends Error {
  readonly code: AppErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AppErrorDetail;

  constructor(args: {
    code: AppErrorCode;
    expected: string;
    hint: string;
    detail: AppErrorDetail;
  }) {
    // Surface `detail.cause` directly inside `.message` for the
    // `'app-system-update-failed'` arm. Without this, a generic
    // `console.error(err)` shows only the wrapper expected/hint and
    // hides the actual EcsError / RhiError / host-system Error that
    // tripped the frame loop. The verbatim `cause` value remains on
    // `err.detail.cause` for two-level-narrow consumers (charter P3).
    let causeSuffix = '';
    if (args.code === 'app-system-update-failed') {
      const d = args.detail as AppDetailSystemUpdateFailed;
      const sys =
        typeof d.systemName === 'string' && d.systemName.length > 0
          ? ` (system=${d.systemName})`
          : '';
      causeSuffix = `; cause: ${summarizeCause(d.cause)}${sys}`;
    } else if (args.code === 'app-pointer-lock-failed') {
      const d = args.detail as AppDetailPointerLockFailed;
      causeSuffix = `; path: ${d.path}; cause: ${summarizeCause(d.cause)}`;
    } else if (args.code === 'app-plugin-activation-failed') {
      const d = args.detail as AppDetailPluginActivationFailed;
      causeSuffix = `; cause: ${summarizeCause(d.cause)}`;
    } else if (args.code === 'app-execution-bootstrap-failed') {
      const d = args.detail as AppDetailExecutionBootstrapFailed;
      causeSuffix = `; phase: ${d.phase}; cause: ${summarizeCause(d.cause)}`;
    } else if (args.code === 'app-execution-kernel-failed') {
      const d = args.detail as AppDetailExecutionKernelFailed;
      causeSuffix = `; kernel: ${d.kernelName}; cause: ${summarizeCause(d.cause)}`;
    } else if (args.code === 'app-execution-rebuild-failed') {
      const d = args.detail as AppDetailExecutionRebuildFailed;
      causeSuffix = `; cause: ${summarizeCause(d.cause)}`;
    }
    super(`[AppError ${args.code}] expected: ${args.expected}; hint: ${args.hint}${causeSuffix}`);
    this.name = 'AppError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Variant intersection: an `AppErrorClass` instance whose `code` literal
 * narrows to `C` and whose `detail` narrows to `AppErrorDetailFor<C>`. The
 * shape lets `if (err.code === 'X')` simultaneously narrow `err.detail` to
 * the per-code payload (charter P3 + AC-07 discriminated union).
 */
type AppErrorVariant<C extends AppErrorCode> = AppErrorClass & {
  readonly code: C;
  readonly detail: AppErrorDetailFor<C>;
};

/**
 * Public AppError type — discriminated union of the policy variants.
 *
 * AI-user form (charter P3 explicit failure):
 *
 * ```ts
 * function recover(err: AppError): string {
 *   switch (err.code) {
 *     case 'app-not-started':         return 'call start() first';
 *     case 'app-already-running':     return 'state preserved; ignore';
 *     case 'app-canvas-detached':     return `reattach ${err.detail.canvasId ?? 'canvas'}`;
 *     case 'app-system-update-failed':
 *       return err.detail.cause instanceof Error ? err.detail.cause.message : 'unknown';
 *     case 'app-pointer-lock-failed':
 *       return `lock failed (${err.detail.path}): ${err.detail.cause}`;
 *   }
 * }
 * ```
 */
export type AppError = {
  [C in AppErrorCode]: AppErrorVariant<C>;
}[AppErrorCode];

interface AppErrorConstructor {
  new <C extends AppErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: AppErrorDetailFor<C>;
  }): AppErrorVariant<C>;
  readonly prototype: AppErrorClass;
}

/**
 * AppError constructor — `new AppError({ code, expected, hint, detail })`.
 *
 * The generic `C` is inferred from the literal `code` argument, which
 * narrows `detail` to the per-code payload (`AppErrorDetailFor<C>`) and
 * narrows the return type to the corresponding `AppErrorVariant<C>` so the
 * call site walks the discriminated union without manual cast.
 *
 * The constructor delegates to the `AppErrorClass` runtime; the typed-cast
 * here is the ergonomic affordance for AI users (TS class declarations
 * cannot directly express `<C> ... AppErrorVariant<C>` polymorphism).
 */
export const AppError: AppErrorConstructor = AppErrorClass as unknown as AppErrorConstructor;

/**
 * `expected` table — the engine-side invariant that was violated when each
 * code surfaces. AI users read this as the L2 detail (charter F2 priority
 * text); `.hint` carries the recovery action.
 *
 * 14 keys; the focused policy-owner proof locks the exact key set and values.
 * locks the count and non-emptiness of every entry.
 */
type AppErrorPolicy = { readonly expected: string; readonly hint: string };

const appErrorPolicy = {
  'app-not-started': {
    expected:
      'state must be "running" or "paused" to accept stop/pause/resume; "idle" / "stopped" terminal sinks reject',
    hint: 'check getState() before calling stop/pause/resume; rebuild the handle via createApp({...}) when the previous one terminated on device-lost',
  },
  'app-already-running': {
    expected:
      'state must be "idle" or "paused" to start; "running" handles ignore subsequent start() calls',
    hint: 'call stop() first or audit start() call sites; the second start() is a no-op so state is preserved',
  },
  'app-canvas-detached': {
    expected: 'canvas.isConnected === true at createApp(canvas) entry',
    hint: 'append the canvas to the document tree before calling createApp(canvas), or use the assemble entry createApp({ renderer, world }) when the host already manages canvas lifetime',
  },
  'app-frame-step-invalid': {
    expected:
      'stepFrame(deltaSeconds) runs only while the App is paused and deltaSeconds is finite and non-negative',
    hint: 'pause the App before deterministic stepping and pass an explicit finite delta; resume after the bounded step sequence completes',
  },
  'app-system-update-failed': {
    expected:
      'world.update(world), renderer.draw(world), and frame-loop callbacks complete without failure',
    hint: 'inspect detail.cause for the original thrown value (EcsError / RhiError / host system bug); detail.systemName names the offending system when the call site can supply it',
  },
  'app-pointer-lock-failed': {
    expected:
      'pointer-lock request (W3C requestPointerLock or host lockProvider.requestLock) to succeed; failure signals the browser rejected the lock or the host provider threw',
    hint: 'remain in unlocked state; the next trusted click will automatically retry the lock request. inspect detail.path ("w3c" or "provider") and detail.cause to determine the root cause',
  },
  'app-plugin-activation-failed': {
    expected: 'every requested Cordis plugin fiber reaches a stable active or pending state',
    hint: 'inspect detail.cause and the plugin fiber effects; repair the failing activation before creating the App again',
  },
  'app-execution-worker-unavailable': {
    expected:
      'the explicitly enabled worker has its required browser capabilities and an Engine Worker owner',
    hint: 'inspect detail.worker, detail.reason and detail.missingCapabilities; use auto for capability fallback or enable the Engine Worker dependency',
  },
  'app-execution-bootstrap-failed': {
    expected:
      'the bootstrap URL imports a module whose default export completes as an ExecutionBootstrapEntry in the selected Engine Realm',
    hint: 'inspect detail.phase, moduleUrl and cause; export one default ExecutionBootstrapEntry that creates only realm-local engine state',
  },
  'app-execution-deadline-exceeded': {
    expected:
      'the execution startup, handshake or frame completes within its configured bounded deadline',
    hint: 'inspect detail.phase and timeoutMs; the timed-out Worker has been terminated, so fix startup or frame work before creating a new App',
  },
  'app-execution-kernel-failed': {
    expected:
      'a shared kernel completes every dispatched shard without leaving a possibly partial World write',
    hint: 'do not retry or draw the poisoned World; inspect detail.kernelName and cause, then call app.execution.rebuild()',
  },
  'app-execution-stale-world': {
    expected:
      'every execution message targets the currently active World identity before it can write',
    hint: 'discard the late message and keep the current World; inspect expectedIdentity, receivedIdentity and messageKind',
  },
  'app-execution-rebuild-failed': {
    expected:
      'explicit rebuild disposes the poisoned World and bootstraps a fresh World identity in the surviving Engine Realm',
    hint: 'inspect detail.cause; this App remains stopped, so fix the bootstrap failure or create a new App explicitly',
  },
  'app-renderer-inspection-unavailable': {
    expected:
      'a read-only inspection returns the complete actual Renderer snapshot from the current ready session within the caller deadline',
    hint: 'inspect detail.reason and cause; preserve unavailable or stale results and do not synthesize Renderer fields or extend the caller deadline',
  },
} satisfies Record<string, AppErrorPolicy>;

export const APP_EXPECTED: Readonly<Record<AppErrorCode, string>> = Object.fromEntries(
  Object.entries(appErrorPolicy).map(([code, policy]) => [code, policy.expected]),
) as Readonly<Record<AppErrorCode, string>>;

export const APP_ERROR_HINTS: Readonly<Record<AppErrorCode, string>> = Object.fromEntries(
  Object.entries(appErrorPolicy).map(([code, policy]) => [code, policy.hint]),
) as Readonly<Record<AppErrorCode, string>>;

/**
 * Type guard for narrowing `CanvasAppError`-compatible mixed signals to AppError.
 *
 * The fan-out signature is `(err: CanvasAppError) => void`; AI users
 * who want to handle only the AppError leg call `if (isAppError(err)) ...`
 * before walking `.code`. Reverse-compatible with `instanceof AppError`
 * (the class is exposed); the function form is provided as the
 * canonical idiom in JSDoc / README so AI users do not need to reason
 * about cross-realm `instanceof` quirks.
 *
 * The parameter accepts the complete App/RHI boundary union so callers can
 * narrow the error without casts.
 */
export function isAppError(err: AppError | RhiError): err is AppError {
  return err instanceof AppErrorClass;
}

/** One policy owner shared by public execution inspection and ordinary consumers. */
export function createRendererInspectionError(
  reason: RendererInspectionFailureReason,
  cause?: unknown,
): Extract<AppError, { readonly code: 'app-renderer-inspection-unavailable' }> {
  return new AppError({
    code: 'app-renderer-inspection-unavailable',
    expected: APP_EXPECTED['app-renderer-inspection-unavailable'],
    hint: APP_ERROR_HINTS['app-renderer-inspection-unavailable'],
    detail: { reason, ...(cause === undefined ? {} : { cause }) },
  });
}
