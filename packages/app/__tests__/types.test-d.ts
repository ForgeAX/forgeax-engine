// Error variants intersect the backing class. Check detail assignability in both
// directions so equivalent intersection representations retain exact contracts.
// Compile-time contracts: closed codes, correlated detail, and exhaustive consumption.

import type { RhiError } from '@forgeax/engine-rhi/errors';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { describe, expectTypeOf, it } from 'vitest';

import {
  AppError,
  type AppDetailCanvasDetached,
  type AppDetailExecutionBootstrapFailed,
  type AppDetailExecutionDeadlineExceeded,
  type AppDetailExecutionKernelFailed,
  type AppDetailExecutionRebuildFailed,
  type AppDetailExecutionStaleWorld,
  type AppDetailExecutionWorkerUnavailable,
  type AppDetailEmpty,
  type AppDetailFrameStepInvalid,
  type AppDetailPluginActivationFailed,
  type AppDetailPointerLockFailed,
  type AppDetailRendererInspectionUnavailable,
  type AppDetailSystemUpdateFailed,
  type AppErrorCode,
  type AppErrorDetail,
} from '../src/errors';
import type {
  LoadGameDetailImportFailed,
  LoadGameDetailInvalidFormat,
  LoadGameDetailModuleNotFound,
  LoadGameError,
  LoadGameErrorCode,
  LoadGameErrorDetail,
} from '../src/load-game-errors';
import { LoadGameError as LoadGameErrorConstructor } from '../src/load-game-errors';
import type { GameHost } from '../src/game-context';

it('GameHost distinguishes Host controls from source World services', () => {
  expectTypeOf<GameHost['canvas']>().toEqualTypeOf<
    HTMLCanvasElement | OffscreenCanvas | undefined
  >();
  expectTypeOf<GameHost['app']>().not.toHaveProperty('renderer');
  expectTypeOf<GameHost['app']>().not.toHaveProperty('dispose');
  expectTypeOf<GameHost['app']>().not.toHaveProperty('world');
  expectTypeOf<GameHost['app']>().not.toHaveProperty('assets');
  expectTypeOf<Extract<GameHost['app'], { world: unknown }>>().toHaveProperty('world');
  expectTypeOf<Extract<GameHost['app'], { world: unknown }>>().toHaveProperty('assets');
  expectTypeOf<GameHost>().toHaveProperty('assets');
});

describe('AppErrorCode is the current closed union (AC-07)', () => {
  it('matches the exact code owner', () => {
    expectTypeOf<AppErrorCode>().toEqualTypeOf<
      | 'app-not-started'
      | 'app-already-running'
      | 'app-canvas-detached'
      | 'app-frame-step-invalid'
      | 'app-system-update-failed'
      | 'app-pointer-lock-failed'
      | 'app-execution-worker-unavailable'
      | 'app-execution-bootstrap-failed'
      | 'app-execution-deadline-exceeded'
      | 'app-execution-kernel-failed'
      | 'app-execution-stale-world'
      | 'app-execution-rebuild-failed'
      | 'app-plugin-activation-failed'
      | 'app-renderer-inspection-unavailable'
    >();
  });

  it('is assignable from each current string literal', () => {
    expectTypeOf<'app-not-started'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-already-running'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-canvas-detached'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-frame-step-invalid'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-system-update-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-pointer-lock-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-worker-unavailable'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-bootstrap-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-deadline-exceeded'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-kernel-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-stale-world'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-rebuild-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-renderer-inspection-unavailable'>().toMatchTypeOf<AppErrorCode>();
  });

  it('rejects strings outside the closed union (D-3 lock: no app-device-lost)', () => {
    // @ts-expect-error -- 'app-device-lost' lives on RhiErrorCode, not on AppErrorCode (D-3 lock).
    const _bad: AppErrorCode = 'app-device-lost';
    void _bad;
  });
});

describe('AppError.detail is discriminated per code (AC-07)', () => {
  it('app-canvas-detached narrows detail to { canvasId?: string }', () => {
    const e = new AppError({
      code: 'app-canvas-detached',
      expected: '',
      hint: '',
      detail: { canvasId: 'preview' },
    });
    if (e.code === 'app-canvas-detached') {
      expectTypeOf(e.detail).toMatchTypeOf<{ readonly canvasId?: string | undefined }>();
    }
  });

  it('app-system-update-failed narrows detail to { cause: unknown, systemName?: string }', () => {
    const e = new AppError({
      code: 'app-system-update-failed',
      expected: '',
      hint: '',
      detail: { cause: new Error('boom'), systemName: 'host-physics' },
    });
    if (e.code === 'app-system-update-failed') {
      expectTypeOf(e.detail).toMatchTypeOf<{
        readonly cause: unknown;
        readonly systemName?: string | undefined;
      }>();
    }
  });

  it('the other 2 codes carry empty-object detail {}', () => {
    const a = new AppError({ code: 'app-not-started', expected: '', hint: '', detail: {} });
    const b = new AppError({ code: 'app-already-running', expected: '', hint: '', detail: {} });
    if (a.code === 'app-not-started') {
      expectTypeOf(a.detail).toMatchTypeOf<Readonly<Record<string, never>>>();
    }
    if (b.code === 'app-already-running') {
      expectTypeOf(b.detail).toMatchTypeOf<Readonly<Record<string, never>>>();
    }
  });

  it('app-pointer-lock-failed narrows detail to { path: "w3c"|"provider", cause: unknown }', () => {
    const e = new AppError({
      code: 'app-pointer-lock-failed',
      expected: '',
      hint: '',
      detail: { path: 'w3c', cause: new Error('test') },
    });
    if (e.code === 'app-pointer-lock-failed') {
      expectTypeOf(e.detail).toMatchTypeOf<{
        readonly path: 'w3c' | 'provider';
        readonly cause: unknown;
      }>();
    }
  });

  it('execution variants preserve constructor inference and detail narrowing', () => {
    const unavailable = new AppError({
      code: 'app-execution-worker-unavailable',
      expected: '',
      hint: '',
      detail: {
        worker: 'kernels' as const,
        reason: 'capability-unavailable' as const,
        missingCapabilities: ['sharedArrayBuffer'],
      },
    });
    const bootstrap = new AppError({
      code: 'app-execution-bootstrap-failed',
      expected: '',
      hint: '',
      detail: { phase: 'bootstrap', moduleUrl: 'bootstrap.mjs', cause: new Error('boom') },
    });
    const deadline = new AppError({
      code: 'app-execution-deadline-exceeded',
      expected: '',
      hint: '',
      detail: { phase: 'frame', timeoutMs: 100 },
    });
    const kernel = new AppError({
      code: 'app-execution-kernel-failed',
      expected: '',
      hint: '',
      detail: {
        kernelName: 'sum',
        worldIdentity: 'world-1',
        cause: new Error('partial'),
        partialWrite: true,
        retryable: false,
      },
    });
    const stale = new AppError({
      code: 'app-execution-stale-world',
      expected: '',
      hint: '',
      detail: { expectedIdentity: 'world-2', receivedIdentity: 'world-1', messageKind: 'ready' },
    });
    const rebuild = new AppError({
      code: 'app-execution-rebuild-failed',
      expected: '',
      hint: '',
      detail: { worldIdentity: null, cause: new Error('rebuild') },
    });
    if (unavailable.code === 'app-execution-worker-unavailable') {
      expectTypeOf(unavailable.detail).toMatchTypeOf<AppDetailExecutionWorkerUnavailable>();
      expectTypeOf<AppDetailExecutionWorkerUnavailable>().toMatchTypeOf<typeof unavailable.detail>();
    }
    if (bootstrap.code === 'app-execution-bootstrap-failed') {
      expectTypeOf(bootstrap.detail).toMatchTypeOf<AppDetailExecutionBootstrapFailed>();
      expectTypeOf<AppDetailExecutionBootstrapFailed>().toMatchTypeOf<typeof bootstrap.detail>();
    }
    if (deadline.code === 'app-execution-deadline-exceeded') {
      expectTypeOf(deadline.detail).toMatchTypeOf<AppDetailExecutionDeadlineExceeded>();
      expectTypeOf<AppDetailExecutionDeadlineExceeded>().toMatchTypeOf<typeof deadline.detail>();
    }
    if (kernel.code === 'app-execution-kernel-failed') {
      expectTypeOf(kernel.detail).toMatchTypeOf<AppDetailExecutionKernelFailed>();
      expectTypeOf<AppDetailExecutionKernelFailed>().toMatchTypeOf<typeof kernel.detail>();
    }
    if (stale.code === 'app-execution-stale-world') {
      expectTypeOf(stale.detail).toMatchTypeOf<AppDetailExecutionStaleWorld>();
      expectTypeOf<AppDetailExecutionStaleWorld>().toMatchTypeOf<typeof stale.detail>();
    }
    if (rebuild.code === 'app-execution-rebuild-failed') {
      expectTypeOf(rebuild.detail).toMatchTypeOf<AppDetailExecutionRebuildFailed>();
      expectTypeOf<AppDetailExecutionRebuildFailed>().toMatchTypeOf<typeof rebuild.detail>();
    }
  });
});

describe('error detail unions derive from their code resolvers', () => {
  it('preserves the complete AppError detail union', () => {
    expectTypeOf<AppErrorDetail>().toEqualTypeOf<
      | AppDetailEmpty
      | AppDetailFrameStepInvalid
      | AppDetailPluginActivationFailed
      | AppDetailCanvasDetached
      | AppDetailSystemUpdateFailed
      | AppDetailPointerLockFailed
      | AppDetailExecutionWorkerUnavailable
      | AppDetailExecutionBootstrapFailed
      | AppDetailExecutionDeadlineExceeded
      | AppDetailExecutionKernelFailed
      | AppDetailExecutionStaleWorld
      | AppDetailExecutionRebuildFailed
      | AppDetailRendererInspectionUnavailable
    >();
  });

  it('preserves the complete LoadGameError detail union', () => {
    expectTypeOf<LoadGameErrorDetail>().toEqualTypeOf<
      | LoadGameDetailModuleNotFound
      | LoadGameDetailInvalidFormat
      | LoadGameDetailImportFailed
    >();
  });
});

describe('LoadGameError is a code-derived correlated union', () => {
  it('matches the exact three-code owner', () => {
    expectTypeOf<LoadGameErrorCode>().toEqualTypeOf<
      'module-not-found' | 'invalid-format' | 'import-failed'
    >();
    expectTypeOf<'module-not-found'>().toMatchTypeOf<LoadGameErrorCode>();
    expectTypeOf<'invalid-format'>().toMatchTypeOf<LoadGameErrorCode>();
    expectTypeOf<'import-failed'>().toMatchTypeOf<LoadGameErrorCode>();
    // @ts-expect-error -- unknown load-game codes are outside the closed union.
    const _badCode: LoadGameErrorCode = 'unknown';
    void _badCode;
  });

  it('preserves constructor inference and code-driven detail narrowing', () => {
    const moduleNotFound = new LoadGameErrorConstructor({
      code: 'module-not-found',
      expected: '',
      hint: '',
      detail: { slug: 'game-default' },
    });
    const invalidFormat = new LoadGameErrorConstructor({
      code: 'invalid-format',
      expected: '',
      hint: '',
      detail: { exportKeys: ['default'] },
    });
    const importFailed = new LoadGameErrorConstructor({
      code: 'import-failed',
      expected: '',
      hint: '',
      detail: { cause: new Error('network') },
    });
    if (moduleNotFound.code === 'module-not-found') {
      expectTypeOf(moduleNotFound.detail).toMatchTypeOf<LoadGameDetailModuleNotFound>();
      expectTypeOf<LoadGameDetailModuleNotFound>().toMatchTypeOf<typeof moduleNotFound.detail>();
    }
    if (invalidFormat.code === 'invalid-format') {
      expectTypeOf(invalidFormat.detail).toMatchTypeOf<LoadGameDetailInvalidFormat>();
      expectTypeOf<LoadGameDetailInvalidFormat>().toMatchTypeOf<typeof invalidFormat.detail>();
    }
    if (importFailed.code === 'import-failed') {
      expectTypeOf(importFailed.detail).toMatchTypeOf<LoadGameDetailImportFailed>();
      expectTypeOf<LoadGameDetailImportFailed>().toMatchTypeOf<typeof importFailed.detail>();
    }
  });

  it('rejects invalid code/detail pairs at construction', () => {
    const _wrongModuleDetail = new LoadGameErrorConstructor({
      code: 'module-not-found',
      expected: '',
      hint: '',
      // @ts-expect-error -- module-not-found requires the slug detail.
      detail: { exportKeys: [] },
    });
    const _wrongFormatDetail = new LoadGameErrorConstructor({
      code: 'invalid-format',
      expected: '',
      hint: '',
      // @ts-expect-error -- invalid-format requires the exportKeys detail.
      detail: { cause: new Error('wrong') },
    });
    void _wrongModuleDetail;
    void _wrongFormatDetail;
  });

  it('supports exhaustive LoadGameError consumption without a default arm', () => {
    function classify(error: LoadGameError): string {
      switch (error.code) {
        case 'module-not-found':
          return error.detail.slug;
        case 'invalid-format':
          return error.detail.exportKeys.join(',');
        case 'import-failed':
          return error.detail.cause instanceof Error ? error.detail.cause.message : 'unknown';
      }
      const _unreachable: never = error;
      return _unreachable;
    }
    expectTypeOf(classify).toBeFunction();
  });
});

describe('exhaustive switch over (AppError | RhiError) compiles with no default arm (AC-07)', () => {
  it('covers all current codes without a default fallback', () => {
    // The `never` return on the unreachable tail is what asserts
    // exhaustiveness: if a future commit adds a code without updating
    // this switch, the assignment to `_unreachable: never` fails tsc.
    function classify(err: AppError | RhiError): string {
      const code = err.code;
      switch (code) {
        case 'app-not-started':
          return 'a';
        case 'app-already-running':
          return 'b';
        case 'app-canvas-detached':
          return 'c';
        case 'app-frame-step-invalid':
          return 'd';
        case 'app-system-update-failed':
          return 'e';
        case 'app-pointer-lock-failed':
        case 'app-execution-worker-unavailable':
        case 'app-execution-bootstrap-failed':
        case 'app-execution-deadline-exceeded':
        case 'app-execution-kernel-failed':
        case 'app-execution-stale-world':
        case 'app-renderer-inspection-unavailable':
        case 'app-execution-rebuild-failed':
        case 'app-plugin-activation-failed':
          return 'f';
        case 'adapter-unavailable':
        case 'feature-not-enabled':
        case 'limit-exceeded':
        case 'shader-compile-failed':
        case 'rhi-not-available':
        case 'webgpu-runtime-error':
        case 'command-encoder-finished':
        case 'render-pass-not-ended':
        case 'queue-submit-failed':
        case 'queue-write-buffer-out-of-bounds':
        case 'render-system-no-camera':
        case 'render-system-multi-camera':
        case 'render-system-multi-light':
        case 'asset-not-registered':
        case 'device-lost':
        case 'oom':
        case 'internal-error':
        case 'hierarchy-broken':
        case 'destroy-after-destroy':
        case 'rhi-descriptor-invalid':
        case 'instancing-exceeds-uniform-cap':
        case 'render-system-empty-worlds':
        case 'render-system-owner-out-of-range':
        case 'rhi-texture-format-capability-unavailable':
          return 'rhi';
      }
      // Unreachable: tsc narrows `code` to `never` once every union arm
      // is consumed above. Assigning it back to `never` is the
      // exhaustiveness guard.
      const _unreachable: never = code;
      return _unreachable;
    }
    expectTypeOf(classify).toBeFunction();
  });
});

describe('dual-layer instanceof EngineEnvironmentError + switch pattern (D-6)', () => {
  it('AI-user form: outer instanceof narrows to EngineEnvironmentError; else closed-union switch', () => {
    // README + JSDoc + single source: this is the canonical D-6 form.
    // The fixture compiles only if the inner switch is exhaustive over
    // (AppError | RhiError) -- i.e. EngineEnvironmentError is consumed
    // by the outer instanceof branch and no longer reaches the switch.
    function consume(err: AppError | RhiError | EngineEnvironmentError): string {
      if (err instanceof EngineEnvironmentError) {
        const cause = err.detail.webgpuError;
        return `env: ${cause && 'code' in cause ? cause.code : cause?.message ?? 'no-webgpu-detail'}`;
      }
      const code = err.code;
      switch (code) {
        case 'app-not-started':
        case 'app-already-running':
        case 'app-canvas-detached':
        case 'app-frame-step-invalid':
        case 'app-system-update-failed':
        case 'app-pointer-lock-failed':
        case 'app-execution-worker-unavailable':
        case 'app-execution-bootstrap-failed':
        case 'app-execution-deadline-exceeded':
        case 'app-execution-kernel-failed':
        case 'app-execution-stale-world':
        case 'app-renderer-inspection-unavailable':
        case 'app-execution-rebuild-failed':
        case 'app-plugin-activation-failed':
          return 'app';
        case 'adapter-unavailable':
        case 'feature-not-enabled':
        case 'limit-exceeded':
        case 'shader-compile-failed':
        case 'rhi-not-available':
        case 'webgpu-runtime-error':
        case 'command-encoder-finished':
        case 'render-pass-not-ended':
        case 'queue-submit-failed':
        case 'queue-write-buffer-out-of-bounds':
        case 'render-system-no-camera':
        case 'render-system-multi-camera':
        case 'render-system-multi-light':
        case 'asset-not-registered':
        case 'device-lost':
        case 'oom':
        case 'internal-error':
        case 'hierarchy-broken':
        case 'destroy-after-destroy':
        case 'rhi-descriptor-invalid':
        case 'instancing-exceeds-uniform-cap':
        case 'render-system-empty-worlds':
        case 'render-system-owner-out-of-range':
        case 'rhi-texture-format-capability-unavailable':
          return 'rhi';
      }
      const _unreachable: never = code;
      return _unreachable;
    }
    expectTypeOf(consume).toBeFunction();
  });
});
