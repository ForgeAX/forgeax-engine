import { testPlatform } from '../src/__tests__/platform-fixture';
// device-lost.browser.test.ts -- M4 (w12) acceptanceCheck: 4-path coverage
// for the device-lost internal subscription and App lifecycle in
// packages/app/src/create-app.ts.
//
// Anchors:
//   - plan-strategy D-2: device loss is a recoverable renderer-owned interval.
//     The rAF heartbeat remains armed, World/update work is frozen while the
//     renderer reports `device-lost`, lastError is captured, and the error fans
//     out via host onError listeners verbatim.
//   - plan-strategy D-3: AppError union does NOT add 'app-device-lost';
//     RhiError({code:'device-lost'}) is forwarded through onError (D-2/D-3).
//   - plan-strategy R-1 (research section 7.4): rAF handle must exist
//     BEFORE renderer.onError(internal) subscribes. If renderer late-attach
//     replays a lost event immediately, the listener cancels a still-null
//     rafHandle. We assert no NPE on that timing.
//   - plan-strategy R-4 (research section 7.3 / D-2): explicit dispose and
//     explicit disposal remains centralized. Device loss does not dispose the
//     App Fiber, so a successful Renderer.recover() can re-enter
//     through the same App frame loop.
//   - research section 7.7: 'device-lost' is already in RhiErrorCode 18-member
//     union (no new AppError member).
//
// charter awareness:
//   - P3 explicit failure: device-lost is a loud signal (host listener +
//     recoverable renderer health + lastError captured) -- never silent.

import { Update, World } from '@forgeax/engine-ecs';
import {
  FRAME_START_SCAN_SYSTEM_NAME,
  type InputBackend,
  inputBackendPlugin,
} from '@forgeax/engine-input';
import {
  Camera,
  perspective,
  type Renderer,
  type RendererEvent,
  type RenderError,
} from '@forgeax/engine-render';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';

import { createApp, inputPlugin } from '../src/index';
import { createApp as createBrowserApp } from '../src/browser';
import type { App, AppError } from '../src/types';

type RendererEventListener = (event: RendererEvent) => void;

// -------- helpers ----------------------------------------------------

interface FakeRendererState {
  readonly eventListeners: Set<RendererEventListener>;
  drawCalls: number;
  reason: 'alive' | 'device-lost';
  fireDeviceLost: () => void;
}

function makeFakeRenderer(opts?: {
  fireOnSubscribe?: boolean;
}): { renderer: Renderer; state: FakeRendererState } {
  const eventListeners = new Set<RendererEventListener>();
  const state = {
    eventListeners,
    drawCalls: 0,
    reason: 'alive' as 'alive' | 'device-lost',
    fireDeviceLost: () => {
      // no-op until reset below
    },
  };
  const lostError = {
    name: 'RendererOperationError',
    code: 'device-operation-failed',
    expected: 'the active device generation completes the renderer-owned operation',
    hint: 'inspect renderer state and recover before retrying',
    detail: {
      operation: 'renderer-event',
      cause: {
        code: 'device-lost',
        expected: 'device must remain alive',
        hint: 'recover the Renderer or rebuild it through createApp({...})',
      },
    },
  } as unknown as RenderError;
  state.fireDeviceLost = () => {
    state.reason = 'device-lost';
    for (const cb of Array.from(eventListeners)) {
      cb({ kind: 'error', error: lostError });
    }
  };
  const renderer = {
    attach(world: World) {
      return { ok: true as const, value: createRenderReadLease(world) };
    },
    draw() {
      if (state.reason === 'alive') state.drawCalls++;
      return {
        ok: true as const,
        value: {
          frameId: state.drawCalls,
          deviceGeneration: 0,
          completed: Promise.resolve({ ok: true as const, value: undefined }),
        },
      };
    },
    setProfile() {
      return { ok: true as const, value: undefined };
    },
    state: () => (state.reason === 'alive' ? ('alive' as const) : ('device-lost' as const)),
    inspect: () => undefined as never,
    observe: async () => undefined as never,
    subscribe(cb: RendererEventListener): () => void {
      eventListeners.add(cb);
      if (opts?.fireOnSubscribe === true) {
        // simulate the host event source late-attach replay --
        // a freshly registered listener is invoked synchronously with
        // the persisted lost event before this call returns.
        cb({ kind: 'error', error: lostError });
      }
      return () => {
        eventListeners.delete(cb);
      };
    },
    releaseSurface() {
      return { ok: true as const, value: undefined };
    },
    restoreSurface() {
      return { ok: true as const, value: undefined };
    },
    recover: async () => {
      state.reason = 'alive';
      return { ok: true as const, value: undefined };
    },
    dispose: async () => {
      return { ok: true as const, value: undefined };
    },
  };
  return { renderer, state };
}

function makeFakeBackend(): { backend: InputBackend; detachCalls: number; getDetachCalls(): number } {
  let detachCalls = 0;
  const backend: InputBackend = {
    sample: () => ({
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    }),
    detach: () => {
      detachCalls++;
    },
  };
  return {
    backend,
    detachCalls,
    getDetachCalls: () => detachCalls,
  };
}

// -------- path 1: device-lost freezes the recoverable interval --------

describe('device-lost path 1 -- heartbeat retained + simulation frozen', () => {
  it('renderer.onError fires RhiError(device-lost) -> app remains running but draw work pauses', async () => {
    const { renderer, state } = makeFakeRenderer();
    const world = new World();
    const result = await createApp({ platform: testPlatform(),  renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;
    const received: Array<AppError | RenderError> = [];
    const unsubscribe = app.onError((error) => {
      received.push(error);
    });
    try {
      const startResult = app.start();
      expect(startResult.ok).toBe(true);

      // wait one rAF tick to ensure rafHandle is captured non-null
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const drawCallsBefore = state.drawCalls;

      // fire device-lost via the fake renderer
      state.fireDeviceLost();
      expect(
        received.some(
          (error) =>
            error.code === 'device-operation-failed' && error.detail.cause.code === 'device-lost',
        ),
      ).toBe(true);

      // Device loss is recoverable at the renderer boundary, so the App remains
      // started and an accidental second start is rejected as already-running.
      const restart = app.start();
      expect(restart.ok).toBe(false);
      if (restart.ok) return;
      expect(restart.error.code).toBe('app-already-running');

      // The rAF heartbeat remains armed, but the frame-loop must not submit work
      // against a lost device until the host calls Renderer.recover().
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(state.drawCalls).toBe(drawCallsBefore);
    } finally {
      unsubscribe();
      app.stop();
    }
  });
});

// -------- path 2: device-lost still fans out to host listener -------

describe('device-lost path 2 -- error fans out to host onError listener verbatim (D-3)', () => {
  it('host onError listener receives RhiError(device-lost) intact', async () => {
    const { renderer, state } = makeFakeRenderer();
    const world = new World();
    const result = await createApp({ platform: testPlatform(),  renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;

    const received: Array<AppError | RenderError> = [];
    try {
      app.onError((e) => {
        received.push(e);
      });
      app.start();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      state.fireDeviceLost();

      const lostEvent = received.find(
        (e) => e.code === 'device-operation-failed' && e.detail.cause.code === 'device-lost',
      );
      expect(lostEvent).toBeDefined();
      if (lostEvent === undefined || lostEvent.code !== 'device-operation-failed') return;
      expect(lostEvent.code).toBe('device-operation-failed');
      expect(lostEvent.detail.cause.code).toBe('device-lost');
    } finally {
      app.stop();
    }
  });
});

// -------- path 3: late-attach replay -- listener fires before rAF --

describe('device-lost path 3 -- late-attach replay does not throw NPE', () => {
  it('renderer.onError invokes listener synchronously on subscribe; no NPE on cancelAnimationFrame', async () => {
    // The fake renderer fires device-lost the moment the internal
    // listener is registered (simulating LostListenerRegistry late-attach
    // replay). The internal subscription order (rAF first, listener
    // second) ensures rafHandle is a number / null, never undefined.
    const { renderer } = makeFakeRenderer({ fireOnSubscribe: true });
    const world = new World();
    const result = await createApp({ platform: testPlatform(),  renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;

    // The host had not registered onError yet -- the late-attach replay
    // will land on the internal listener AND fall back to console.error
    // (if listener set is empty); we silence the fallback so test stderr
    // stays clean and assert no throw is raised.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // silence
    });
    try {
      // start should not throw even though listener fires synchronously
      // during/right after subscribe.
      const startResult = app.start();
      expect(startResult.ok).toBe(true);
      // drive one tick; the heartbeat is retained, but the lost renderer
      // freezes frame work until explicit recovery.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    } finally {
      app.stop();
      consoleErrorSpy.mockRestore();
    }
  });
});

// -------- path 4: explicit dispose owns cleanup -----------------------

describe('device-lost path 4 -- explicit dispose owns cleanup (R-4)', () => {
  it('device-lost still permits explicit disposal of the input Fiber', async () => {
    const { renderer, state } = makeFakeRenderer();
    const world = new World();

    // We pre-attach a fake input backend through the assemble form to
    // observe the cleanup hooks. Because the assemble form is host-
    // owned for input, we instead test cleanup via removeSystem spy
    // against the world: the device-lost path SHOULD call cleanup() if
    // a cleanup function was wired (which is true on the canvas form,
    // not the assemble form). For the assemble form path, host owns
    // input lifetime, so we focus on state -> stopped + draw stop.
    const fakeBackend = makeFakeBackend();
    // Assemble-form capabilities provide the backend through the same Cordis
    // service graph consumed by inputPlugin.
    const result = await createApp({ platform: testPlatform(),
      renderer,
      world,
      plugins: [inputBackendPlugin(fakeBackend.backend), inputPlugin()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app: App = result.value;
    expect(app.input).toBe(fakeBackend.backend);

    app.start();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const drawCallsBefore = state.drawCalls;

    const received: Array<AppError | RenderError> = [];
    const unsubscribe = app.onError((error) => {
      received.push(error);
    });

    state.fireDeviceLost();
    expect(
      received.some(
        (error) =>
          error.code === 'device-operation-failed' && error.detail.cause.code === 'device-lost',
      ),
    ).toBe(true);

    // During device-lost, the rAF heartbeat remains armed but no draws are
    // submitted until recovery.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(state.drawCalls).toBe(drawCallsBefore);
    // Stop only controls scheduling; dispose remains valid after a loss.
    const stopResult = app.stop();
    expect(stopResult.ok).toBe(true);
    const disposeResult = await app.dispose();
    expect(disposeResult.ok).toBe(true);
    unsubscribe();
  });

  // This path cold-starts a real software-GPU renderer before exercising disposal.
  it('canvas dispose lets the input Fiber remove its scan system exactly once', { timeout: 60_000 }, async () => {
    const removeSpy = vi.spyOn(World.prototype, 'removeSystem');

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      try {
        const result = await createBrowserApp(canvas);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;
        // The canvas form owns a real renderer, so give its first frame the
        // minimum valid scene. Without a Camera the render path reports
        // render-system-no-camera and can leave headed WebGPU waiting for the
        // frame-loop timeout before stop() reaches the cleanup assertion.
        app.world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 2] } },
            { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
          )
          .unwrap();
        // This path runs in a fresh Vitest browser process now. Spy through to
        // the real dispose so the GPUDevice is released before that process
        // hands control to the next split group.
        const disposeSpy = vi.spyOn(app.renderer, 'dispose');
        app.start();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const stopResult = app.stop();
        expect(stopResult.ok).toBe(true);
        expect(disposeSpy).not.toHaveBeenCalled();
        const disposeResult = await app.dispose();
        expect(disposeResult.ok).toBe(true);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        const scanRemovals = removeSpy.mock.calls.filter(
          ([schedule, name]) => schedule === Update && name === FRAME_START_SCAN_SYSTEM_NAME,
        );
        expect(scanRemovals).toHaveLength(1);
        disposeSpy.mockRestore();
      } finally {
        canvas.remove();
      }
    } finally {
      removeSpy.mockRestore();
    }
  });
});
