import { testPlatform } from './platform-fixture';
// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M6 / w22.
//
// Runtime unit test for assemble ownership: createApp({renderer, world}).stop()
// stops the App loop but leaves the host-owned Renderer alive.
//
// Mock approach (mirrors packages/app/__tests__/app.unit.test.ts
// `makeRendererStub` pattern): build a minimal Renderer stub with
// resolved `ready` + a `vi.fn()` `dispose` spy. createApp's assemble
// form awaits `renderer.ready` so the stub must surface a settled
// Result.ok promise. Subscribing renderer.onError is internal to
// createApp.start() (R-1 timing); we return a noop unsubscribe.

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { RendererContractFailureError } from '../../../render/src/errors/render';

import { createApp } from '../create-app';

type ReadyResult = { ok: true; value: undefined } | { ok: false; error: RhiError };

interface StubRenderer {
  readonly renderer: Renderer;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
  readonly releaseSurfaceSpy: ReturnType<typeof vi.fn>;
  readonly restoreSurfaceSpy: ReturnType<typeof vi.fn>;
}

function makeRendererStubForStop(): StubRenderer {
  const ready: Promise<ReadyResult> = Promise.resolve({ ok: true, value: undefined });
  const disposeSpy = vi.fn<() => void>();
  const releaseSurfaceSpy = vi.fn(() => ok(undefined));
  const restoreSurfaceSpy = vi.fn(() => ok(undefined));
  const renderer = {
    state: () => 'alive' as const,
    backend: 'webgpu' as const,
    ready,
    draw(): { ok: true; value: undefined } {
      return { ok: true, value: undefined };
    },
    attach(): { ok: true; value: undefined } {
      return { ok: true, value: undefined };
    },
    detachWorld(): void {},
    subscribe(): () => void {
      return () => {
        // no-op unsubscribe
      };
    },
    releaseSurface: releaseSurfaceSpy,
    restoreSurface: restoreSurfaceSpy,
    dispose: disposeSpy,
  } as unknown as Renderer;
  return { renderer, disposeSpy, releaseSurfaceSpy, restoreSurfaceSpy };
}

function makeRendererStubWithPendingReceipt(): {
  readonly renderer: Renderer;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
  readonly settle: () => void;
} {
  let settle!: () => void;
  const completed = new Promise<{ ok: true; value: undefined }>((resolve) => {
    settle = () => resolve({ ok: true, value: undefined });
  });
  const disposeSpy = vi.fn<() => void>();
  const renderer = {
    state: () => 'alive' as const,
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: vi.fn(() => ({
      ok: true as const,
      value: { frameId: 1, deviceGeneration: 0, completed },
    })),
    attach: () => ({ ok: true as const, value: { dispose: () => {} } }),
    detachWorld: () => {},
    subscribe: () => () => {},
    dispose: disposeSpy,
  } as unknown as Renderer;
  return { renderer, disposeSpy, settle };
}

describe('create-app-stop.test.ts', () => {
  describe('App presentation-surface lease', () => {
    it('releases and restores presentation without replacing World or Renderer', async () => {
      const { renderer, releaseSurfaceSpy, restoreSurfaceSpy } = makeRendererStubForStop();
      const world = new World();
      const result = await createApp({ platform: testPlatform(), renderer, world });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      expect(app.start().ok).toBe(true);
      expect((await app.releaseSurfacePreserveWorld()).ok).toBe(true);
      expect(releaseSurfaceSpy).toHaveBeenCalledTimes(1);
      expect(app.world).toBe(world);
      expect(app.renderer).toBe(renderer);

      expect((await app.restoreSurface()).ok).toBe(true);
      expect(restoreSurfaceSpy).toHaveBeenCalledTimes(1);
      expect(app.world).toBe(world);
      expect(app.renderer).toBe(renderer);
    });

    it('does not restore a running loop when surface release fails', async () => {
      const { renderer } = makeRendererStubForStop();
      const releaseError = new RendererContractFailureError('draw', 'forced failure');
      vi.mocked(renderer.releaseSurface).mockReturnValue({ ok: false, error: releaseError });
      const result = await createApp({ platform: testPlatform(), renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.start().ok).toBe(true);
      const released = await result.value.releaseSurfacePreserveWorld();
      expect(released.ok).toBe(false);
      expect(result.value.execution.report().engine.health).toBe('running');
    });
  });

  describe('assemble App stop preserves its host-owned Renderer', () => {
    it('start -> stop does not call renderer.dispose()', async () => {
      const { renderer, disposeSpy } = makeRendererStubForStop();
      const result = await createApp({ platform: testPlatform(), renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      const startResult = app.start();
      expect(startResult.ok).toBe(true);

      const stopResult = app.stop();
      expect(stopResult.ok).toBe(true);
      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('second stop() remains inert for renderer ownership', async () => {
      const { renderer, disposeSpy } = makeRendererStubForStop();
      const result = await createApp({ platform: testPlatform(), renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      app.start();
      app.stop();
      // Second stop returns app-not-started err (frame-loop already idle),
      // but the call itself must not throw and must not re-fire dispose.
      const second = app.stop();
      expect(second.ok).toBe(false);
      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('stop() before start() does not call renderer.dispose()', async () => {
      const { renderer, disposeSpy } = makeRendererStubForStop();
      const result = await createApp({ platform: testPlatform(), renderer, world: new World() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      const stopResult = app.stop();
      expect(stopResult.ok).toBe(false);
      expect(disposeSpy).not.toHaveBeenCalled();

      app.stop();
      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('dispose() drains pending frame receipts before releasing the Renderer fiber', async () => {
      const { renderer, disposeSpy, settle } = makeRendererStubWithPendingReceipt();
      const result = await createApp({
        platform: testPlatform(),
        renderer,
        world: new World(),
        plugins: [
          {
            name: 'test-renderer-owner',
            apply(ctx) {
              ctx.effect(() => () => renderer.dispose(), 'test/renderer');
            },
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const app = result.value;

      expect(app.start().ok).toBe(true);
      expect(app.pause().ok).toBe(true);
      expect(app.stepFrame(1 / 60).ok).toBe(true);

      const disposing = app.dispose();
      await Promise.resolve();
      expect(disposeSpy).not.toHaveBeenCalled();

      settle();
      await disposing;
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// w4: AC-04 -- assemble form does not auto-destroy host-managed audioBackend.
describe('w4: AC-04 assemble form does not auto-destroy external backend', () => {
  it('stop() on assemble-form app with external audioBackend does not call destroy()', async () => {
    const { renderer, disposeSpy: _disposeSpy } = makeRendererStubForStop();
    const destroySpy = vi.fn<() => void>();
    const audioBackend = {
      play: vi.fn(),
      stop: vi.fn(),
      setVolume: vi.fn(),
      setBusVolume: vi.fn(),
      setBusMute: vi.fn(),
      setListenerPose: vi.fn(),
      getState: vi.fn(() => ({
        contextState: 'running' as const,
        activeSourceCount: 0,
        lastError: null,
      })),
      getActiveSourceCount: vi.fn(() => 0),
      destroy: destroySpy,
    };

    const result = await createApp({
      platform: testPlatform(),
      renderer,
      world: (() => {
        const w = new World();
        w.insertResource(AUDIO_ENGINE_RESOURCE_KEY, audioBackend);
        return w;
      })(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;

    const startResult = app.start();
    expect(startResult.ok).toBe(true);

    const stopResult = app.stop();
    expect(stopResult.ok).toBe(true);

    // The external backend is host-managed; the engine MUST NOT call destroy().
    expect(destroySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// feat-20260619 M3: auto-register audioTickSystem (w13/w14 tests, w15 impl)
// ---------------------------------------------------------------------------

import {
  AUDIO_ENGINE_RESOURCE_KEY,
  AudioSource,
  audioBackendPlugin,
  audioPlugin,
} from '@forgeax/engine-audio';
import { createWebAudioBackend, WebAudioEngine } from '@forgeax/engine-audio-webaudio';

function createTestBufferForApp(duration = 1, sampleRate = 48000): AudioBuffer {
  return {
    sampleRate,
    length: duration * sampleRate,
    duration,
    numberOfChannels: 2,
    getChannelData: vi.fn(() => new Float32Array(duration * sampleRate)),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function makeMockAudioContextForApp(): AudioContext {
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

  const mkSrc = vi.fn(
    () =>
      ({
        buffer: null,
        playbackRate: { value: 1 } as unknown as AudioParam,
        detune: { value: 0 } as unknown as AudioParam,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        context: undefined as unknown as BaseAudioContext,
        numberOfInputs: 0,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'max' as const,
        channelInterpretation: 'speakers' as const,
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onended: null,
      }) as unknown as AudioBufferSourceNode,
  );

  const mkPanner = vi.fn(
    () =>
      ({
        panningModel: 'equalpower' as const,
        distanceModel: 'inverse' as const,
        refDistance: 1,
        maxDistance: 10000,
        rolloffFactor: 1,
        coneInnerAngle: 360,
        coneOuterAngle: 360,
        coneOuterGain: 0,
        positionX: { value: 0 } as unknown as AudioParam,
        positionY: { value: 0 } as unknown as AudioParam,
        positionZ: { value: 0 } as unknown as AudioParam,
        orientationX: { value: 1 } as unknown as AudioParam,
        orientationY: { value: 0 } as unknown as AudioParam,
        orientationZ: { value: 0 } as unknown as AudioParam,
        context: undefined as unknown as BaseAudioContext,
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit' as const,
        channelInterpretation: 'speakers' as const,
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as PannerNode,
  );

  return {
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
    listener: {} as unknown as AudioListener,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain: mkGain,
    createBufferSource: mkSrc,
    createPanner: mkPanner,
    decodeAudioData: vi.fn().mockResolvedValue(createTestBufferForApp()),
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
 * Node-env rAF injection: in node, `requestAnimationFrame` is undefined,
 * so resolveRaf (frame-loop.ts:141-153) returns `() => 0` — the tick
 * callback is never invoked. We stub it so `start()` runs one frame
 * synchronously, and the captured tick callback can be driven repeatedly
 * by the test for additional frames.
 *
 * Auto-invoke only on first raf call (from start()), not on subsequent
 * calls (from tick()'s `raf(tick)` at frame-loop.ts:257), to avoid
 * infinite recursion.
 */
function installRafStub(): { tickFn: (() => void) | null } {
  const stub: { tickFn: (() => void) | null } = { tickFn: null };
  let firstCall = true;
  // biome-ignore lint/suspicious/noExplicitAny: vitest stub of a browser Global
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
    stub.tickFn = () => cb(performance.now());
    if (firstCall) {
      firstCall = false;
      stub.tickFn();
    }
    return 1;
  };
  // biome-ignore lint/suspicious/noExplicitAny: vitest stub of a browser Global
  (globalThis as any).cancelAnimationFrame = () => {
    stub.tickFn = null;
  };
  return stub;
}

function uninstallRafStub() {
  delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
}

describe('feat-20260619 M3: auto-register audioTickSystem', () => {
  // w13: AC-12 — audioPlugin registers the audio-tick world system.
  // feat-20260623-plugin-system-unify (M2 / D-2 / D-4): the assemble form no
  // longer auto-wires audio; the host inserts AUDIO_ENGINE_RESOURCE_KEY and
  // passes audioPlugin() in plugins. The audio-tick system then runs inside
  // world.update(1 / 60).unwrap() each frame. Verification goes through the full consumption
  // path: createApp → app.start() → frames tick → AudioSource.playing edge
  // detected → backend.play triggered.
  //
  // Edge-detection semantics (getPrevState, audio-tick-system.ts:187-197):
  // first observation stores current as prev and returns current → no edge.
  // A false→true edge requires two frames: frame 1 sees false (prev=false),
  // frame 2 sees true (prev=false, current=true → play-start).
  describe('w13: AC-12 auto-register wiring verification', () => {
    it('audioPlugin → backend.play triggered after playing edge (full consumption path)', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      globalThis.AudioContext = vi.fn(function AudioContextMock() {
        return makeMockAudioContextForApp();
      }) as unknown as typeof AudioContext;

      const rafStub = installRafStub();

      try {
        const world = new World();

        // Alloc a clip handle so clipResolver can resolve it.
        const clipHandle = world.sharedRefs.alloc('AudioClipAsset', {
          kind: 'audio',
          sourceKey: 'stop-fixture-a',
          bytes: new Uint8Array([1]),
        });

        // Spawn entity with playing=false. After frame 1, turn playing=true
        // to produce a false→true edge on frame 2.
        const spawnResult = world.spawn({
          // biome-ignore lint/suspicious/noExplicitAny: handle type is opaque branded via alloc
          component: AudioSource as any,
          data: {
            clip: clipHandle,
            playing: false,
            loop: false,
            volume: 1,
            spatialBlend: 0,
            bus: 'sfx',
          },
        });
        expect(spawnResult.ok).toBe(true);
        if (!spawnResult.ok) return;
        const entity = spawnResult.value;

        const backend = new WebAudioEngine();
        const playSpy = vi.spyOn(backend, 'play');

        const { renderer } = makeRendererStubForStop();
        // Attach sharedRefs as renderer.assets so buildApp inserts
        // ASSET_REGISTRY_RESOURCE_KEY (clipResolver reads world.sharedRefs
        // directly though, so this is primarily for buildApp coverage).
        const rendererWithAssets = { ...renderer, assets: world.sharedRefs } as unknown as Renderer;
        // New assemble contract (D-2 / D-4): host inserts the audio backend
        // resource + passes audioPlugin() in the plugin list. audioPlugin reads
        // the resource and registers the audio-tick world system.
        const result = await createApp({
          platform: testPlatform(),
          renderer: rendererWithAssets,
          world,
          plugins: [audioBackendPlugin(createWebAudioBackend(backend)), audioPlugin()],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // Frame 1: playing=false (first obs → prev=false → no edge → no play).
        app.start();
        expect(playSpy).not.toHaveBeenCalled();

        // Set playing=true so the next frame detects the false→true edge.
        const setResult = world.set(entity, AudioSource, { playing: true });
        expect(setResult.ok).toBe(true);

        // Frame 2: captured rAF tick runs. The auto-registered audioTickSystem
        // calls getPrevState which sees prev=false, current=true → play-start.
        expect(rafStub.tickFn).not.toBeNull();
        rafStub.tickFn?.();

        expect(world.execution.health).toBe('healthy');
        await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));

        app.stop();
        playSpy.mockRestore();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });

    // Reverse: no audio:true → no registration → no play.
    it('no audio:true → audioTickSystem not registered, backend.play not triggered', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      globalThis.AudioContext = vi.fn(function AudioContextMock() {
        return makeMockAudioContextForApp();
      }) as unknown as typeof AudioContext;

      const rafStub = installRafStub();

      try {
        const world = new World();
        const clipHandle = world.sharedRefs.alloc('AudioClipAsset', {
          kind: 'audio',
          sourceKey: 'stop-fixture-b',
          bytes: new Uint8Array([2]),
        });
        world.spawn({
          // biome-ignore lint/suspicious/noExplicitAny: handle type is opaque branded via alloc
          component: AudioSource as any,
          data: {
            clip: clipHandle,
            playing: true,
            loop: false,
            volume: 1,
            spatialBlend: 0,
            bus: 'sfx',
          },
        });

        const backend = new WebAudioEngine();
        const playSpy = vi.spyOn(backend, 'play');

        // Build WITHOUT audio backend → no tick system registration.
        const { renderer } = makeRendererStubForStop();
        const result = await createApp({ platform: testPlatform(), renderer, world });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        app.start();
        // Since audioTickSystem is never registered, play should never fire.
        expect(playSpy).not.toHaveBeenCalled();

        // Drive additional frames exhaustively.
        for (let i = 0; i < 5; i++) {
          if (rafStub.tickFn) rafStub.tickFn();
        }
        expect(playSpy).not.toHaveBeenCalled();

        app.stop();
        playSpy.mockRestore();
      } finally {
        uninstallRafStub();
        globalThis.AudioContext = OriginalAudioContext;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    });
  });

  // w14: AC-13 — auto-registered audioTickSystem can resolve both
  // AUDIO_ENGINE_RESOURCE_KEY and ASSET_REGISTRY_RESOURCE_KEY on the
  // first frame (no exception, no silent skip due to missing resources).
  describe('w14: AC-13 registration timing — first-frame resolution', () => {
    it('audioTickSystem resolves resources on first frame without error', async () => {
      const OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      globalThis.AudioContext = vi.fn(function AudioContextMock() {
        return makeMockAudioContextForApp();
      }) as unknown as typeof AudioContext;

      const rafStub = installRafStub();

      try {
        const world = new World();
        const clipHandle = world.sharedRefs.alloc('AudioClipAsset', {
          kind: 'audio',
          sourceKey: 'stop-fixture-c',
          bytes: new Uint8Array([3]),
        });

        // Spawn entity with playing=false so first frame walks the
        // archetype without attempting to play — the key assertion is
        // "no exception thrown during first-frame execution".
        world.spawn({
          // biome-ignore lint/suspicious/noExplicitAny: handle type is opaque branded via alloc
          component: AudioSource as any,
          data: {
            clip: clipHandle,
            playing: false,
            loop: false,
            volume: 1,
            spatialBlend: 0,
            bus: 'sfx',
          },
        });

        const backend = new WebAudioEngine();
        const { renderer } = makeRendererStubForStop();
        const rendererWithAssets = { ...renderer, assets: world.sharedRefs } as unknown as Renderer;
        // New assemble contract (D-2 / D-4): host inserts the audio resource +
        // passes audioPlugin() so the audio-tick world system is registered.
        const result = await createApp({
          platform: testPlatform(),
          renderer: rendererWithAssets,
          world,
          plugins: [audioBackendPlugin(createWebAudioBackend(backend)), audioPlugin()],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;

        // First frame: the audio-tick world system walks the
        // AudioSource archetype. clipResolver uses world.sharedRefs (always
        // available on World, not a resource-key lookup). The tick system
        // should not throw due to missing resources.
        expect(() => app.start()).not.toThrow();

        // Drive a few more frames to ensure continuing resolution is stable.
        for (let i = 0; i < 3; i++) {
          if (rafStub.tickFn) rafStub.tickFn();
        }

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
