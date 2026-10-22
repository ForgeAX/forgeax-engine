import { testPlatform } from '../src/__tests__/platform-fixture';
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=8):
//   - packages/app/__tests__/create-app-physics.test.ts
//   - packages/app/__tests__/create-app-propagate-transforms.test.ts
//   - packages/app/__tests__/error-fanout.test.ts
//   - packages/app/__tests__/errors.test.ts
//   - packages/app/__tests__/frame-loop.test.ts
//   - packages/app/__tests__/load-game.test.ts
//   - packages/app/__tests__/ready-barrier.test.ts
//   - packages/app/__tests__/register-update.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { World } from '@forgeax/engine-ecs';
import { RhiError } from '@forgeax/engine-rhi/errors';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { Plugin } from '@forgeax/engine-plugin';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import type { RenderFrameInput, Renderer } from '@forgeax/engine-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app';
import {
  APP_ERROR_HINTS,
  APP_EXPECTED,
  AppError,
  type AppErrorCode,
} from '../src/errors';
import {
  ErrorFanoutRegistry,
  type ErrorFanoutOptions,
} from '../src/internal/error-fanout';
import {
  createFrameLoop,
  type FrameLoopHandle,
} from '../src/internal/frame-loop';
import { loadGame } from '../src/load-game';
import { INPUT_MAP_KEY, type ActionConfig } from '@forgeax/engine-input';
import { LoadGameError, type LoadGameErrorCode } from '../src/load-game-errors';

{
  // ─── from create-app-propagate-transforms.test.ts ───

  function identityTransformData() {
    return {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],};
  }

  describe('create-app-propagate-transforms.test.ts', () => {
    describe('createApp propagateTransforms wiring (verify-step Bug 2 regression)', () => {
      it('registerPropagateTransforms is importable from the @forgeax/engine-runtime barrel', () => {
        expect(typeof registerPropagateTransforms).toBe('function');
      });

      it('one world.update(1 / 60).unwrap() derives GlobalTransform.world from local Transform', () => {
        const world = new World();
        registerPropagateTransforms(world);

        const root = world
          .spawn({
            component: Transform,
            data: { ...identityTransformData(), pos: [1, 2, 3]},
          })
          .unwrap();

        world.update(1 / 60).unwrap();

        const t = world.get(root, GlobalTransform);
        expect(t.ok).toBe(true);
        if (!t.ok) return;
        const w = t.value.world;
        expect(w[12]).toBeCloseTo(1, 5);
        expect(w[13]).toBeCloseTo(2, 5);
        expect(w[14]).toBeCloseTo(3, 5);
      });
    });
  });
}

{
  // ─── from error-fanout.test.ts ───

  function makeFanout(opts?: ErrorFanoutOptions): ErrorFanoutRegistry {
    return new ErrorFanoutRegistry(opts);
  }

  function makeRendererStubEF(drawImpl?: () => unknown): Renderer {
    return {
      state: () => 'alive' as const,
      attach: (attachedWorld: World) => ({ ok: true, value: createRenderReadLease(attachedWorld) }),
      draw(_request: RenderFrameInput): unknown {
        if (drawImpl !== undefined) {
          return drawImpl();
        }
        return undefined;
      },
    } as unknown as Renderer;
  }

  function makeRafFakeEF(): {
    raf: (cb: (t: number) => void) => number;
    caf: (id: number) => void;
    pendingCallbacks: Array<(t: number) => void>;
  } {
    const pendingCallbacks: Array<(t: number) => void> = [];
    let nextId = 1;
    return {
      raf: (cb) => {
        pendingCallbacks.push(cb);
        return nextId++;
      },
      caf: (_id) => {
        // no-op; tests do not exercise cancel here
      },
      pendingCallbacks,
    };
  }

  function makeNowFakeEF(seq: number[]): () => number {
    let i = 0;
    return () => {
      const v = seq[i] ?? seq[seq.length - 1] ?? 0;
      i = Math.min(i + 1, seq.length);
      return v;
    };
  }

  describe('error-fanout.test.ts', () => {
    describe('ErrorFanoutRegistry path 1 -- multi-listener fan-out (AC-04)', () => {
      it('fire dispatches once to every registered listener', () => {
        const fan = makeFanout();
        const seen: string[][] = [[], [], []];
        fan.add((e) => {
          seen[0]?.push(e.code);
        });
        fan.add((e) => {
          seen[1]?.push(e.code);
        });
        fan.add((e) => {
          seen[2]?.push(e.code);
        });
        const synth: AppError = new AppError({
          code: 'app-system-update-failed',
          expected: 'world.update synchronous',
          hint: 'wrap host system code in try/catch or return Result',
          detail: { cause: new Error('boom') },
        });
        fan.fire(synth);
        expect(seen[0]).toEqual(['app-system-update-failed']);
        expect(seen[1]).toEqual(['app-system-update-failed']);
        expect(seen[2]).toEqual(['app-system-update-failed']);
      });
    });

    describe('ErrorFanoutRegistry path 2 -- duplicate add is no-op', () => {
      it('registering the same listener twice still fires once per event', () => {
        const fan = makeFanout();
        let count = 0;
        const cb = (): void => {
          count++;
        };
        fan.add(cb);
        fan.add(cb);
        const synth: AppError = new AppError({
          code: 'app-not-started',
          expected: 'state must be running',
          hint: 'call start() first',
          detail: {},
        });
        fan.fire(synth);
        expect(count).toBe(1);
      });
    });

    describe('ErrorFanoutRegistry path 3 -- unsubscribe handle', () => {
      it('add returns an unsubscribe fn; once called the listener stops receiving events', () => {
        const fan = makeFanout();
        let count = 0;
        const off = fan.add(() => {
          count++;
        });
        const synth: AppError = new AppError({
          code: 'app-already-running',
          expected: 'state must be idle or paused',
          hint: 'check getState() before retrying start',
          detail: {},
        });
        fan.fire(synth);
        expect(count).toBe(1);
        off();
        fan.fire(synth);
        expect(count).toBe(1);
        off();
        fan.fire(synth);
        expect(count).toBe(1);
      });
    });

    describe('ErrorFanoutRegistry path 4 -- console.error fallback when no listener', () => {
      let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
          // silence test stderr noise; we assert call args explicitly
        });
      });

      afterEach(() => {
        consoleErrorSpy.mockRestore();
      });

      it('no listener registered + silenceUnhandledErrors !== true -> console.error(err) called once', () => {
        const fan = makeFanout();
        const synth: AppError = new AppError({
          code: 'app-canvas-detached',
          expected: 'canvas in DOM',
          hint: 'append canvas before createApp',
          detail: { canvasId: 'preview' },
        });
        fan.fire(synth);
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy.mock.calls[0]?.[0]).toBe(synth);
      });
    });

    describe('ErrorFanoutRegistry path 5 -- silenceUnhandledErrors=true suppresses fallback', () => {
      let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
          // silence
        });
      });

      afterEach(() => {
        consoleErrorSpy.mockRestore();
      });

      it('no listener + silenceUnhandledErrors=true -> error dropped, console.error NOT called', () => {
        const fan = makeFanout({ silenceUnhandledErrors: true });
        const synth: AppError = new AppError({
          code: 'app-already-running',
          expected: 'state must not be running',
          hint: 'stop() before starting again',
          detail: {},
        });
        fan.fire(synth);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      });

      it('listener registered overrides fallback regardless of silence flag', () => {
        const fan = makeFanout({ silenceUnhandledErrors: false });
        let received: AppError | undefined;
        fan.add((e) => {
          received = e as AppError;
        });
        const synth: AppError = new AppError({
          code: 'app-system-update-failed',
          expected: 'world.update synchronous',
          hint: 'see detail.cause',
          detail: { cause: new Error('boom') },
        });
        fan.fire(synth);
        expect(received).toBe(synth);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      });
    });

    describe('frame-loop path 6 -- world.update throw wrap as app-system-update-failed (AC-04)', () => {
      it('world.update throws -> fanout.fire(AppError({code: app-system-update-failed, detail:{cause}})) + rAF continues', () => {
        const world = new World();
        const updateSpy = vi.spyOn(world, 'update');
        const cause = new Error('host system failed');
        let throwCount = 0;
        updateSpy.mockImplementation(() => {
          throwCount++;
          if (throwCount <= 3) {
            throw cause;
          }
        });
        const renderer = makeRendererStubEF();
        const errs: Array<AppError | unknown> = [];
        const fan = makeFanout();
        fan.add((e) => {
          errs.push(e);
        });
        const now = makeNowFakeEF([0, 16, 32, 48, 64, 80]);
        const { raf, pendingCallbacks } = makeRafFakeEF();
        const loop = createFrameLoop({world,renderer,onError: (e) => fan.fire(e), platform: testPlatform({now,raf})});
        loop.start();
        pendingCallbacks[0]?.(0);
        pendingCallbacks[1]?.(16);
        pendingCallbacks[2]?.(32);
        expect(errs.length).toBeGreaterThanOrEqual(3);
        const wrap = errs[0] as AppError;
        expect(wrap.code).toBe('app-system-update-failed');
        expect(wrap.detail.cause).toBe(cause);
        expect(pendingCallbacks.length).toBeGreaterThanOrEqual(4);
      });
    });

    describe('frame-loop path 7 -- renderer.draw Result.err passthrough (AC-04)', () => {
      it('renderer.draw returns Result.err(rhiErr) -> rhiErr passed verbatim to fanout + rAF continues', () => {
        const world = new World();
        const rhiErrCarrier = {
          code: 'webgpu-runtime-error' as const,
          expected: 'queue submission OK',
          hint: 'check device.lost or pipeline state',
          detail: {},
          message: '[RhiError webgpu-runtime-error] expected: ...; hint: ...',
          name: 'RhiError',
        };
        let drawCount = 0;
        const renderer = makeRendererStubEF(() => {
          drawCount++;
          if (drawCount <= 2) {
            return err(rhiErrCarrier as unknown as Error);
          }
          return ok(undefined);
        });
        const errs: Array<unknown> = [];
        const fan = makeFanout();
        fan.add((e) => {
          errs.push(e);
        });
        const now = makeNowFakeEF([0, 16, 32, 48, 64]);
        const { raf, pendingCallbacks } = makeRafFakeEF();
        const loop = createFrameLoop({world,renderer,onError: (e) => fan.fire(e), platform: testPlatform({now,raf})});
        loop.start();
        pendingCallbacks[0]?.(0);
        pendingCallbacks[1]?.(16);
        expect(errs.length).toBeGreaterThanOrEqual(2);
        expect(errs[0]).toBe(rhiErrCarrier);
        expect(pendingCallbacks.length).toBeGreaterThanOrEqual(3);
      });
    });
  });
}

{
  // ─── from errors.test.ts ───

  const APP_CODES: readonly AppErrorCode[] = [
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
    'app-execution-rebuild-failed',
    'app-renderer-inspection-unavailable',
  ] as const;

  describe('errors.test.ts', () => {
    describe('AppErrorCode closed union', () => {
      it('exposes one hint per code, each non-empty (bidirectional)', () => {
        expect(Object.keys(APP_ERROR_HINTS).length).toBe(APP_CODES.length);

        for (const code of APP_CODES) {
          const hint = APP_ERROR_HINTS[code];
          expect(typeof hint).toBe('string');
          expect(hint.length).toBeGreaterThan(0);
        }

        for (const key of Object.keys(APP_ERROR_HINTS)) {
          expect(APP_CODES).toContain(key as AppErrorCode);
        }
      });

      it('exposes one expected entry per code, each non-empty (bidirectional)', () => {
        expect(Object.keys(APP_EXPECTED).length).toBe(APP_CODES.length);

        for (const code of APP_CODES) {
          const expected = APP_EXPECTED[code];
          expect(typeof expected).toBe('string');
          expect(expected.length).toBeGreaterThan(0);
        }

        for (const key of Object.keys(APP_EXPECTED)) {
          expect(APP_CODES).toContain(key as AppErrorCode);
        }
      });
    });

    describe('AppError class -- 4-field surface aligned with RhiError', () => {
      it('exposes .code / .expected / .hint / .detail readonly fields', () => {
        const err = new AppError({
          code: 'app-not-started',
          expected: APP_EXPECTED['app-not-started'],
          hint: APP_ERROR_HINTS['app-not-started'],
          detail: {},
        });
        expect(err.code).toBe('app-not-started');
        expect(typeof err.expected).toBe('string');
        expect(typeof err.hint).toBe('string');
        expect(err.detail).toEqual({});
      });

      it('extends Error so debug surfaces (stack, name) work in host environments', () => {
        const err = new AppError({
          code: 'app-already-running',
          expected: APP_EXPECTED['app-already-running'],
          hint: APP_ERROR_HINTS['app-already-running'],
          detail: {},
        });
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('AppError');
        expect(err.message).toContain('app-already-running');
      });

      it('builds via new AppError({...}) for every closed-union member', () => {
        for (const code of APP_CODES) {
          const detail =
            code === 'app-renderer-inspection-unavailable'
              ? { reason: 'not-ready' as const }
              : code === 'app-canvas-detached'
              ? { canvasId: 'main' }
              : code === 'app-system-update-failed'
                ? { cause: new Error('boom') }
                : code === 'app-pointer-lock-failed'
                  ? { path: 'w3c' as const, cause: new Error('lock failed') }
                  : code === 'app-execution-worker-unavailable'
                    ? {
                        worker: 'kernels' as const,
                        reason: 'capability-unavailable' as const,
                        missingCapabilities: ['cross-origin-isolated'] as const,

                      }
                    : code === 'app-execution-bootstrap-failed'
                      ? {
                          phase: 'bootstrap' as const,
                          moduleUrl: '/bootstrap.js',
                          cause: new Error('bootstrap failed'),
                        }
                      : code === 'app-execution-deadline-exceeded'
                        ? { phase: 'frame' as const, timeoutMs: 100 }
                        : code === 'app-execution-kernel-failed'
                          ? {
                              kernelName: 'movement',
                              worldIdentity: 'world-1',
                              cause: new Error('kernel failed'),
                            }
                            : code === 'app-execution-rebuild-failed'
                              ? { worldIdentity: 'world-1', cause: new Error('rebuild failed') }
                              : {};
          const err = new AppError({
            code,
            expected: APP_EXPECTED[code],
            hint: APP_ERROR_HINTS[code],
            detail,
          });
          expect(err.code).toBe(code);
        }
      });
    });

    describe("AppError.detail -- discriminated union per code", () => {
      it("'app-canvas-detached' carries optional canvasId", () => {
        const withId = new AppError({
          code: 'app-canvas-detached',
          expected: APP_EXPECTED['app-canvas-detached'],
          hint: APP_ERROR_HINTS['app-canvas-detached'],
          detail: { canvasId: 'preview' },
        });
        if (withId.code === 'app-canvas-detached') {
          expect(withId.detail.canvasId).toBe('preview');
        }

        const withoutId = new AppError({
          code: 'app-canvas-detached',
          expected: APP_EXPECTED['app-canvas-detached'],
          hint: APP_ERROR_HINTS['app-canvas-detached'],
          detail: {},
        });
        if (withoutId.code === 'app-canvas-detached') {
          expect(withoutId.detail.canvasId).toBeUndefined();
        }
      });

      it("'app-system-update-failed' carries cause:unknown plus optional systemName", () => {
        const sentinel = new Error('boom');
        const wrapped = new AppError({
          code: 'app-system-update-failed',
          expected: APP_EXPECTED['app-system-update-failed'],
          hint: APP_ERROR_HINTS['app-system-update-failed'],
          detail: { cause: sentinel, systemName: 'host-physics-system' },
        });
        if (wrapped.code === 'app-system-update-failed') {
          expect(wrapped.detail.cause).toBe(sentinel);
          expect(wrapped.detail.systemName).toBe('host-physics-system');
        }
      });

      it("'app-system-update-failed' surfaces detail.cause inside .message (root cause visible to console.error)", () => {
        const plain = new AppError({
          code: 'app-system-update-failed',
          expected: APP_EXPECTED['app-system-update-failed'],
          hint: APP_ERROR_HINTS['app-system-update-failed'],
          detail: { cause: new Error('component Particle missing on entity 17') },
        });
        expect(plain.message).toContain('cause:');
        expect(plain.message).toContain('component Particle missing on entity 17');

        const structured = new AppError({
          code: 'app-system-update-failed',
          expected: APP_EXPECTED['app-system-update-failed'],
          hint: APP_ERROR_HINTS['app-system-update-failed'],
          detail: {
            cause: Object.assign(new Error('archetype lookup failed'), {
              name: 'EcsError',
              code: 'archetype-mismatch',
            }),
            systemName: 'particle-tick',
          },
        });
        expect(structured.message).toContain('EcsError archetype-mismatch: archetype lookup failed');
        expect(structured.message).toContain('system=particle-tick');

        const stringCause = new AppError({
          code: 'app-system-update-failed',
          expected: APP_EXPECTED['app-system-update-failed'],
          hint: APP_ERROR_HINTS['app-system-update-failed'],
          detail: { cause: 'plain-string-throw' },
        });
        expect(stringCause.message).toContain('plain-string-throw');
      });

      it('other 2 codes carry empty-object detail {}', () => {
        const empties: AppErrorCode[] = [
          'app-not-started',
          'app-already-running',
        ];
        for (const code of empties) {
          const err = new AppError({
            code,
            expected: APP_EXPECTED[code],
            hint: APP_ERROR_HINTS[code],
            detail: {},
          });
          expect(err.detail).toEqual({});
        }
      });
    });

    describe('exhaustive switch over (AppError | RhiError) (AC-07 type-fixture proxy)', () => {
      it('runtime walk on every AppErrorCode arm without falling through to default', () => {
        function classify(err: AppError | RhiError): string {
          if (err instanceof Error && (err as { code: string }).code.startsWith('rhi') === false) {
            // we narrow via the closed AppError union by the .code prefix
          }
          switch (err.code) {
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
              return 'f';
            case 'app-plugin-activation-failed':
              return 'plugin';
            case 'app-execution-worker-unavailable':
              return 'g';
            case 'app-execution-bootstrap-failed':
              return 'h';
            case 'app-execution-deadline-exceeded':
              return 'i';
            case 'app-execution-kernel-failed':
              return 'j';
            case 'app-renderer-inspection-unavailable':
              return 'inspection';
            case 'app-execution-rebuild-failed':
              return 'l';
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
              return 'rhi';
          }
        }
        const seen = new Set<string>();
        for (const code of APP_CODES) {
          const detail =
            code === 'app-renderer-inspection-unavailable'
              ? { reason: 'not-ready' as const }
              : code === 'app-canvas-detached'
              ? { canvasId: 'main' }
              : code === 'app-system-update-failed'
                ? { cause: 0 }
                : code === 'app-pointer-lock-failed'
                  ? { path: 'w3c' as const, cause: 0 }
                  : code === 'app-plugin-activation-failed'
                    ? { cause: 0 }
                  : code === 'app-execution-worker-unavailable'
                    ? {
                        worker: 'kernels' as const,
                        reason: 'capability-unavailable' as const,
                        missingCapabilities: ['cross-origin-isolated'] as const,

                      }
                    : code === 'app-execution-bootstrap-failed'
                      ? { phase: 'bootstrap' as const, moduleUrl: '/bootstrap.js', cause: 0 }
                      : code === 'app-execution-deadline-exceeded'
                        ? { phase: 'frame' as const, timeoutMs: 100 }
                        : code === 'app-execution-kernel-failed'
                          ? {
                              kernelName: 'movement',
                              worldIdentity: 'world-1',
                              cause: 0,
                            }
                            : code === 'app-execution-rebuild-failed'
                              ? { worldIdentity: 'world-1', cause: 0 }
                              : {};
          const err = new AppError({
            code,
            expected: APP_EXPECTED[code],
            hint: APP_ERROR_HINTS[code],
            detail,
          });
          seen.add(classify(err));
        }
        expect(seen.size).toBe(APP_CODES.length);
      });
    });
  });
}

{
  // ─── from frame-loop.test.ts ───

  function makeRendererStubFL(): { renderer: Renderer; drawCalls: RenderFrameInput[] } {
    const drawCalls: RenderFrameInput[] = [];
    const renderer = {
      state: () => 'alive' as const,
      attach: (attachedWorld: World) => ({
        ok: true,
        value: createRenderReadLease(attachedWorld),
      }),
      draw(request: RenderFrameInput): void {
        drawCalls.push(request);
      },
    } as unknown as Renderer;
    return { renderer, drawCalls };
  }

  function makeRafFakeFL(): {
    raf: (cb: (t: number) => void) => number;
    caf: (id: number) => void;
    pendingCallbacks: Array<(t: number) => void>;
    cancelled: number[];
  } {
    const pendingCallbacks: Array<(t: number) => void> = [];
    const cancelled: number[] = [];
    let nextId = 1;
    return {
      raf: (cb) => {
        pendingCallbacks.push(cb);
        return nextId++;
      },
      caf: (id) => {
        cancelled.push(id);
      },
      pendingCallbacks,
      cancelled,
    };
  }

  function makeNowFakeFL(sequence: number[]): () => number {
    let i = 0;
    return () => {
      const v = sequence[i] ?? sequence[sequence.length - 1] ?? 0;
      i = Math.min(i + 1, sequence.length);
      return v;
    };
  }

  describe('frame-loop.test.ts', () => {
    describe('frame-loop state matrix nine transitions (AC-03 / AC-07)', () => {
      let world: World;
      let renderer: Renderer;
      let loop: FrameLoopHandle;
      let raf: ReturnType<typeof makeRafFakeFL>;

      beforeEach(() => {
        world = new World();
        renderer = makeRendererStubFL().renderer;
        raf = makeRafFakeFL();
        const now = makeNowFakeFL([0, 16, 32, 48, 64, 80, 96, 112]);
        loop = createFrameLoop({world,renderer, platform: testPlatform({now,raf: raf.raf,caf: raf.caf})});
      });

      it('idle -> running: start() ok', () => {
        expect(loop.getState()).toBe('idle');
        const r: Result<void, AppError> = loop.start();
        expect(r.ok).toBe(true);
        expect(loop.getState()).toBe('running');
      });

      it("running -> running (dup): start() returns 'app-already-running'", () => {
        loop.start();
        const r = loop.start();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('app-already-running');
        }
        expect(loop.getState()).toBe('running');
      });

      it('running -> paused: pause() ok', () => {
        loop.start();
        const r = loop.pause();
        expect(r.ok).toBe(true);
        expect(loop.getState()).toBe('paused');
      });

      it('paused -> paused (dup): pause() ok and idempotent', () => {
        loop.start();
        loop.pause();
        const r = loop.pause();
        expect(r.ok).toBe(true);
        expect(loop.getState()).toBe('paused');
      });

      it('paused -> running: resume() ok', () => {
        loop.start();
        loop.pause();
        const r = loop.resume();
        expect(r.ok).toBe(true);
        expect(loop.getState()).toBe('running');
      });

      it('running -> stopped: stop() is terminal', () => {
        loop.start();
        const r = loop.stop();
        expect(r.ok).toBe(true);
        expect(loop.getState()).toBe('stopped');
        const restart = loop.start();
        expect(restart.ok).toBe(false);
        if (!restart.ok) expect(restart.error.code).toBe('app-not-started');
      });

      it('paused -> stopped: stop() terminates the paused loop', () => {
        loop.start();
        loop.pause();
        const r = loop.stop();
        expect(r.ok).toBe(true);
        expect(loop.getState()).toBe('stopped');
      });

      it("idle -> err: stop() while idle returns 'app-not-started'", () => {
        expect(loop.getState()).toBe('idle');
        const r = loop.stop();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('app-not-started');
        }
      });

      it("idle -> err: resume() while idle returns 'app-not-started'", () => {
        expect(loop.getState()).toBe('idle');
        const r = loop.resume();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('app-not-started');
        }
      });
    });

    describe('frame-loop frame-order contract (AC-04)', () => {
      it('rAF tick attaches the World, updates it, then draws in fixed sequence', () => {
        const world = new World();
        const { renderer, drawCalls } = makeRendererStubFL();
        const updateSpy = vi.spyOn(world, 'update');
        const now = makeNowFakeFL([0, 16]);
        const { raf, pendingCallbacks } = makeRafFakeFL();
        const callOrder: string[] = [];
        (renderer as unknown as { attach: (w: World) => ReturnType<typeof createRenderReadLease> }).attach = (
          w,
        ) => {
          expect(w).toBe(world);
          callOrder.push('attach');
          return { ok: true, value: createRenderReadLease(w) };
        };
        updateSpy.mockImplementation(() => {
          callOrder.push('update');
          return { ok: true, value: undefined };
        });
        const origDraw = renderer.draw;
        (renderer as { draw: (request: RenderFrameInput) => void }).draw = (
          request: RenderFrameInput,
        ): void => {
          callOrder.push('draw');
          origDraw.call(renderer, request);
        };
        const loop = createFrameLoop({world,renderer, platform: testPlatform({now,raf})});
        loop.start();
        pendingCallbacks[0]?.(0);
        expect(callOrder).toEqual(['attach', 'update', 'draw']);
        expect(drawCalls).toHaveLength(1);
        const request = drawCalls[0];
        expect(request?.leases).toHaveLength(1);
        expect(request?.leases[0]?.worldIdentity).toBe(world.identity);
        expect(request?.camera.lease).toBe(request?.leases[0]);
        expect(request?.environment.lease).toBe(request?.leases[0]);
      });
    });

    describe('frame-loop setStopped hook (M4 device-lost reservation)', () => {
      it('setStopped() forces state to "stopped"; subsequent start() returns app-not-started', () => {
        const world = new World();
        const { renderer } = makeRendererStubFL();
        const now = makeNowFakeFL([0, 16]);
        const { raf } = makeRafFakeFL();
        const loop = createFrameLoop({world,renderer, platform: testPlatform({now,raf})});
        loop.start();
        loop.setStopped();
        expect(loop.getState()).toBe('stopped');
        const r = loop.start();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('app-not-started');
        }
      });
    });
  });
}

{
  // ─── from load-game.test.ts ───

  function makeStubPlugin(): Plugin {
    return { name: 'test-gameplay', apply: () => undefined };
  }

  describe('load-game.test.ts', () => {
    describe('loadGame success path (AC-07)', () => {
      it('resolves with Result.ok containing the native gameplay plugin', async () => {
        const gameplay = makeStubPlugin();
        const r = await loadGame('my-game', async () => ({ default: gameplay }));
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value).toBe(gameplay);
        }
      });

      it('accepts a Cordis function plugin', async () => {
        const gameplay: Plugin = () => undefined;
        const r = await loadGame('sync-game', async () => ({ default: gameplay }));
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(typeof r.value).toBe('function');
        }
      });
    });

    describe('loadGame module-not-found (AC-07 / AC-08)', () => {
      it('returns Result.err with code module-not-found when resolver throws a not-found error', async () => {
        const slug = 'nonexistent-game';
        const r = await loadGame(slug, async (_slug) => {
          throw new Error(`Cannot find module '${_slug}'`);
        });

        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toBeInstanceOf(LoadGameError);
          const err = r.error as LoadGameError;
          expect(err.code).toBe('module-not-found');
          expect((err.detail as { slug: string }).slug).toBe(slug);
          expect(typeof err.hint).toBe('string');
          expect(err.hint.length).toBeGreaterThan(0);
          expect(typeof err.expected).toBe('string');
          expect(err.expected.length).toBeGreaterThan(0);
        }
      });
    });

    describe('loadGame invalid-format (AC-07 / AC-08)', () => {
      it('returns Result.err with code invalid-format when module has no default export', async () => {
        const r = await loadGame('bad-game', async () => ({ foo: 1 }) as unknown as Record<string, unknown>);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toBeInstanceOf(LoadGameError);
          const err = r.error as LoadGameError;
          expect(err.code).toBe('invalid-format');
          const detail = err.detail as { exportKeys: string[] };
          expect(detail.exportKeys).toContain('foo');
          expect(detail.exportKeys).not.toContain('default');
        }
      });

      it('returns Result.err with code invalid-format when default export is null', async () => {
        const r = await loadGame('null-game', async () => ({ default: null }) as unknown as Record<string, unknown>);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          const err = r.error as LoadGameError;
          expect(err.code).toBe('invalid-format');
        }
      });

      it('returns Result.err with code invalid-format when default export is not a plugin', async () => {
        const r = await loadGame('string-game', async () => ({ default: 'not-a-plugin' }) as unknown as Record<string, unknown>);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          const err = r.error as LoadGameError;
          expect(err.code).toBe('invalid-format');
        }
      });
    });

    describe('loadGame import-failed (AC-07 / AC-08)', () => {
      it('returns Result.err with code import-failed when resolver throws a generic Error', async () => {
        const cause = new Error('network error');
        const r = await loadGame('flaky-game', async () => {
          throw cause;
        });

        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toBeInstanceOf(LoadGameError);
          const err = r.error as LoadGameError;
          expect(err.code).toBe('import-failed');
          const detail = err.detail as { cause: unknown };
          expect(detail.cause).toBe(cause);
          expect(typeof err.hint).toBe('string');
          expect(err.hint.length).toBeGreaterThan(0);
        }
      });
    });

    describe('LoadGameError code completeness (AC-08)', () => {
      it('has exactly 3 error codes in the closed union', () => {
        const allCodes: LoadGameErrorCode[] = [
          'module-not-found',
          'invalid-format',
          'import-failed',
        ];
        expect(allCodes.length).toBe(3);
        expect(new Set(allCodes).size).toBe(3);
      });
    });
  });
}

{
  // ─── from ready-barrier.test.ts ───

  function makeRendererStubRB(): Renderer {
    return {
      state: () => 'alive' as const,
      attach: (attachedWorld: World) => ({ ok: true, value: createRenderReadLease(attachedWorld) }),
      draw(): { ok: true; value: undefined } {
        // no-op
        return { ok: true, value: undefined };
      },
      onError(): () => void {
        return () => {
          // no-op
        };
      },
      onLost(): () => void {
        return () => {
          // no-op
        };
      },
    } as unknown as Renderer;
  }

  describe('ready-barrier.test.ts', () => {
    describe('createApp readiness barrier', () => {
      it('assembles without a renderer.ready barrier', async () => {
        const result = await createApp({ platform: testPlatform(),  renderer: makeRendererStubRB(), world: new World() });
        expect(result.ok).toBe(true);
      });

      it('does not expose a renderer.ready dependency', async () => {
        const renderer = makeRendererStubRB();
        const result = await createApp({ platform: testPlatform(),  renderer, world: new World() });
        expect(result.ok).toBe(true);
        expect('ready' in renderer).toBe(false);
      });
    });
  });
}

{
  // ─── from create-app-inputmap.test.ts ───

  describe('create-app-inputmap.test.ts', () => {
    describe('CreateAppOptions.inputMap type + Resource plumbing', () => {
      it('world.insertResource(INPUT_MAP_KEY, map) → world.hasResource(INPUT_MAP_KEY) and getResource returns same value', () => {
        const world = new World();
        const map: readonly ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        world.insertResource(INPUT_MAP_KEY, map);
        expect(world.hasResource(INPUT_MAP_KEY)).toBe(true);
        const retrieved = world.getResource<readonly ActionConfig[]>(INPUT_MAP_KEY);
        expect(retrieved).toBe(map);
      });

      it('absent INPUT_MAP_KEY → hasResource returns false', () => {
        const world = new World();
        expect(world.hasResource(INPUT_MAP_KEY)).toBe(false);
      });

      it('CreateAppOptions.inputMap is typed as readonly ActionConfig[] | undefined', () => {
        // AC-08(a) type probe: verify the type compiles.
        // If this test compiles, CreateAppOptions.inputMap accepts ActionConfig[].
        const opts: import('../src/types').CreateAppOptions = {
          inputMap: [
            { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
          ],
        };
        expect(opts.inputMap).toBeDefined();
        expect(opts.inputMap!.length).toBe(1);
      });

      it('empty inputMap array yields zero actions', () => {
        const opts: import('../src/types').CreateAppOptions = {
          inputMap: [],
        };
        expect(opts.inputMap).toBeDefined();
        expect(opts.inputMap!.length).toBe(0);
      });

      it('absent inputMap → CreateAppOptions.inputMap is undefined', () => {
        const opts: import('../src/types').CreateAppOptions = {};
        expect(opts.inputMap).toBeUndefined();
      });

      it('inputMap normalization: duplicate action names → last-wins', () => {
        // D-8: duplicate action names → last config wins.
        const appOpts: import('../src/types').CreateAppOptions = {
          inputMap: [
            { action: 'jump', bindings: [{ type: 'key', key: 'a' }] },
            { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
          ],
        };
        expect(appOpts.inputMap).toBeDefined();
        expect(appOpts.inputMap!.length).toBe(2);
        // The normalization (last-wins dedup) happens in input-attach.ts,
        // tested in m1t6. This test just verifies the type accepts duplicates.
      });
    });
  });
}
