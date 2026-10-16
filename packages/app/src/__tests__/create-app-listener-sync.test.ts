// feat-20260619-audio-resource-ownership-deterministic-reclaim / M7 / w24 fix-up.
//
// Listener sync real-consumption-path test: goes through the canvas form
// (createApp(canvas, opts)) so the w25 auto-registration code
// (create-app.ts:517-538) is actually executed.  The prior version of this
// test used the assemble form with a hand-copied registerListenerSyncSystem
// helper — a shadow copy of the production code that left w25 untested.
//
// Approach: vi.mock constructRuntimeRendererHost (only construction overridden) so the canvas
// form does not attempt real WebGPU init; all other exports from
// @forgeax/engine-runtime remain real (Transform, registerPropagateTransforms,
// PROPAGATE_TRANSFORMS_SYSTEM, etc.).  globalThis.AudioContext is stubbed
// with a mock whose .listener carries nine { value } AudioParam objects
// that syncListenerFromWorldMatrix writes to — the same nine fields the
// production code accesses.  requestAnimationFrame is stubbed (same pattern
// as create-app-stop.test.ts) so start() runs one frame synchronously.
//
// Three scenarios (semantics unchanged from the prior version, but now
// exercising the real production path through the canvas form):
//   (a) AudioListener+Transform entity at (5,0,0) — after start()+frame
//       the mock listener.positionX.value === 5 (proves D-7 real addSystem
//       auto-registration consumes the world mat4 from propagateTransforms).
//   (b) No AudioListener entity — system no-ops, no throw, mock listener
//       values remain at 0.
//   (c) Frame-order regression guard (R-listener-frame-order): modify
//       Transform.posX in the same frame-cycle and run another frame —
//       listener pose reflects the CURRENT frame's world mat4, not a
//       stale/previous value (proves after-propagate frame order is
//       effective and the system does not suffer 1-frame lag).

import { AudioListener as AudioListenerComponent, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import type { RendererHostAssembly } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../browser';

const constructRuntimeRendererHost = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock constructRuntimeRendererHost so the canvas form does not attempt real WebGPU init.
// All other @forgeax/engine-runtime exports stay real (Transform,
// registerPropagateTransforms, advanceAnimationPlayer, etc.).
// ---------------------------------------------------------------------------

vi.mock('@forgeax/engine-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgeax/engine-runtime')>();
  const lease = { dispose: vi.fn() };
  const rendererStub = {
    state: () => 'alive' as const,
    inspect: () => ({}),
    attach(): { ok: true; value: object } {
      return { ok: true, value: lease };
    },
    draw(): { ok: true; value: object } {
      return { ok: true, value: {} };
    },
    observe: async () => ({ ok: true as const, value: {} }),
    releaseSurface: () => ({ ok: true as const, value: undefined }),
    restoreSurface: () => ({ ok: true as const, value: undefined }),
    recover: async () => ({ ok: true as const, value: undefined }),
    subscribe(): () => void {
      return () => {};
    },
    dispose: vi.fn(),
  };
  constructRuntimeRendererHost.mockResolvedValue({
    ok: true,
    value: {
      renderer: rendererStub,
      assets: undefined,
      initialization: Promise.resolve(
        ok(undefined),
      ) satisfies RendererHostAssembly['initialization'],
    },
  });
  return {
    ...actual,
  };
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost,
  loadRhiPack: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock AudioContext whose .listener carries the nine AudioParam
 * objects (positionX/Y/Z, forwardX/Y/Z, upX/Y/Z) that
 * syncListenerFromWorldMatrix writes to.  The mock also carries the minimum
 * surface WebAudioEngine.ensureContext() needs: createGain, destination,
 * state, close, and the gesture-listener methods.
 */
function makeMockAudioContextForListenerSync(): AudioContext {
  const mkGain = vi.fn(
    () =>
      ({
        gain: { value: 1 } as unknown as AudioParam,
        context: undefined as unknown as BaseAudioContext,
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'max' as const,
        channelInterpretation: 'speakers' as const,
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as GainNode,
  );

  const mkListener = (): AudioListener =>
    ({
      positionX: { value: 0 } as unknown as AudioParam,
      positionY: { value: 0 } as unknown as AudioParam,
      positionZ: { value: 0 } as unknown as AudioParam,
      forwardX: { value: 0 } as unknown as AudioParam,
      forwardY: { value: 0 } as unknown as AudioParam,
      forwardZ: { value: 0 } as unknown as AudioParam,
      upX: { value: 0 } as unknown as AudioParam,
      upY: { value: 0 } as unknown as AudioParam,
      upZ: { value: 0 } as unknown as AudioParam,
    }) as unknown as AudioListener;

  return {
    listener: mkListener(),
    state: 'suspended' as AudioContextState,
    sampleRate: 48000,
    destination: {
      maxChannelCount: 2,
      channelCount: 2,
      channelCountMode: 'explicit' as const,
      channelInterpretation: 'speakers' as const,
      context: undefined as unknown as BaseAudioContext,
      numberOfInputs: 1,
      numberOfOutputs: 0,
      connect: vi.fn().mockReturnValue(undefined),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as AudioDestinationNode,
    currentTime: 0,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain: mkGain,
    createBufferSource: vi.fn(),
    createPanner: vi.fn(),
    decodeAudioData: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onstatechange: null,
    baseLatency: 0,
    outputLatency: 0,
    getOutputTimestamp: vi.fn(),
    createMediaStreamDestination: vi.fn(),
    createMediaStreamSource: vi.fn(),
    createChannelMerger: vi.fn(),
    createChannelSplitter: vi.fn(),
    createDelay: vi.fn(),
    createBiquadFilter: vi.fn(),
    createConvolver: vi.fn(),
    createDynamicsCompressor: vi.fn(),
    createOscillator: vi.fn(),
    createStereoPanner: vi.fn(),
    createWaveShaper: vi.fn(),
    createIIRFilter: vi.fn(),
    createScriptProcessor: vi.fn(),
    createAnalyser: vi.fn(),
    createConstantSource: vi.fn(),
    audioWorklet: undefined as unknown as AudioWorklet,
  } as unknown as AudioContext;
}

/**
 * Node-env rAF injection: createFrameLoop's resolveRaf reads
 * globalThis.requestAnimationFrame at construction time (frame-loop.ts:141-153).
 * Call this BEFORE createApp() so the frame loop captures the stub.
 *
 * Auto-invoke only on first raf call (from start()), not on subsequent
 * calls (from tick()'s `raf(tick)` in frame-loop), to avoid infinite
 * recursion. The stub state is returned so tests can read tickFn to drive
 * additional frames.
 */
function installRafStub(): { tickFn: (() => void) | null } {
  const stub: { tickFn: (() => void) | null } = { tickFn: null };
  let firstCall = true;
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
    stub.tickFn = () => cb(performance.now());
    if (firstCall) {
      firstCall = false;
      stub.tickFn();
    }
    return 1;
  };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {
    stub.tickFn = null;
  };
  return stub;
}

function uninstallRafStub() {
  delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('feat-20260619 M7: listener sync real consumption path (canvas form)', () => {
  describe('w24 scenario (a): AudioListener+Transform entity syncs world translation', () => {
    it('canvas form audio:true → after start() mock listener positionX === 5', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      let context: AudioContext | undefined;
      const mockCtor = vi.fn(function AudioContextMock(this: Record<string, unknown>) {
        context = makeMockAudioContextForListenerSync();
        Object.assign(this, context);
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for AudioContext constructor -- must use function (not arrow) so new AudioContext() is constructable
      globalThis.AudioContext = mockCtor as any;

      installRafStub();

      try {
        const canvas = {
          tagName: 'canvas',
          isConnected: true,
          width: 800,
          height: 600,
        } as HTMLCanvasElement;

        const result = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // Spawn entity AFTER createApp but BEFORE start(), so the listener-sync
        // system (registered during createApp) finds it on the first frame.
        app.world.spawn(
          { component: Transform, data: { pos: [5, 0, 0] } },
          { component: AudioListenerComponent, data: {} },
        );

        app.start();

        const listener = context?.listener;
        if (!listener) throw new Error('expected host AudioContext.listener');
        expect(listener.positionX.value).toBe(5);
        expect(listener.positionY.value).toBe(0);
        expect(listener.positionZ.value).toBe(0);

        app.stop();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });
  });

  describe('w24 scenario (b): no AudioListener entity → no-op, no throw', () => {
    it('canvas form audio:true with no AudioListener entity → start() does not throw', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      const mockCtor = vi.fn(function AudioContextMock(this: Record<string, unknown>) {
        Object.assign(this, makeMockAudioContextForListenerSync());
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for AudioContext constructor -- must use function (not arrow) so new AudioContext() is constructable
      globalThis.AudioContext = mockCtor as any;

      installRafStub();

      try {
        const canvas = {
          tagName: 'canvas',
          isConnected: true,
          width: 800,
          height: 600,
        } as HTMLCanvasElement;

        const result = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // No AudioListener entity spawned — the listener-sync system runs,
        // finds nothing, and silently no-ops.  No throw, no crash.
        expect(() => app.start()).not.toThrow();

        expect(mockCtor).not.toHaveBeenCalled();

        app.stop();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });
  });

  describe('w24 scenario (c): frame-order regression guard — listener pose reads current frame', () => {
    it('modify Transform.posX before second frame → listener reflects new value, not stale', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      let context: AudioContext | undefined;
      const mockCtor = vi.fn(function AudioContextMock(this: Record<string, unknown>) {
        context = makeMockAudioContextForListenerSync();
        Object.assign(this, context);
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for AudioContext constructor -- must use function (not arrow) so new AudioContext() is constructable
      globalThis.AudioContext = mockCtor as any;

      const rafStub = installRafStub();

      try {
        const canvas = {
          tagName: 'canvas',
          isConnected: true,
          width: 800,
          height: 600,
        } as HTMLCanvasElement;

        const result = await createApp(canvas, { plugins: [webAudioPlugin(), audioPlugin()] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // Spawn entity at (0,0,0).
        const spawnResult = app.world.spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: AudioListenerComponent, data: {} },
        );
        expect(spawnResult.ok).toBe(true);
        if (!spawnResult.ok) return;
        const entity = spawnResult.value;

        // Frame 1: propagateTransforms computes world with posX=0,
        // listener-sync reads it → positionX === 0.
        app.start();
        const listener = context?.listener;
        if (!listener) throw new Error('expected host AudioContext.listener');
        expect(listener.positionX.value).toBe(0);

        // Modify local position: simulate a frame callback that moves the
        // listener entity. If the listener-sync system ran BEFORE
        // propagateTransforms, the next frame would still read the old
        // world mat4 with posX=0 (1-frame lag).
        const setResult = app.world.set(entity, Transform, { pos: [8, 0, 0] });
        expect(setResult.ok).toBe(true);

        // Frame 2: propagateTransforms recomputes world with posX=8,
        // listener-sync reads the CURRENT frame's world → positionX === 8.
        // This assertion is the R-listener-frame-order regression guard.
        expect(rafStub.tickFn).not.toBeNull();
        if (rafStub.tickFn) {
          rafStub.tickFn();
        }

        expect(listener.positionX.value).toBe(8);

        app.stop();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });
  });
});

vi.mock('@forgeax/engine-platform-browser', () => import('./platform-fixture'));
