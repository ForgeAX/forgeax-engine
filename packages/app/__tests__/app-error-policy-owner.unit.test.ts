import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APP_ERROR_HINTS,
  APP_EXPECTED,
  AppError,
  createRendererInspectionError,
  type RendererInspectionFailureReason,
  type AppError as AppErrorType,
  type AppErrorCode,
  type AppDetailCanvasDetached,
  type AppDetailExecutionKernelFailed,
} from '../src/errors';

const CODES_IN_POLICY_ORDER = [
  'app-not-started',
  'app-already-running',
  'app-canvas-detached',
  'app-frame-step-invalid',
  'app-system-update-failed',
  'app-pointer-lock-failed',
  'app-plugin-activation-failed',
  'app-execution-worker-unavailable',
  'app-execution-bootstrap-failed',
  'app-execution-deadline-exceeded',
  'app-execution-kernel-failed',
  'app-execution-stale-world',
  'app-execution-rebuild-failed',
  'app-renderer-inspection-unavailable',
] as const satisfies readonly AppErrorCode[];

const EXPECTED_IN_POLICY_ORDER = [
  'state must be "running" or "paused" to accept stop/pause/resume; "idle" / "stopped" terminal sinks reject',
  'state must be "idle" or "paused" to start; "running" handles ignore subsequent start() calls',
  'canvas.isConnected === true at createApp(canvas) entry',
  'stepFrame(deltaSeconds) runs only while the App is paused and deltaSeconds is finite and non-negative',
  'world.update(world), renderer.draw(world), and frame-loop callbacks complete without failure',
  'pointer-lock request (W3C requestPointerLock or host lockProvider.requestLock) to succeed; failure signals the browser rejected the lock or the host provider threw',
  'every requested Cordis plugin fiber reaches a stable active or pending state',
  'the explicitly enabled worker has its required browser capabilities and an Engine Worker owner',
  'the bootstrap URL imports a module whose default export completes as an ExecutionBootstrapEntry in the selected Engine Realm',
  'the execution startup, handshake or frame completes within its configured bounded deadline',
  'a shared kernel completes every dispatched shard without leaving a possibly partial World write',
  'every execution message targets the currently active World identity before it can write',
  'explicit rebuild disposes the poisoned World and bootstraps a fresh World identity in the surviving Engine Realm',
  'a read-only inspection returns the complete actual Renderer snapshot from the current ready session within the caller deadline',
] as const;

const HINTS_IN_POLICY_ORDER = [
  'check getState() before calling stop/pause/resume; rebuild the handle via createApp({...}) when the previous one terminated on device-lost',
  'call stop() first or audit start() call sites; the second start() is a no-op so state is preserved',
  'append the canvas to the document tree before calling createApp(canvas), or use the assemble entry createApp({ renderer, world }) when the host already manages canvas lifetime',
  'pause the App before deterministic stepping and pass an explicit finite delta; resume after the bounded step sequence completes',
  'inspect detail.cause for the original thrown value (EcsError / RhiError / host system bug); detail.systemName names the offending system when the call site can supply it',
  'remain in unlocked state; the next trusted click will automatically retry the lock request. inspect detail.path ("w3c" or "provider") and detail.cause to determine the root cause',
  'inspect detail.cause and the plugin fiber effects; repair the failing activation before creating the App again',
  'inspect detail.worker, detail.reason and detail.missingCapabilities; use auto for capability fallback or enable the Engine Worker dependency',
  'inspect detail.phase, moduleUrl and cause; export one default ExecutionBootstrapEntry that creates only realm-local engine state',
  'inspect detail.phase and timeoutMs; the timed-out Worker has been terminated, so fix startup or frame work before creating a new App',
  'do not retry or draw the poisoned World; inspect detail.kernelName and cause, then call app.execution.rebuild()',
  'discard the late message and keep the current World; inspect expectedIdentity, receivedIdentity and messageKind',
  'inspect detail.cause; this App remains stopped, so fix the bootstrap failure or create a new App explicitly',
  'inspect detail.reason and cause; preserve unavailable or stale results and do not synthesize Renderer fields or extend the caller deadline',
] as const;

describe('AppError policy owner', () => {
  it('projects the exact fourteen-code policy surface with stable own-key order', () => {
    expect(CODES_IN_POLICY_ORDER).toHaveLength(14);
    expect(new Set(CODES_IN_POLICY_ORDER).size).toBe(14);

    for (const policy of [APP_EXPECTED, APP_ERROR_HINTS]) {
      expect(Object.keys(policy)).toEqual(CODES_IN_POLICY_ORDER);
      expect(Object.getOwnPropertyNames(policy)).toEqual(CODES_IN_POLICY_ORDER);
      for (const code of CODES_IN_POLICY_ORDER) {
        expect(Object.prototype.propertyIsEnumerable.call(policy, code)).toBe(true);
      }
    }

    expect(Object.values(APP_EXPECTED)).toEqual(EXPECTED_IN_POLICY_ORDER);
    expect(Object.values(APP_ERROR_HINTS)).toEqual(HINTS_IN_POLICY_ORDER);
  });

  it('keeps every expected and hint string byte-identical', () => {
    for (const [index, code] of CODES_IN_POLICY_ORDER.entries()) {
      expect(APP_EXPECTED[code]).toBe(EXPECTED_IN_POLICY_ORDER[index]);
      expect(APP_ERROR_HINTS[code]).toBe(HINTS_IN_POLICY_ORDER[index]);
    }
  });

  it('rejects unknown codes and narrows detail from the code discriminant', () => {
    const acceptsCode = (code: AppErrorCode): AppErrorCode => code;
    // @ts-expect-error -- the policy-derived closed union rejects unknown codes.
    acceptsCode('app-invalid');

    const readDetail = (error: AppErrorType): string => {
      if (error.code === 'app-canvas-detached') {
        expectTypeOf(error.detail).toEqualTypeOf<AppDetailCanvasDetached>();
        return error.detail.canvasId ?? 'canvas';
      }
      if (error.code === 'app-execution-kernel-failed') {
        expectTypeOf(error.detail).toEqualTypeOf<AppDetailExecutionKernelFailed>();
        return error.detail.kernelName;
      }
      return error.code;
    };

    const canvasError = new AppError({
      code: 'app-canvas-detached',
      expected: APP_EXPECTED['app-canvas-detached'],
      hint: APP_ERROR_HINTS['app-canvas-detached'],
      detail: { canvasId: 'main' },
    });
    const kernelError = new AppError({
      code: 'app-execution-kernel-failed',
      expected: APP_EXPECTED['app-execution-kernel-failed'],
      hint: APP_ERROR_HINTS['app-execution-kernel-failed'],
      detail: {
        kernelName: 'shared-query',
        worldIdentity: 'world-1',
        cause: new Error('partial write'),
        partialWrite: true,
        retryable: false,
      },
    });
    expect(readDetail(canvasError)).toBe('main');
    expect(readDetail(kernelError)).toBe('shared-query');
  });

  it('preserves public record types and representative correlated AppError construction', () => {
    expectTypeOf(APP_EXPECTED).toEqualTypeOf<Readonly<Record<AppErrorCode, string>>>();
    expectTypeOf(APP_ERROR_HINTS).toEqualTypeOf<Readonly<Record<AppErrorCode, string>>>();

    const canvasError = new AppError({
      code: 'app-canvas-detached',
      expected: APP_EXPECTED['app-canvas-detached'],
      hint: APP_ERROR_HINTS['app-canvas-detached'],
      detail: { canvasId: 'main' },
    });
    expectTypeOf(canvasError).toEqualTypeOf<
      Extract<AppErrorType, { readonly code: 'app-canvas-detached' }>
    >();
    expectTypeOf(canvasError.detail).toEqualTypeOf<AppDetailCanvasDetached>();
    expect(canvasError.code).toBe('app-canvas-detached');
    expect(canvasError.detail.canvasId).toBe('main');

    const cause = new Error('partial write');
    const kernelError = new AppError({
      code: 'app-execution-kernel-failed',
      expected: APP_EXPECTED['app-execution-kernel-failed'],
      hint: APP_ERROR_HINTS['app-execution-kernel-failed'],
      detail: {
        kernelName: 'shared-query',
        worldIdentity: 'world-1',
        cause,
        partialWrite: true,
        retryable: false,
      },
    });
    expectTypeOf(kernelError).toEqualTypeOf<
      Extract<AppErrorType, { readonly code: 'app-execution-kernel-failed' }>
    >();
    expectTypeOf(kernelError.detail).toEqualTypeOf<AppDetailExecutionKernelFailed>();
    expect(kernelError.detail.cause).toBe(cause);
    expect(kernelError.message).toContain('app-execution-kernel-failed');
  });
});

it('owns the closed inspection failure guidance and preserves the original cause', () => {
  const cause = { code: 'owner-cause', expected: 'device stays alive', hint: 'preserve' };
  const error = createRendererInspectionError('transport', cause);
  expect(error.code).toBe('app-renderer-inspection-unavailable');
  expect(error.expected).toBe(APP_EXPECTED[error.code]);
  expect(error.hint).toBe(APP_ERROR_HINTS[error.code]);
  expect(error.detail).toEqual({ reason: 'transport', cause });
  expect(error.detail.cause).toBe(cause);
  expectTypeOf(error).toEqualTypeOf<Extract<AppErrorType, { readonly code: 'app-renderer-inspection-unavailable' }>>();
  const acceptsReason = (reason: RendererInspectionFailureReason) => reason;
  // @ts-expect-error -- expected inspection failures have an owning closed reason union.
  acceptsReason('frame-failed');
});
