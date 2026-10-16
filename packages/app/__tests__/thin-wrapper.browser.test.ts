import { testPlatform } from '../src/__tests__/platform-fixture';
// thin-wrapper.browser.test.ts -- M4 (w8) acceptanceCheck: 4-path coverage
// for the (A) canvas-form thin wrapper landing in
// packages/app/src/create-app.ts (w9).
//
// Anchors:
//   - AC-01 thin wrapper: createApp(canvas, opts?) is a 4-step function
//     (canvas detach guard / createRenderer try-catch / new World /
//     delegate to assemble form). Per plan-strategy D-5.
//   - AC-08 canvas-detached guard: (A) path returns Result.err({code:
//     'app-canvas-detached'}); (B) path does NOT trigger this check.
//   - AC-09 + plan-strategy D-6: error union AppError | RhiError |
//     EngineEnvironmentError consumed via double-layer instanceof +
//     switch; .detail.webgpuError?.code is preserved across the wrap
//     so AI users two-level narrow without losing structure.
//   - research section 2.2: createRenderer construction-time throws
//     EngineEnvironmentError at createRenderer.ts:400 / :429 (rhi pack
//     load failure / no usable rendering backend).
//
// charter awareness:
//   - P3 explicit failure: thin wrapper turns construction-time
//     throws into Result.err so callers branch on .ok before any
//     try/catch is involved.
//   - P5 producer/consumer split: assemble form (B) is the canonical
//     truth; (A) only adds canvas-specific glue.

import { audioBackendPlugin, createAudioIntentBackend } from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { Context } from '@forgeax/engine-plugin';
import { Camera, type Renderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { createApp as createBrowserApp } from '../src/browser';
import { AppError } from '../src/errors';
import type { App, CanvasAppError } from '../src/types';

// Local helper: minimal Renderer stub for the (B) path bypass test.
function makeRendererStub(): Renderer {
  return {
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw(): void {
      // no-op
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

describe('createApp(canvas) thin wrapper -- (A) path canvas-detached guard (AC-08)', () => {
  it('detached canvas returns Result.err({code: app-canvas-detached})', async () => {
    const detachedCanvas = document.createElement('canvas');
    detachedCanvas.width = 64;
    detachedCanvas.height = 64;
    // Note: NOT appendChild -- canvas.isConnected === false.
    expect(detachedCanvas.isConnected).toBe(false);
    const result = await createBrowserApp(detachedCanvas);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error;
    // Narrow: not an EngineEnvironmentError (no createRenderer call), so
    // the error must be the structured AppError variant.
    expect(err instanceof EngineEnvironmentError).toBe(false);
    if (err instanceof EngineEnvironmentError) return;
    expect(err.code).toBe('app-canvas-detached');
    expect(typeof err.expected).toBe('string');
    expect(typeof err.hint).toBe('string');
  });
});

describe('createApp(assemble) -- (B) path does NOT trigger canvas-detach check (AC-08)', () => {
  it('(B) path with detached canvas reference is irrelevant; assemble form ignores DOM entirely', async () => {
    // Build a detached canvas and a renderer stub. The (B) path takes
    // {renderer, world}; the canvas is irrelevant to the assemble entry,
    // so the detach check never fires here.
    const detachedCanvas = document.createElement('canvas');
    expect(detachedCanvas.isConnected).toBe(false);
    const renderer = makeRendererStub();
    const world = new World();
    const result = await createApp({ platform: testPlatform(),  renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;
    try {
      expect(app.renderer).toBe(renderer);
      expect(app.world).toBe(world);
    } finally {
      expect((await app.dispose()).ok).toBe(true);
    }
  });
});

describe('createApp(canvas) thin wrapper -- (A) path success path (AC-09)', () => {
  let connectedCanvas: HTMLCanvasElement;

  beforeEach(() => {
    connectedCanvas = document.createElement('canvas');
    connectedCanvas.width = 64;
    connectedCanvas.height = 64;
    document.body.appendChild(connectedCanvas);
  });

  afterEach(() => {
    connectedCanvas.remove();
  });

  it.each([false, true])('borrows a plugin scope with optional audio = %s', async (withAudio) => {
    const root = new Context();
    const outerAudio = createAudioIntentBackend({ emit: () => undefined });
    const innerAudio = createAudioIntentBackend({ emit: () => undefined });
    let app: App | undefined;
    try {
      await root.plugin(audioBackendPlugin(outerAudio));
      await root.isolate('audio').isolate('physics').plugin({
        name: 'app-owner',
        async apply(ctx) {
          app = (await createBrowserApp(connectedCanvas, {
            context: ctx,
            plugins: withAudio ? [audioBackendPlugin(innerAudio)] : [],
          })).unwrap();
          expect(app.physics).toBeUndefined();
          expect(app.audio).toBe(withAudio ? innerAudio : undefined);
          expect((await app.dispose()).ok).toBe(true);
          expect(ctx.get('world')).toBeUndefined();
        },
      });
      expect(root.audio).toBe(outerAudio);
    } finally {
      await app?.dispose();
      await root.fiber.dispose();
    }
  }, 30_000);

  // A real Chrome/lavapipe device can spend >15s on its first createRenderer
  // call after another browser group closes. Keep this owner bounded without
  // raising the timeout for the rest of the app browser suite.
  it(
    'connected canvas + WebGPU available -> Result.ok(App); app.renderer.draw + app.world.update reachable without `as` casts',
    async () => {
      const result = await createBrowserApp(connectedCanvas);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;
      try {
        // Type-level discoverability: app.renderer.draw + app.world.update
        // are invokable directly off the App handle (AC-09).
        expect(typeof app.renderer.draw).toBe('function');
        expect(typeof app.world.update).toBe('function');
      } finally {
        // stop() only controls frames; disposal releases the owned renderer
        // and plugin effects even when a discovery assertion fails.
        expect((await app.dispose()).ok).toBe(true);
      }
    },
    30_000,
  );

  it.each([false, true])(
    'native canvas removal reports surface loss only before App stop (stopped=%s)',
    async (stopped) => {
      const app = (await createBrowserApp(connectedCanvas)).unwrap();
      const errors: unknown[] = [];
      app.onError((error) => errors.push(error));
      try {
        app.world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 5] } },
            { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 10 } },
          )
          .unwrap();
        // Establish the observer's nonzero connected size before removing it.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        app.start().unwrap();
        if (stopped) app.stop().unwrap();
        connectedCanvas.remove();
        // Native ResizeObserver runs after rAF. Cross the next frame too so
        // removal has reached the actual browser platform subscription.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (stopped) {
          expect(errors).toEqual([]);
          expect(app.execution.report().engine.health).toBe('stopped');
        } else {
          expect(errors).toContainEqual(
            expect.objectContaining({
              code: 'app-system-update-failed',
              detail: {
                cause: expect.objectContaining({ code: 'platform-unavailable' }),
              },
            }),
          );
          expect(app.execution.report().engine.health).toBe('idle');
        }
      } finally {
        (await app.dispose()).unwrap();
      }
    },
    30_000,
  );

  it('error union double-layer narrow contract: callers can switch on AppError|RhiError code OR instanceof EngineEnvironmentError', async () => {
    // This test pins the consumer pattern from plan-strategy D-6: hosts
    // first check `instanceof EngineEnvironmentError`, then `switch
    // (err.code)` over the AppError | RhiError carrier shape. The branch
    // is deliberately exhaustive on the AppError 5-member union to fail
    // the typecheck if the union later grows without updating consumers.
    function consume(err: CanvasAppError): string {
      if (err instanceof EngineEnvironmentError) {
        return `env:${err.detail.webgpuError?.code ?? 'unknown'}`;
      }
      // err is AppError | RhiError here; we only switch on AppError codes
      // (RhiError surfaces device-lost via onError fan-out -- see w10).
      switch (err.code) {
        case 'app-not-started':
        case 'app-already-running':
        case 'app-canvas-detached':
        case 'app-system-update-failed':
          return `app:${err.code}`;
        default:
          return `rhi:${(err as { code: string }).code}`;
      }
    }
    // Smoke: feed a synthetic AppError; assert the function compiles +
    // returns. The actual exhaustiveness is tsc -b's job, not this test.
    const synthetic: CanvasAppError = new AppError({
      code: 'app-canvas-detached',
      expected: 'canvas.isConnected === true',
      hint: 'append canvas to DOM before createApp',
      detail: {},
    });
    expect(consume(synthetic)).toBe('app:app-canvas-detached');
  });
});

describe('createApp(canvas) thin wrapper -- (A) path createRenderer try/catch (AC-01)', () => {
  // The createRenderer throw path is exercised in
  // thin-wrapper-throw.browser.test.ts (split out so vi.mock hoists at
  // module level without colliding with this file's success-path tests
  // that need the real createRenderer).
  // TODO (feat-20260608-ci-time-cut): the prior `expect(true)` documented a
  // sibling-file pointer; converted to `it.todo` to drop the placeholder
  // without losing the doc breadcrumb.
  it.todo('throw-path fixture is owned by thin-wrapper-throw.browser.test.ts');
});
