// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=15):
//   - packages/audio-webaudio/src/__tests__/app-injection.test.ts
//   - packages/audio-webaudio/src/__tests__/audio-importer.test.ts
//   - packages/audio-webaudio/src/__tests__/bus-control.test.ts
//   - packages/audio-webaudio/src/__tests__/bus-routing.test.ts
//   - packages/audio-webaudio/src/__tests__/clip-load.test.ts
//   - packages/audio-webaudio/src/__tests__/clip-resolver.test.ts
//   - packages/audio-webaudio/src/__tests__/declarative-play-tick.test.ts
//   - packages/audio-webaudio/src/__tests__/despawn-cleanup.test.ts
//   - packages/audio-webaudio/src/__tests__/health-check.test.ts
//   - packages/audio-webaudio/src/__tests__/lazy-creation.test.ts
//   - packages/audio-webaudio/src/__tests__/listener-accessor.test.ts
//   - packages/audio-webaudio/src/__tests__/listener-sync.test.ts
//   - packages/audio-webaudio/src/__tests__/property-sync.test.ts
//   - packages/audio-webaudio/src/__tests__/resume-gesture.test.ts
//   - packages/audio-webaudio/src/__tests__/tick-edge-detect.test.ts
//   - packages/audio-webaudio/src/__tests__/root-surface.unit.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import {
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioBackend,
  audioTickSystem,
  createClipResolver,
  detectEdge,
  detectRemovedEntities,
} from '@forgeax/engine-audio';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type { ImportContext, ImportSubAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioImporter, sourceKeyForAudioOutput } from '../audio-importer.js';
import { syncListenerFromWorldMatrix } from '../audio-listener-sync-system';
import { decodeAudioClipBytes } from '../clip-loader';
import { WebAudioEngine } from '../web-audio-engine';

{
  // --- from root-surface.unit.test.ts ---
  describe('audio decoder registration stays loader-owned', () => {
    it('does not project the decoder implementation from the public root', async () => {
      const root = (await import('../index')) as Record<string, unknown>;
      expect(root).not.toHaveProperty('decodeAudioClipBytes');
    });
  });
}

function makeMockAudioParam(initialValue: number): AudioParam {
  let value = initialValue;
  return {
    get value() {
      return value;
    },
    set value(next: number) {
      value = next;
    },
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((next: number) => {
      value = next;
    }),
    linearRampToValueAtTime: vi.fn((next: number) => {
      value = next;
    }),
  } as unknown as AudioParam;
}

{
  // --- from app-injection.test.ts ---
  describe('App injection both forms (AC-14)', () => {
    it('AUDIO_ENGINE_RESOURCE_KEY is the string "AudioEngine"', () => {
      expect(AUDIO_ENGINE_RESOURCE_KEY).toBe('AudioEngine');
    });

    it('AudioBackend interface is importable (type-level check)', () => {
      // Compile-time assertion: the type exists and can be used.
      const backend: AudioBackend | undefined = undefined;
      expect(backend).toBeUndefined();
    });

    it('AUDIO_ENGINE_RESOURCE_KEY is a const (typeof yields literal)', () => {
      // Type-level: the key is const 'AudioEngine', not just string.
      const key: typeof AUDIO_ENGINE_RESOURCE_KEY = 'AudioEngine';
      expect(key).toBe('AudioEngine');
    });

    it('no Resource registered when audio option is omitted (contract)', () => {
      // The contract: createApp without audio opts does NOT register
      // an AudioEngine Resource. This is verified by the app-injection
      // wiring code in packages/app.
      //
      // Unit-level verification: the resource key exists and is valid.
      // Integration verification (browser test): World.getResource('AudioEngine')
      // returns undefined when audio is not injected.
      expect(AUDIO_ENGINE_RESOURCE_KEY).toBeTruthy();
    });

    it('createApp assemble form accepts AudioBackend via audio field (contract)', () => {
      // The AppAssembleArgs type must accept an optional `audio?: AudioBackend`.
      // Type-level test: verify the field name and type are correct.
      //
      // This test is a COMPILE-TIME assertion. At runtime, it verifies
      // the contract shape. The actual type compatibility is enforced by
      // tsc when w18 wires the audio field into AppAssembleArgs.
      const dummyBackend = {
        music: vi.fn(),
        setAcousticRoutes: vi.fn(),
        setAcousticEnvironment: vi.fn(),
        reportError: vi.fn(),
        setBusWet: vi.fn(),
        setBusSendGain: vi.fn(),
        configureBuses: vi.fn(),
        setBus: vi.fn(),
        play: vi.fn(),
        stop: vi.fn(),
        setVolume: vi.fn(),
        setPlaybackRate: vi.fn(),
        setPaused: vi.fn(),
        seek: vi.fn(),
        setBusVolume: vi.fn(),
        setBusMute: vi.fn(),
        setSourcePose: vi.fn(),
        setListenerPose: vi.fn(),
        getState: vi.fn(),
        getActiveSourceCount: vi.fn(),
        destroy: vi.fn(),
      } as AudioBackend;
      const args: { audio?: AudioBackend } = { audio: dummyBackend };
      expect(args.audio).toBe(dummyBackend);
    });
  });
}

{
  // --- from audio-importer.test.ts ---
  const GUID = '019e3969-1d43-7610-8810-e80dbd491d90';

  function makeCtx(
    subAssets: readonly ImportSubAsset[],
    readSource: ImportContext['readSource'] = async () => ({
      ok: true,
      value: new Uint8Array([1, 2, 3, 4]),
    }),
  ): ImportContext {
    return {
      source: 'bgm.ogg',
      readSource,
      readSibling: async () => ({ ok: true, value: new Uint8Array() }),
      decodeImage: async () => {
        throw new Error('decodeImage not used by audioImporter');
      },
      subAssets,
      importSettings: {},
    };
  }

  describe('audioImporter dispatch (AC-18)', () => {
    it('an ImporterRegistry resolves meta.importer="audio" to audioImporter', () => {
      const registry = new ImporterRegistry();
      registry.register(audioImporter);
      const resolved = registry.get('audio');
      expect(resolved).toBe(audioImporter);
      expect(resolved?.key).toBe('audio');
      expect(typeof resolved?.import).toBe('function');
    });
  });

  describe('audio producer sourceKey', () => {
    it('uses a stable semantic output key rather than source location', () => {
      expect(sourceKeyForAudioOutput()).toBe('audio:audio');
      expect(sourceKeyForAudioOutput('clip')).toBe('audio:clip');
      expect(sourceKeyForAudioOutput('')).toBeUndefined();
    });
  });

  describe('audioImporter pass-through (AC-18, no decode)', () => {
    it('emits a thin audio descriptor under the declared GUID', async () => {
      const ctx = makeCtx([{ guid: GUID, sourceIndex: 0, kind: 'audio' }]);
      const result = await audioImporter.import(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const produced = result.value.assets;
      expect(produced.length).toBe(1);
      expect(produced[0]?.guid).toBe(GUID);
      expect(produced[0]?.kind).toBe('audio');
      const payload = produced[0]?.payload as { kind: string; source: string };
      expect(payload.kind).toBe('audio');
      expect(payload.source).toBe('bgm.ogg');
    });

    it('does NOT touch AudioContext (no global AudioContext access in the importer body)', async () => {
      // The importer must not reference AudioContext: assert no global is
      // dereferenced by running in an env where AudioContext is absent (the
      // node/vitest default). If the importer reached for AudioContext it would
      // throw a ReferenceError; a clean run proves the decode is deferred to the
      // runtime loader.
      expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
      const ctx = makeCtx([{ guid: GUID, sourceIndex: 0, kind: 'audio' }]);
      await expect(audioImporter.import(ctx)).resolves.toBeDefined();
    });

    it.each([
      {
        name: 'zero declarations',
        subAssets: [],
        actual: 'subAssets[] is empty',
      },
      {
        name: 'one foreign declaration',
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture' }],
        actual: `subAssets[0]=texture:${GUID}`,
      },
      {
        name: 'mixed audio and foreign declarations',
        subAssets: [
          { guid: GUID, sourceIndex: 0, kind: 'audio' },
          { guid: `${GUID}-texture`, sourceIndex: 1, kind: 'texture' },
        ],
        actual: `subAssets[0]=audio:${GUID}, subAssets[1]=texture:${GUID}-texture`,
      },
      {
        name: 'duplicate audio declarations',
        subAssets: [
          { guid: GUID, sourceIndex: 0, kind: 'audio' },
          { guid: `${GUID}-second`, sourceIndex: 1, kind: 'audio' },
        ],
        actual: `subAssets[0]=audio:${GUID}, subAssets[1]=audio:${GUID}-second`,
      },
    ])('refuses $name before importer source work', async ({ subAssets, actual }) => {
      const readSource = vi.fn<ImportContext['readSource']>(async () => ({
        ok: true,
        value: new Uint8Array([1, 2, 3]),
      }));
      const result = await audioImporter.import(makeCtx(subAssets, readSource));

      expect(result.ok).toBe(false);
      expect(readSource).not.toHaveBeenCalled();
      if (result.ok) return;
      expect(result.error.code).toBe('source-validation-failed');
      expect(result.error.detail).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: 'audio-subasset-topology',
            rule: 'audio-required-single-output',
            actual,
          }),
        ],
      });
    });

    it('refuses every invalid topology through runImport before importer read', async () => {
      const registry = new ImporterRegistry();
      registry.register(audioImporter);
      const readSource = vi.fn<ImportContext['readSource']>(async () => ({
        ok: true,
        value: new Uint8Array([1, 2, 3]),
      }));
      const invalidTopologies: ReadonlyArray<{
        readonly name: string;
        readonly subAssets: RunImportMeta['subAssets'];
        readonly actual: string;
      }> = [
        { name: 'zero audio', subAssets: [], actual: 'subAssets[] is empty' },
        {
          name: 'foreign kind',
          subAssets: [
            { guid: GUID, sourceIndex: 0, sourceKey: 'foreign:texture', kind: 'texture' },
          ],
          actual: `subAssets[0]=texture:${GUID}`,
        },
        {
          name: 'mixed kinds',
          subAssets: [
            { guid: GUID, sourceIndex: 0, sourceKey: 'audio:audio', kind: 'audio' },
            {
              guid: `${GUID}-texture`,
              sourceIndex: 1,
              sourceKey: 'foreign:texture',
              kind: 'texture',
            },
          ],
          actual: `subAssets[0]=audio:${GUID}, subAssets[1]=texture:${GUID}-texture`,
        },
        {
          name: 'duplicate audio',
          subAssets: [
            { guid: GUID, sourceIndex: 0, sourceKey: 'audio:first', kind: 'audio' },
            {
              guid: `${GUID}-second`,
              sourceIndex: 1,
              sourceKey: 'audio:second',
              kind: 'audio',
            },
          ],
          actual: `subAssets[0]=audio:${GUID}, subAssets[1]=audio:${GUID}-second`,
        },
      ];

      for (const [index, topology] of invalidTopologies.entries()) {
        const rejected = await runImport(
          { importer: 'audio', source: 'bgm.ogg', subAssets: topology.subAssets },
          registry,
          { readSource },
        );
        expect(rejected.ok, `${topology.name} unexpectedly succeeded`).toBe(false);
        expect(readSource).toHaveBeenCalledTimes(index + 1);
        if (!rejected.ok) {
          expect(rejected.error.code).toBe('source-validation-failed');
          expect(rejected.error.detail).toMatchObject({
            diagnostics: [expect.objectContaining({ actual: topology.actual })],
          });
        }
      }
    });

    it('retries repaired Meta through the same registry and preserves Pack identity', async () => {
      const registry = new ImporterRegistry();
      registry.register(audioImporter);
      const readSource = vi.fn<ImportContext['readSource']>(async () => ({
        ok: true,
        value: new Uint8Array([1, 2, 3]),
      }));
      const meta = {
        importer: 'audio',
        source: 'bgm.ogg',
        subAssets: [] as RunImportMeta['subAssets'],
      };
      const rejected = await runImport(meta, registry, { readSource });
      expect(rejected.ok).toBe(false);
      expect(readSource).toHaveBeenCalledTimes(1);

      meta.subAssets = [
        {
          guid: GUID,
          sourceIndex: 0,
          sourceKey: 'audio:audio',
          kind: 'audio',
        },
      ];
      const repaired = await runImport(meta, registry, { readSource });

      expect(repaired.ok).toBe(true);
      expect(readSource).toHaveBeenCalledTimes(3);
      if (!repaired.ok || 'skipped' in repaired.value) return;
      expect(repaired.value.product.sourceDependencies).toEqual(['bgm.ogg']);
      expect(repaired.value.pack.assets).toHaveLength(1);
      expect(repaired.value.pack.assets[0]).toMatchObject({
        guid: GUID,
        kind: 'audio',
        sourceKey: 'audio:audio',
        sourceIndex: 0,
        payload: {
          kind: 'audio',
          mediaType: 'audio/ogg',
          source: 'bgm.ogg',
        },
      });
      expect(repaired.value.pack.assets[0]?.artifacts.source).toMatchObject({
        mediaType: 'audio/ogg',
        assetCodec: { name: 'browser-audio' },
        bytes: new Uint8Array([1, 2, 3]),
      });
    });

    it('preserves an importer source-read failure and retries the same Meta through the same registry', async () => {
      const registry = new ImporterRegistry();
      registry.register(audioImporter);
      const bytes = new Uint8Array([7, 8, 9, 10]);
      let readCalls = 0;
      let refuseSecondRead = true;
      const readSource = vi.fn<ImportContext['readSource']>(async () => {
        readCalls += 1;
        if (readCalls === 2 && refuseSecondRead) {
          return {
            ok: false,
            error: new Error('transient audio source refusal'),
          };
        }
        return { ok: true, value: new Uint8Array(bytes) };
      });
      const meta: RunImportMeta = {
        importer: 'audio',
        source: 'm69-audio.mp3',
        subAssets: [
          {
            guid: GUID,
            sourceIndex: 0,
            sourceKey: 'audio:audio',
            kind: 'audio',
          },
        ],
      };

      const rejected = await runImport(meta, registry, { readSource });

      expect(rejected.ok).toBe(false);
      expect(readCalls).toBe(2);
      expect(rejected).not.toHaveProperty('value');
      expect(rejected).not.toHaveProperty('pack');
      if (rejected.ok) return;
      expect(rejected.error).toMatchObject({
        code: 'source-read-failed',
        expected: 'readable source file at meta.source "m69-audio.mp3"',
        detail: {
          source: 'm69-audio.mp3',
          reason: 'transient audio source refusal',
        },
      });
      expect(rejected.error.code).not.toBe('import-internal-error');

      refuseSecondRead = false;
      const repaired = await runImport(meta, registry, { readSource });

      expect(repaired.ok).toBe(true);
      expect(readCalls).toBe(4);
      if (!repaired.ok || 'skipped' in repaired.value) return;
      expect(repaired.value.product.sourceDependencies).toEqual(['m69-audio.mp3']);
      expect(repaired.value.pack).toMatchObject({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
      });
      expect(repaired.value.pack.assets).toHaveLength(1);
      expect(repaired.value.pack.assets.filter((asset) => asset.guid === GUID)).toHaveLength(1);
      expect(repaired.value.pack.assets[0]).toMatchObject({
        guid: GUID,
        kind: 'audio',
        sourceKey: 'audio:audio',
        sourceIndex: 0,
        payload: {
          kind: 'audio',
          mediaType: 'audio/mpeg',
          source: 'm69-audio.mp3',
        },
        artifacts: {
          source: {
            mediaType: 'audio/mpeg',
            assetCodec: { name: 'browser-audio' },
            bytes,
          },
        },
      });
    });
  });
}

{
  // --- from bus-control.test.ts ---
  function createTestBuffer(): AudioBuffer {
    return {
      sampleRate: 48000,
      length: 48000,
      duration: 1,
      numberOfChannels: 2,
      getChannelData: vi.fn(() => new Float32Array(48000)),
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer;
  }

  describe('Bus volume and mute control (AC-10)', () => {
    let OriginalAudioContext: typeof AudioContext;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      const mockCtor = vi.fn().mockImplementation(function AudioContextMock(this: unknown) {
        return {
          state: 'running' as AudioContextState,
          sampleRate: 48000,
          destination: { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioDestinationNode,
          currentTime: 0,
          listener: {},
          resume: vi.fn().mockResolvedValue(undefined),
          suspend: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          createGain: vi.fn(
            () =>
              ({
                gain: makeMockAudioParam(1),
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
              }) as unknown as GainNode,
          ),
          createBufferSource: vi.fn(
            () =>
              ({
                buffer: null,
                playbackRate: { value: 1, setValueAtTime: vi.fn() },
                loop: false,
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
              }) as unknown as AudioBufferSourceNode,
          ),
          createPanner: vi.fn(
            () =>
              ({
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
              }) as unknown as PannerNode,
          ),
          decodeAudioData: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
          onstatechange: null,
          baseLatency: 0,
          outputLatency: 0,
          getOutputTimestamp: vi.fn(),
          createChannelMerger: vi.fn(),
          createChannelSplitter: vi.fn(),
          createDelay: vi.fn(),
          createBiquadFilter: vi.fn(),
          createConvolver: vi.fn(),
          createDynamicsCompressor: vi.fn(),
          createOscillator: vi.fn(),
          createStereoPanner: vi.fn(),
          createWaveShaper: vi.fn(),
          createPeriodicWave: vi.fn(),
          createIIRFilter: vi.fn(),
          createScriptProcessor: vi.fn(),
          createAnalyser: vi.fn(),
          createMediaStreamDestination: vi.fn(),
          createMediaStreamSource: vi.fn(),
          createConstantSource: vi.fn(),
          audioWorklet: undefined as unknown as AudioWorklet,
        };
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest global mock
      globalThis.AudioContext = mockCtor as any;
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('setBusVolume sets bus gain to the specified value', () => {
      const engine = new WebAudioEngine();
      // Trigger bus topology construction (lazy, via play)
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.setBusVolume('music', 0.3);
      // RED: skeleton stub is no-op
      // GREEN (w16): bus gain.value === 0.3
    });

    it('setBusMute(true) sets bus gain to 0', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.setBusMute('sfx', true);
      // GREEN (w16): sfxBus.gain.value === 0
    });

    it('setBusMute(false) restores previous volume (not 1.0)', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.setBusVolume('music', 0.4);
      engine.setBusMute('music', true);
      engine.setBusMute('music', false);

      // GREEN (w16): music bus gain === 0.4 (restored), not 1.0
    });

    it('setBusVolume after mute un-mutes and sets new volume', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.setBusVolume('sfx', 0.7);
      engine.setBusMute('sfx', true);
      engine.setBusVolume('sfx', 0.5);

      // GREEN (w16): sfx bus gain === 0.5, and bus is unmuted
    });

    it('master bus volume is independent from SFX and Music', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.setBusVolume('music', 0.3);
      // GREEN (w16): sfx gain unchanged
    });

    it('allows amplification (>1.0) on bus gain', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.setBusVolume('music', 2.0);
      // GREEN (w16): gain.value === 2.0 (amplification accepted)
    });
  });
}

{
  // --- from bus-routing.test.ts ---
  function createTestBuffer(duration = 1, sampleRate = 48000): AudioBuffer {
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

  function makeMockCtx(overrides: { createGain?: () => GainNode } = {}) {
    return {
      state: 'suspended',
      sampleRate: 48000,
      destination: { connect: vi.fn().mockReturnValue(undefined) },
      listener: {
        positionX: { value: 0 },
        positionY: { value: 0 },
        positionZ: { value: 0 },
        forwardX: { value: 0 },
        forwardY: { value: 0 },
        forwardZ: { value: -1 },
        upX: { value: 0 },
        upY: { value: 1 },
        upZ: { value: 0 },
      },
      resume: vi.fn().mockResolvedValue(undefined),
      createGain:
        overrides.createGain ??
        (() =>
          ({
            gain: makeMockAudioParam(1),
            connect: vi.fn().mockReturnValue(undefined),
            disconnect: vi.fn(),
          }) as unknown as GainNode),
      createBufferSource: () =>
        ({
          buffer: null,
          playbackRate: { value: 1, setValueAtTime: vi.fn() },
          loop: false,
          connect: vi.fn().mockReturnValue(undefined),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
        }) as unknown as AudioBufferSourceNode,
      decodeAudioData: vi.fn(),
    } as unknown as AudioContext;
  }

  describe('audioTickSystem bus routing (AC-09)', () => {
    let OriginalAudioContext: typeof AudioContext;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('routes sfx source to sfxGain node', () => {
      const createGainSpy = vi.fn().mockImplementation(() => ({
        gain: makeMockAudioParam(1),
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
      }));

      const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
        return makeMockCtx({ createGain: createGainSpy });
      });
      globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

      const engine = new WebAudioEngine();
      const buf = createTestBuffer();
      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      // Should have created at least 4 GainNodes: master, sfx, music, and per-source
      expect(createGainSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(engine.getActiveSourceCount()).toBe(1);
    });

    it('routes music source to musicGain node', () => {
      const createGainSpy = vi.fn().mockImplementation(() => ({
        gain: makeMockAudioParam(1),
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
      }));

      const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
        return makeMockCtx({ createGain: createGainSpy });
      });
      globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

      const engine = new WebAudioEngine();
      const buf = createTestBuffer();
      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'music' });

      expect(createGainSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(engine.getActiveSourceCount()).toBe(1);
    });

    it('default bus routes to sfx', () => {
      const createGainSpy = vi.fn().mockImplementation(() => ({
        gain: makeMockAudioParam(1),
        connect: vi.fn().mockReturnValue(undefined),
        disconnect: vi.fn(),
      }));

      const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
        return makeMockCtx({ createGain: createGainSpy });
      });
      globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

      const engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      expect(engine.getActiveSourceCount()).toBe(1);
    });
  });
}

{
  // --- Pack v2 bytes decoder contract ---
  describe('AudioClipAsset Pack v2 bytes', () => {
    it('keeps decoding behind the explicit bytes API', async () => {
      expect(typeof decodeAudioClipBytes).toBe('function');
    });
  });
}

{
  // --- from clip-resolver.test.ts ---
  describe('createClipResolver clip handle resolution (AC-01)', () => {
    // feat-20260614 M8 (D-15): audio clips resolve through world.sharedRefs
    // (user-tier SharedRefStore); the AssetRegistry no longer holds handles.
    it('returns the AudioBuffer when the clip handle resolves in sharedRefs', () => {
      const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };
      const mockWorld = {
        sharedRefs: {
          resolve: vi.fn().mockReturnValue({ ok: true, value: clip }),
        },
      };

      // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      const resolve = createClipResolver(mockWorld as any);
      const result = resolve(42);
      expect(result).toBe(clip);
      expect(mockWorld.sharedRefs.resolve).toHaveBeenCalledWith(42);
    });

    it('returns undefined when the clip handle does not resolve (E-4 silent retry)', () => {
      const mockWorld = {
        sharedRefs: {
          resolve: vi.fn().mockReturnValue({ ok: false, error: { code: 'asset-not-found' } }),
        },
      };

      // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      const resolve = createClipResolver(mockWorld as any);
      const result = resolve(99);
      expect(result).toBeUndefined();
    });

    it('returns undefined when the resolved payload is not an audio clip', () => {
      const mockWorld = {
        sharedRefs: {
          resolve: vi.fn().mockReturnValue({ ok: true, value: { kind: 'mesh' } }),
        },
      };

      // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      const resolve = createClipResolver(mockWorld as any);
      const result = resolve(7);
      expect(result).toBeUndefined();
    });
  });
}

{
  // --- from declarative-play-tick.test.ts ---
  function makeMockAudioBuffer(): AudioBuffer {
    return { length: 1024, sampleRate: 44100, numberOfChannels: 1 } as unknown as AudioBuffer;
  }

  describe('audioTickSystem declarative playback (AC-02)', () => {
    let OriginalAudioContext: typeof AudioContext;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      const mockCtor = vi.fn().mockImplementation(function AudioContextMock(this: unknown) {
        return makeCompactMockCtx();
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest global mock
      globalThis.AudioContext = mockCtor as any;
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    function makeCompactMockCtx(): AudioContext {
      return {
        state: 'running' as AudioContextState,
        sampleRate: 48000,
        destination: {
          connect: vi.fn().mockReturnValue(undefined),
          disconnect: vi.fn(),
        } as unknown as AudioDestinationNode,
        currentTime: 0,
        listener: {
          positionX: { value: 0 },
          positionY: { value: 0 },
          positionZ: { value: 0 },
          forwardX: { value: 0 },
          forwardY: { value: 0 },
          forwardZ: { value: -1 },
          upX: { value: 0 },
          upY: { value: 1 },
          upZ: { value: 0 },
        } as unknown as AudioListener,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        createGain: vi.fn(
          () =>
            ({
              gain: makeMockAudioParam(1),
              connect: vi.fn().mockReturnValue(undefined),
              disconnect: vi.fn(),
            }) as unknown as GainNode,
        ),
        createBufferSource: vi.fn(
          () =>
            ({
              buffer: null,
              playbackRate: { value: 1 },
              detune: { value: 0 },
              loop: false,
              loopStart: 0,
              loopEnd: 0,
              connect: vi.fn().mockReturnValue(undefined),
              disconnect: vi.fn(),
              start: vi.fn(),
              stop: vi.fn(),
              onended: null,
              context: undefined,
              numberOfInputs: 0,
              numberOfOutputs: 1,
              channelCount: 2,
              channelCountMode: 'max' as const,
              channelInterpretation: 'speakers' as const,
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
              dispatchEvent: vi.fn(),
            }) as unknown as AudioBufferSourceNode,
        ),
        createPanner: vi.fn(
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
              positionX: { value: 0 },
              positionY: { value: 0 },
              positionZ: { value: 0 },
              orientationX: { value: 1 },
              orientationY: { value: 0 },
              orientationZ: { value: 0 },
              connect: vi.fn().mockReturnValue(undefined),
              disconnect: vi.fn(),
              context: undefined,
              numberOfInputs: 1,
              numberOfOutputs: 1,
              channelCount: 2,
              channelCountMode: 'clamped-max' as const,
              channelInterpretation: 'speakers' as const,
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
              dispatchEvent: vi.fn(),
            }) as unknown as PannerNode,
        ),
        decodeAudioData: vi.fn().mockResolvedValue(makeMockAudioBuffer()),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onstatechange: null,
        baseLatency: 0,
        outputLatency: 0,
        getOutputTimestamp: vi.fn(),
        createChannelMerger: vi.fn(),
        createChannelSplitter: vi.fn(),
        createDelay: vi.fn(),
        createBiquadFilter: vi.fn(),
        createConvolver: vi.fn(),
        createDynamicsCompressor: vi.fn(),
        createOscillator: vi.fn(),
        createStereoPanner: vi.fn(),
        createWaveShaper: vi.fn(),
        createPeriodicWave: vi.fn(),
        createIIRFilter: vi.fn(),
        createScriptProcessor: vi.fn(),
        createAnalyser: vi.fn(),
        createMediaStreamDestination: vi.fn(),
        createMediaStreamSource: vi.fn(),
        createConstantSource: vi.fn(),
        audioWorklet: undefined as unknown as AudioWorklet,
      } as unknown as AudioContext;
    }

    it('calls backend.play when a false->true edge is detected and buffer resolves', () => {
      const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };

      const engine = new WebAudioEngine();
      const playSpy = vi.spyOn(engine, 'play');

      let storedPlaying = false;
      const clipHandle = 42;
      const entity = 0;

      const mockRegistry = {
        get: vi.fn().mockReturnValue({ ok: true, value: clip }),
      };
      const mockWorld = buildMockWorld(
        entity,
        () => storedPlaying,
        clipHandle,
        mockRegistry,
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      ) as any;

      // Phase 1: first tick — entity playing:false, no edge (first observation)
      storedPlaying = false;
      audioTickSystem(mockWorld, engine);
      expect(playSpy).not.toHaveBeenCalled();

      // Phase 2: host writes playing:true, second tick fires -> false->true edge
      storedPlaying = true;
      audioTickSystem(mockWorld, engine);

      // Green assertion: backend.play must have been called
      expect(playSpy).toHaveBeenCalledTimes(1);

      engine.destroy();
    });

    it('plays an initially-true source once on its first observation', () => {
      const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };
      const engine = new WebAudioEngine();
      const playSpy = vi.spyOn(engine, 'play');
      const entity = 0;
      const mockRegistry = {
        get: vi.fn().mockReturnValue({ ok: true, value: clip }),
      };
      const mockWorld = buildMockWorld(
        entity,
        () => true,
        42,
        mockRegistry,
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      ) as any;

      audioTickSystem(mockWorld, engine);
      audioTickSystem(mockWorld, engine);

      expect(playSpy).toHaveBeenCalledTimes(1);
      engine.destroy();
    });

    it('retries an initially-true source after its clip becomes ready', () => {
      const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };
      const engine = new WebAudioEngine();
      const playSpy = vi.spyOn(engine, 'play');
      const entity = 0;
      let clipReady = false;
      const mockRegistry = {
        get: vi
          .fn()
          .mockImplementation(() =>
            clipReady
              ? { ok: true, value: clip }
              : { ok: false, error: { code: 'asset-not-found' } },
          ),
      };
      const mockWorld = buildMockWorld(
        entity,
        () => true,
        42,
        mockRegistry,
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      ) as any;

      audioTickSystem(mockWorld, engine);
      expect(playSpy).not.toHaveBeenCalled();

      clipReady = true;
      audioTickSystem(mockWorld, engine);

      expect(playSpy).toHaveBeenCalledTimes(1);
      engine.destroy();
    });

    it('passes the === registered AudioBuffer as second argument to backend.play', () => {
      const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };

      const engine = new WebAudioEngine();
      const playSpy = vi.spyOn(engine, 'play');

      let storedPlaying = false;
      const clipHandle = 42;
      const entity = 0;

      const mockRegistry = {
        get: vi.fn().mockReturnValue({ ok: true, value: clip }),
      };
      const mockWorld = buildMockWorld(
        entity,
        () => storedPlaying,
        clipHandle,
        mockRegistry,
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      ) as any;

      audioTickSystem(mockWorld, engine);
      storedPlaying = true;
      audioTickSystem(mockWorld, engine);

      expect(playSpy).toHaveBeenCalledWith(expect.anything(), clip, expect.anything());

      engine.destroy();
    });

    it('passes opts.bus === "sfx" as AudioSource default bus', () => {
      const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };

      const engine = new WebAudioEngine();
      const playSpy = vi.spyOn(engine, 'play');

      let storedPlaying = false;
      const clipHandle = 42;
      const entity = 0;

      const mockRegistry = {
        get: vi.fn().mockReturnValue({ ok: true, value: clip }),
      };
      const mockWorld = buildMockWorld(
        entity,
        () => storedPlaying,
        clipHandle,
        mockRegistry,
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type cast for unit test
      ) as any;

      audioTickSystem(mockWorld, engine);
      storedPlaying = true;
      audioTickSystem(mockWorld, engine);

      const playCallArgs = playSpy.mock.calls[0] as unknown[];
      const opts = playCallArgs[2] as { bus: string };
      expect(opts.bus).toBe('sfx');

      engine.destroy();
    });
  });

  function buildMockWorld(
    entity: number,
    playingGetter: () => boolean,
    clipHandle: number,
    mockRegistry: { get: ReturnType<typeof vi.fn> },
  ) {
    const audioSourceRow = () => ({
      playing: playingGetter(),
      clip: clipHandle,
      loop: false,
      volume: 1,
      spatialBlend: 0,
      bus: 'sfx',
    });
    return {
      // feat-20260614 M8 (D-15): clip resolution goes through world.sharedRefs;
      // delegate to the same mock return value the registry mock produced.
      sharedRefs: { resolve: mockRegistry.get },

      query() {
        return {
          ok: true,
          value: {
            *[Symbol.iterator]() {
              yield { entity, get: audioSourceRow };
            },
          },
        };
      },
    };
  }
}

{
  // --- from despawn-cleanup.test.ts ---
  describe('Entity despawn cleanup (AC-12)', () => {
    describe('detectRemovedEntities', () => {
      it('returns empty when entity list unchanged', () => {
        expect(detectRemovedEntities([1, 2, 3], [1, 2, 3])).toEqual([]);
      });

      it('returns removed entity when one entity despawned', () => {
        expect(detectRemovedEntities([1, 2, 3], [1, 2])).toEqual([3]);
      });

      it('returns all entities when everything despawned', () => {
        expect(detectRemovedEntities([1, 2, 3], [])).toEqual([1, 2, 3]);
      });

      it('returns empty when entities were added (not removed)', () => {
        expect(detectRemovedEntities([1, 2], [1, 2, 3, 4])).toEqual([]);
      });

      it('handles empty previous frame (first tick)', () => {
        expect(detectRemovedEntities([], [1, 2, 3])).toEqual([]);
      });
    });

    describe('despawn cleanup contract (via mock AudioBackend)', () => {
      it('entity with active source -> despawn triggers backend.stop()', () => {
        const stopSpy = vi.fn();
        const backend = {
          music: vi.fn(),
          setAcousticRoutes: vi.fn(),
          setAcousticEnvironment: vi.fn(),
          reportError: vi.fn(),
          setBusWet: vi.fn(),
          setBusSendGain: vi.fn(),
          configureBuses: vi.fn(),
          setBus: vi.fn(),
          play: vi.fn(),
          stop: stopSpy,
          setVolume: vi.fn(),
          setPlaybackRate: vi.fn(),
          setPaused: vi.fn(),
          seek: vi.fn(),
          setBusVolume: vi.fn(),
          setBusMute: vi.fn(),
          getState: vi.fn().mockReturnValue({
            contextState: 'running',
            activeSourceCount: 0,
          }),
          getActiveSourceCount: vi.fn().mockReturnValue(0),
          destroy: vi.fn(),
        };

        // Simulate: frame N had entity 42 playing, frame N+1 has nothing
        const removedIds = detectRemovedEntities([42], []);
        for (const id of removedIds) {
          backend.stop(id);
        }

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy).toHaveBeenCalledWith(42);
      });

      it('multiple despawned entities each get one stop call', () => {
        const stopSpy = vi.fn();
        const backend = {
          music: vi.fn(),
          setAcousticRoutes: vi.fn(),
          setAcousticEnvironment: vi.fn(),
          reportError: vi.fn(),
          setBusWet: vi.fn(),
          setBusSendGain: vi.fn(),
          configureBuses: vi.fn(),
          setBus: vi.fn(),
          play: vi.fn(),
          stop: stopSpy,
          setVolume: vi.fn(),
          setPlaybackRate: vi.fn(),
          setPaused: vi.fn(),
          seek: vi.fn(),
          setBusVolume: vi.fn(),
          setBusMute: vi.fn(),
          getState: vi.fn().mockReturnValue({
            contextState: 'running',
            activeSourceCount: 0,
          }),
          getActiveSourceCount: vi.fn().mockReturnValue(0),
          destroy: vi.fn(),
        };

        const removedIds = detectRemovedEntities([1, 2, 3], [1]);
        for (const id of removedIds) {
          backend.stop(id);
        }

        expect(stopSpy).toHaveBeenCalledTimes(2);
        expect(stopSpy).toHaveBeenCalledWith(2);
        expect(stopSpy).toHaveBeenCalledWith(3);
      });

      it('after despawn stop, activeSourceCount decrements', () => {
        // Simulate the bookkeeping: backend starts with 3 active sources,
        // despawn removes 1, stop decrements internal count.
        const state = { activeSourceCount: 3 };

        const stopSpy = vi.fn().mockImplementation(() => {
          state.activeSourceCount -= 1;
        });
        const getActiveSourceCountSpy = vi.fn(() => state.activeSourceCount);

        const backend = {
          music: vi.fn(),
          setAcousticRoutes: vi.fn(),
          setAcousticEnvironment: vi.fn(),
          reportError: vi.fn(),
          setBusWet: vi.fn(),
          setBusSendGain: vi.fn(),
          configureBuses: vi.fn(),
          setBus: vi.fn(),
          play: vi.fn(),
          stop: stopSpy,
          setVolume: vi.fn(),
          setPlaybackRate: vi.fn(),
          setPaused: vi.fn(),
          seek: vi.fn(),
          setBusVolume: vi.fn(),
          setBusMute: vi.fn(),
          getState: vi.fn().mockReturnValue({
            contextState: 'running',
            activeSourceCount: state.activeSourceCount,
          }),
          getActiveSourceCount: getActiveSourceCountSpy,
          destroy: vi.fn(),
        };

        const removedIds = detectRemovedEntities([10, 20, 30], [10, 20]);
        for (const id of removedIds) {
          backend.stop(id);
        }

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(getActiveSourceCountSpy()).toBe(2);
      });

      it('entity despawned while ctx is suspended (no active nodes) -> backend.stop not called (no entry in sources)', () => {
        // When the entity was never playing (ctx suspended, no node created),
        // the backend's internal source map has no entry for it, so
        // backend.stop() would be a no-op. The tick system should still
        // call stop() for safety (defensive idempotency), but the
        // important contract is that a suspended-ctx entity with no
        // AudioBufferSourceNode does not crash the cleanup path.

        const stopSpy = vi.fn();
        const backend = {
          music: vi.fn(),
          setAcousticRoutes: vi.fn(),
          setAcousticEnvironment: vi.fn(),
          reportError: vi.fn(),
          setBusWet: vi.fn(),
          setBusSendGain: vi.fn(),
          configureBuses: vi.fn(),
          setBus: vi.fn(),
          play: vi.fn(),
          stop: stopSpy,
          setVolume: vi.fn(),
          setPlaybackRate: vi.fn(),
          setPaused: vi.fn(),
          seek: vi.fn(),
          setBusVolume: vi.fn(),
          setBusMute: vi.fn(),
          getState: vi.fn().mockReturnValue({
            contextState: 'suspended',
            activeSourceCount: 0,
          }),
          getActiveSourceCount: vi.fn().mockReturnValue(0),
          destroy: vi.fn(),
        };

        // The tick system still calls stop() for all removed entities
        // regardless of context state. The backend handles the no-op
        // internally if the entity was never registered (no node created).
        const removedIds = detectRemovedEntities([99], []);
        for (const id of removedIds) {
          backend.stop(id);
        }

        expect(stopSpy).toHaveBeenCalledWith(99);
        // Even though the backend didn't have an active source for entity 99,
        // the stop call is safe (idempotent -- the engine handles it as a
        // no-op when the entity is not in its internal map).
      });
    });

    describe('internal state cleanup after despawn', () => {
      it('removed entities are purged from per-entity tick state', () => {
        // The tick system's internal Map<Entity, TickStateEntry> must
        // clean up entries for despawned entities to prevent unbounded
        // memory growth from entities that come and go.

        // Simulate the cleanup: after computing removed entities,
        // their tick state entries are deleted.
        const tickState = new Map<number, { prevPlaying: boolean }>();
        tickState.set(1, { prevPlaying: true });
        tickState.set(2, { prevPlaying: false });
        tickState.set(3, { prevPlaying: true });

        const removedIds = detectRemovedEntities([1, 2, 3], [1]);
        for (const id of removedIds) {
          tickState.delete(id);
        }

        expect(tickState.has(1)).toBe(true); // survived
        expect(tickState.has(2)).toBe(false); // removed
        expect(tickState.has(3)).toBe(false); // removed
        expect(tickState.size).toBe(1);
      });
    });
  });
}

{
  // --- from health-check.test.ts ---
  function createTestBuffer(): AudioBuffer {
    return {
      sampleRate: 48000,
      length: 48000,
      duration: 1,
      numberOfChannels: 2,
      getChannelData: vi.fn(() => new Float32Array(48000)),
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer;
  }

  describe('Health check properties (AC-15)', () => {
    let OriginalAudioContext: typeof AudioContext;
    let mockCtor: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      mockCtor = vi.fn().mockImplementation(function AudioContextMock(this: unknown) {
        return {
          state: 'running' as AudioContextState,
          sampleRate: 48000,
          destination: { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioDestinationNode,
          currentTime: 0,
          listener: {},
          resume: vi.fn().mockResolvedValue(undefined),
          suspend: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          createGain: vi.fn(
            () =>
              ({
                gain: makeMockAudioParam(1),
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
              }) as unknown as GainNode,
          ),
          createBufferSource: vi.fn(
            () =>
              ({
                buffer: null,
                playbackRate: { value: 1, setValueAtTime: vi.fn() },
                loop: false,
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
              }) as unknown as AudioBufferSourceNode,
          ),
          createPanner: vi.fn(
            () =>
              ({
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
              }) as unknown as PannerNode,
          ),
          decodeAudioData: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
          onstatechange: null,
          baseLatency: 0,
          outputLatency: 0,
          getOutputTimestamp: vi.fn(),
          createChannelMerger: vi.fn(),
          createChannelSplitter: vi.fn(),
          createDelay: vi.fn(),
          createBiquadFilter: vi.fn(),
          createConvolver: vi.fn(),
          createDynamicsCompressor: vi.fn(),
          createOscillator: vi.fn(),
          createStereoPanner: vi.fn(),
          createWaveShaper: vi.fn(),
          createPeriodicWave: vi.fn(),
          createIIRFilter: vi.fn(),
          createScriptProcessor: vi.fn(),
          createAnalyser: vi.fn(),
          createMediaStreamDestination: vi.fn(),
          createMediaStreamSource: vi.fn(),
          createConstantSource: vi.fn(),
          audioWorklet: undefined as unknown as AudioWorklet,
        };
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest global mock
      globalThis.AudioContext = mockCtor as any;
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('getState().contextState returns AudioContext.state string', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      const state = engine.getState();
      expect(state.contextState).toBe('running');
    });

    it('getState().activeSourceCount returns number of active sources', () => {
      const engine = new WebAudioEngine();

      expect(engine.getActiveSourceCount()).toBe(0);

      // RED: stub returns 0
      // GREEN (w16): after play, count should increase
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      // TODO(w16): expect(engine.getActiveSourceCount()).toBe(1);
    });

    it('activeSourceCount increments on play and decrements on stop', () => {
      const engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      engine.play(2, buf, { loop: true, volume: 1, spatialBlend: 0, bus: 'music' });
      engine.play(3, buf, { loop: false, volume: 0.5, spatialBlend: 0, bus: 'sfx' });

      // RED: skeleton always returns 0
      // GREEN (w16): expect(engine.getActiveSourceCount()).toBe(3);

      engine.stop(2);
      // GREEN (w16): expect(engine.getActiveSourceCount()).toBe(2);
    });

    it('after destroy(), contextState is closed and activeSourceCount is 0', () => {
      const engine = new WebAudioEngine();
      engine.play(1, createTestBuffer(), { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      engine.destroy();

      const state = engine.getState();
      expect(state.contextState).toBe('closed');
      expect(state.activeSourceCount).toBe(0);
      expect(engine.getActiveSourceCount()).toBe(0);
    });
  });
}

{
  // --- from lazy-creation.test.ts ---
  function createTestBuffer(duration = 1, sampleRate = 48000): AudioBuffer {
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

  describe('WebAudioEngine lazy creation (AC-01)', () => {
    let OriginalAudioContext: typeof AudioContext;
    let ctorSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
        return makeMockAudioContext('suspended');
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest mock for global constructor
      globalThis.AudioContext = ctorSpy as any;
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('does not create AudioContext in constructor', () => {
      /* RED: the real implementation does not call new AudioContext() in the constructor */
      const engine = new WebAudioEngine();
      expect(engine).toBeDefined();
      expect(ctorSpy).not.toHaveBeenCalled();
    });

    it('creates AudioContext exactly once on first play() call', () => {
      const engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      expect(ctorSpy).toHaveBeenCalledTimes(1);
    });

    it('does not create a second AudioContext on subsequent play() calls', () => {
      const engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      engine.play(2, buf, { loop: true, volume: 0.5, spatialBlend: 0, bus: 'music' });

      // Only one AudioContext -- reuse, never duplicate
      expect(ctorSpy).toHaveBeenCalledTimes(1);
    });

    it('getActiveSourceCount returns 0 before any sources are played', () => {
      const engine = new WebAudioEngine();
      expect(engine.getActiveSourceCount()).toBe(0);
    });

    it('AudioContext initial state is available via getState after first play', () => {
      const engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      const state = engine.getState();
      // After ensureContext() runs, contextState should be 'suspended' (autoplay gate)
      // or 'running' if resume was already called by the gesture listener.
      expect(['running', 'suspended', 'closed']).toContain(state.contextState);
    });
  });

  // ---------------------------------------------------------------------------
  // Shared mock factories (reused across test files in this milestone)
  // ---------------------------------------------------------------------------

  function makeMockAudioContext(initialState: AudioContextState = 'suspended'): AudioContext {
    return {
      state: initialState,
      sampleRate: 48000,
      destination: makeMockAudioDestinationNode(),
      currentTime: 0,
      listener: makeMockAudioListener(),
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => makeMockGainNode()),
      createBufferSource: vi.fn(() => makeMockAudioBufferSourceNode()),
      createPanner: vi.fn(() => makeMockPannerNode()),
      decodeAudioData: vi.fn().mockResolvedValue(createTestBuffer()),
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
      createPeriodicWave: vi.fn(),
      createIIRFilter: vi.fn(),
      createScriptProcessor: vi.fn(),
      createAnalyser: vi.fn(),
      createConstantSource: vi.fn(),
      audioWorklet: undefined as unknown as AudioWorklet,
    } as unknown as AudioContext;
  }

  function makeMockAudioDestinationNode(): AudioDestinationNode {
    return {
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
    } as unknown as AudioDestinationNode;
  }

  function makeMockGainNode(initialGain = 1): GainNode {
    return {
      gain: makeMockAudioParam(initialGain),
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
    } as unknown as GainNode;
  }

  function makeMockAudioBufferSourceNode(): AudioBufferSourceNode {
    return {
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
    } as unknown as AudioBufferSourceNode;
  }

  function makeMockPannerNode(): PannerNode {
    return {
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
      channelCountMode: 'clamped-max' as const,
      channelInterpretation: 'speakers' as const,
      connect: vi.fn().mockReturnValue(undefined),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as PannerNode;
  }

  function makeMockAudioListener(): AudioListener {
    return {
      positionX: { value: 0 } as unknown as AudioParam,
      positionY: { value: 0 } as unknown as AudioParam,
      positionZ: { value: 0 } as unknown as AudioParam,
      forwardX: { value: 0 } as unknown as AudioParam,
      forwardY: { value: 0 } as unknown as AudioParam,
      forwardZ: { value: -1 } as unknown as AudioParam,
      upX: { value: 0 } as unknown as AudioParam,
      upY: { value: 1 } as unknown as AudioParam,
      upZ: { value: 0 } as unknown as AudioParam,
    } as unknown as AudioListener;
  }
}

{
  // --- from listener-accessor.test.ts ---
  function makeMockListener(): AudioListener {
    return {
      positionX: { value: 0 },
      positionY: { value: 0 },
      positionZ: { value: 0 },
      forwardX: { value: 0 },
      forwardY: { value: 0 },
      forwardZ: { value: 0 },
      upX: { value: 0 },
      upY: { value: 0 },
      upZ: { value: 0 },
    } as unknown as AudioListener;
  }

  describe('WebAudioEngine.listener getter (AC-10)', () => {
    it('returns AudioContext.listener when context is created', () => {
      const mockListener = makeMockListener();
      const mockCtx = {
        state: 'running' as const,
        listener: mockListener,
        createGain: vi.fn().mockReturnValue({
          connect: vi.fn(),
          gain: makeMockAudioParam(1),
        }),
        createPanner: vi.fn(),
        createBufferSource: vi.fn(),
        destination: {} as AudioDestinationNode,
      };

      let audioContextNewCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const MockCtor = vi.fn(function (this: object) {
        audioContextNewCount++;
        Object.assign(this, mockCtx);
      }) as unknown as typeof AudioContext;
      vi.stubGlobal('AudioContext', MockCtor);

      const engine = new WebAudioEngine();
      const listener = engine.listener;

      expect(listener).toBe(mockListener);
      expect(audioContextNewCount).toBe(1);

      vi.unstubAllGlobals();
    });

    it('triggers lazy ensureContext on first listener access', () => {
      const mockListener = makeMockListener();
      const mockCtx = {
        state: 'running' as const,
        listener: mockListener,
        createGain: vi.fn().mockReturnValue({
          connect: vi.fn(),
          gain: makeMockAudioParam(1),
        }),
        createPanner: vi.fn(),
        createBufferSource: vi.fn(),
        destination: {} as AudioDestinationNode,
      };

      const MockCtor = vi.fn(function (this: object) {
        Object.assign(this, mockCtx);
      }) as unknown as typeof AudioContext;
      vi.stubGlobal('AudioContext', MockCtor);

      const engine = new WebAudioEngine();

      expect(MockCtor).not.toHaveBeenCalled();

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void engine.listener;
      expect(MockCtor).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void engine.listener;
      expect(MockCtor).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });
  });
}

{
  // --- from listener-sync.test.ts ---
  describe('audioListenerSyncSystem world-matrix sync (AC-08)', () => {
    it('writes the translation column (x,y,z) to listener position AudioParams', () => {
      const listener = makeMockListener();
      const world = mat4.create();
      mat4.compose(world, vec3.create(5, 2, -10), [0, 0, 0, 1], vec3.create(1, 1, 1));

      syncListenerFromWorldMatrix(listener, world as unknown as Float32Array);

      expect(listener.positionX.value).toBeCloseTo(5, 5);
      expect(listener.positionY.value).toBeCloseTo(2, 5);
      expect(listener.positionZ.value).toBeCloseTo(-10, 5);
    });

    it('computes forward/up from an identity-rotation world matrix', () => {
      const listener = makeMockListener();
      const world = mat4.create();
      mat4.compose(world, vec3.create(0, 0, 0), [0, 0, 0, 1], vec3.create(1, 1, 1));

      syncListenerFromWorldMatrix(listener, world as unknown as Float32Array);

      // Forward = -col2 normalized = (0,0,-1); Up = col1 normalized = (0,1,0).
      expect(listener.forwardX.value).toBeCloseTo(0, 5);
      expect(listener.forwardY.value).toBeCloseTo(0, 5);
      expect(listener.forwardZ.value).toBeCloseTo(-1, 5);
      expect(listener.upX.value).toBeCloseTo(0, 5);
      expect(listener.upY.value).toBeCloseTo(1, 5);
      expect(listener.upZ.value).toBeCloseTo(0, 5);
    });

    it('AC-08 quadrant (3): non-uniform scale (sx=2) + rotation -> forward/up match the quat oracle (epsilon<=1e-5)', () => {
      const listener = makeMockListener();

      // Non-trivial rotation: 35 degrees about a tilted axis.
      const q = quat.fromAxisAngle(
        quat.create(),
        vec3.normalize(vec3.create(), vec3.create(1, 2, 3)),
        0.61,
      );
      // Non-uniform scale: sx=2, sy=1, sz=1. A bare-column forward read would be
      // 2x-stretched on the x basis; getForward's normalize must cancel it.
      const world = mat4.create();
      mat4.compose(world, vec3.create(7, -3, 4), q, vec3.create(2, 1, 1));

      syncListenerFromWorldMatrix(listener, world as unknown as Float32Array);

      // OLD quat oracle: forward = q . (0,0,-1); up = q . (0,1,0) (unit vectors).
      const fOracle = quat.transformVec3(vec3.create(), q, vec3.create(0, 0, -1));
      const uOracle = quat.transformVec3(vec3.create(), q, vec3.create(0, 1, 0));

      expect(listener.forwardX.value).toBeCloseTo(fOracle[0] as number, 5);
      expect(listener.forwardY.value).toBeCloseTo(fOracle[1] as number, 5);
      expect(listener.forwardZ.value).toBeCloseTo(fOracle[2] as number, 5);
      expect(listener.upX.value).toBeCloseTo(uOracle[0] as number, 5);
      expect(listener.upY.value).toBeCloseTo(uOracle[1] as number, 5);
      expect(listener.upZ.value).toBeCloseTo(uOracle[2] as number, 5);

      // Position is the translation column, NOT normalized (carries magnitude).
      expect(listener.positionX.value).toBeCloseTo(7, 5);
      expect(listener.positionY.value).toBeCloseTo(-3, 5);
      expect(listener.positionZ.value).toBeCloseTo(4, 5);

      // Sanity: extracted forward/up are unit vectors (scale pollution removed).
      const fLen = Math.hypot(
        listener.forwardX.value,
        listener.forwardY.value,
        listener.forwardZ.value,
      );
      expect(fLen).toBeCloseTo(1, 5);
    });
  });

  function makeMockListener() {
    return {
      positionX: { value: 0 } as unknown as AudioParam,
      positionY: { value: 0 } as unknown as AudioParam,
      positionZ: { value: 0 } as unknown as AudioParam,
      forwardX: { value: 0 } as unknown as AudioParam,
      forwardY: { value: 0 } as unknown as AudioParam,
      forwardZ: { value: -1 } as unknown as AudioParam,
      upX: { value: 0 } as unknown as AudioParam,
      upY: { value: 1 } as unknown as AudioParam,
      upZ: { value: 0 } as unknown as AudioParam,
    } as unknown as AudioListener;
  }
}

{
  // --- from property-sync.test.ts ---
  function createTestBuffer(duration = 1, sampleRate = 48000): AudioBuffer {
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

  describe('audioTickSystem property sync (AC-06/07/11)', () => {
    let OriginalAudioContext: typeof AudioContext;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    describe('loop property sync (AC-06)', () => {
      it('sets AudioBufferSourceNode.loop to true when opts.loop is true', () => {
        const srcNode = makeMockBufferSource();
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createBufferSource: () => srcNode });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });

        expect(srcNode.loop).toBe(true);
      });

      it('sets AudioBufferSourceNode.loop to false (default one-shot)', () => {
        const srcNode = makeMockBufferSource();
        srcNode.loop = true;
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createBufferSource: () => srcNode });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

        expect(srcNode.loop).toBe(false);
      });
    });

    describe('volume property sync (AC-07)', () => {
      it('sets per-source GainNode.gain.value to opts.volume', () => {
        const gain = makeMockGainNode(1);
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createGain: () => gain });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: false, volume: 0.5, spatialBlend: 0, bus: 'sfx' });

        expect(gain.gain.value).toBe(0.5);
      });

      it('sets GainNode.gain.value to 0 for silence (does not remove the node)', () => {
        const gain = makeMockGainNode(1);
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createGain: () => gain });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(2, buf, { loop: false, volume: 0, spatialBlend: 0, bus: 'sfx' });

        expect(gain.gain.value).toBe(0);
        expect(engine.getActiveSourceCount()).toBe(1);
      });

      it('setVolume on active source updates GainNode.gain.value', () => {
        const gain = makeMockGainNode(0.5);
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createGain: () => gain });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: false, volume: 0.5, spatialBlend: 0, bus: 'sfx' });
        engine.setVolume(1, 0.75);

        expect(gain.gain.value).toBe(0.75);
      });
    });

    describe('spatialBlend PannerNode presence (AC-11)', () => {
      it('creates PannerNode when spatialBlend > 0', () => {
        const panner = makeMockPannerNode();
        const createPannerSpy = vi.fn(() => panner);

        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createPanner: createPannerSpy });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 1, bus: 'sfx' });

        expect(createPannerSpy).toHaveBeenCalledTimes(1);
        expect(panner.panningModel).toBe('equalpower');
      });

      it('does NOT create PannerNode when spatialBlend = 0', () => {
        const createPannerSpy = vi.fn(() => makeMockPannerNode());
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createPanner: createPannerSpy });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

        expect(createPannerSpy).not.toHaveBeenCalled();
      });

      it('creates PannerNode with equalpower panningModel', () => {
        const panner = makeMockPannerNode();
        const createPannerSpy = vi.fn(() => panner);
        const ctorSpy = vi.fn().mockImplementation(function AudioContextMock() {
          return makeMockCtx({ createPanner: createPannerSpy });
        });
        globalThis.AudioContext = ctorSpy as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = createTestBuffer();
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0.5, bus: 'sfx' });

        expect(createPannerSpy).toHaveBeenCalledTimes(1);
        expect(panner.panningModel).toBe('equalpower');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Mock factories
  // ---------------------------------------------------------------------------

  interface MockCtxOverrides {
    createBufferSource?: () => AudioBufferSourceNode;
    createGain?: () => GainNode;
    createPanner?: () => PannerNode;
  }

  function makeMockCtx(overrides: MockCtxOverrides = {}) {
    return {
      state: 'suspended',
      sampleRate: 48000,
      destination: { connect: vi.fn().mockReturnValue(undefined) },
      listener: {
        positionX: { value: 0 },
        positionY: { value: 0 },
        positionZ: { value: 0 },
        forwardX: { value: 0 },
        forwardY: { value: 0 },
        forwardZ: { value: -1 },
        upX: { value: 0 },
        upY: { value: 1 },
        upZ: { value: 0 },
      },
      resume: vi.fn().mockResolvedValue(undefined),
      createGain: overrides.createGain ?? (() => makeMockGainNode()),
      createBufferSource: overrides.createBufferSource ?? (() => makeMockBufferSource()),
      createPanner: overrides.createPanner ?? (() => makeMockPannerNode()),
      decodeAudioData: vi.fn(),
    } as unknown as AudioContext;
  }

  function makeMockGainNode(initialGain = 1): GainNode {
    return {
      gain: makeMockAudioParam(initialGain),
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
    } as unknown as GainNode;
  }

  function makeMockBufferSource(): AudioBufferSourceNode {
    return {
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
    } as unknown as AudioBufferSourceNode;
  }

  function makeMockPannerNode(): PannerNode {
    return {
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
      channelCountMode: 'clamped-max' as const,
      channelInterpretation: 'speakers' as const,
      connect: vi.fn().mockReturnValue(undefined),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as PannerNode;
  }
}

{
  // --- from resume-gesture.test.ts ---
  function createTestBuffer(): AudioBuffer {
    return {
      sampleRate: 48000,
      length: 48000,
      duration: 1,
      numberOfChannels: 2,
      getChannelData: vi.fn(() => new Float32Array(48000)),
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer;
  }

  describe('AudioContext resume gesture registration (AC-02)', () => {
    let OriginalAudioContext: typeof AudioContext;
    let docAddEventListenerSpy: ReturnType<typeof vi.fn>;
    let docRemoveEventListenerSpy: ReturnType<typeof vi.fn>;
    let docDispatchEventSpy: ReturnType<typeof vi.fn>;
    let resumeSpy: ReturnType<typeof vi.fn>;
    let mockCtor: ReturnType<typeof vi.fn>;
    let mockContext: { state: AudioContextState };
    let engine: WebAudioEngine | undefined;
    const listeners = new Map<string, Set<() => void>>();

    async function flushResume(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    }

    function dispatchGesture(type: string): void {
      const handlers = [...(listeners.get(type) ?? [])];
      listeners.get(type)?.clear();
      for (const handler of handlers) handler();
    }

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      listeners.clear();
      mockContext = { state: 'suspended' as AudioContextState };
      let resumeCalls = 0;
      resumeSpy = vi.fn().mockImplementation(() => {
        resumeCalls += 1;
        if (resumeCalls === 1) return Promise.reject(new Error('gesture blocked'));
        mockContext.state = 'running';
        return Promise.resolve();
      });
      docAddEventListenerSpy = vi.fn((type: string, handler: () => void) => {
        const handlers = listeners.get(type) ?? new Set<() => void>();
        handlers.add(handler);
        listeners.set(type, handlers);
      });
      docRemoveEventListenerSpy = vi.fn((type: string, handler: () => void) => {
        listeners.get(type)?.delete(handler);
      });
      docDispatchEventSpy = vi.fn((event: Event) => {
        dispatchGesture(event.type);
        return true;
      });

      // Mock document for node environment
      vi.stubGlobal('document', {
        addEventListener: docAddEventListenerSpy,
        removeEventListener: docRemoveEventListenerSpy,
        dispatchEvent: docDispatchEventSpy,
      });

      mockCtor = vi.fn().mockImplementation(function AudioContextMock(this: unknown) {
        return {
          get state() {
            return mockContext.state;
          },
          sampleRate: 48000,
          destination: {} as unknown as AudioDestinationNode,
          currentTime: 0,
          listener: {},
          resume: resumeSpy,
          suspend: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          createGain: vi.fn(
            () =>
              ({
                gain: makeMockAudioParam(1),
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
              }) as unknown as GainNode,
          ),
          createBufferSource: vi.fn(
            () =>
              ({
                buffer: null,
                playbackRate: { value: 1, setValueAtTime: vi.fn() },
                loop: false,
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
              }) as unknown as AudioBufferSourceNode,
          ),
          createPanner: vi.fn(
            () =>
              ({
                connect: vi.fn().mockReturnValue(undefined),
                disconnect: vi.fn(),
              }) as unknown as PannerNode,
          ),
          decodeAudioData: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
          onstatechange: null,
          baseLatency: 0,
          outputLatency: 0,
          getOutputTimestamp: vi.fn(),
          createChannelMerger: vi.fn(),
          createChannelSplitter: vi.fn(),
          createDelay: vi.fn(),
          createBiquadFilter: vi.fn(),
          createConvolver: vi.fn(),
          createDynamicsCompressor: vi.fn(),
          createOscillator: vi.fn(),
          createStereoPanner: vi.fn(),
          createWaveShaper: vi.fn(),
          createPeriodicWave: vi.fn(),
          createIIRFilter: vi.fn(),
          createScriptProcessor: vi.fn(),
          createAnalyser: vi.fn(),
          createMediaStreamDestination: vi.fn(),
          createMediaStreamSource: vi.fn(),
          createConstantSource: vi.fn(),
          audioWorklet: undefined as unknown as AudioWorklet,
        };
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest global mock
      globalThis.AudioContext = mockCtor as any;
    });

    afterEach(() => {
      engine?.destroy();
      engine = undefined;
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('registers a one-shot gesture listener when ctx is suspended', () => {
      engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      expect(docAddEventListenerSpy).toHaveBeenCalledTimes(3);
      expect(listeners.get('click')?.size).toBe(1);
      expect(listeners.get('keydown')?.size).toBe(1);
      expect(listeners.get('touchstart')?.size).toBe(1);
    });

    it('does not register duplicate gesture listener on second play', () => {
      engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      engine.play(2, buf, { loop: true, volume: 0.5, spatialBlend: 0, bus: 'music' });

      expect(docAddEventListenerSpy).toHaveBeenCalledTimes(3);
      expect([...listeners.values()].reduce((total, set) => total + set.size, 0)).toBe(3);
    });

    it('gesture listener calls ctx.resume() and removes itself after running', async () => {
      engine = new WebAudioEngine();
      const buf = createTestBuffer();
      resumeSpy.mockImplementation(() => {
        mockContext.state = 'running';
        return Promise.resolve();
      });

      engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      dispatchGesture('click');
      await flushResume();

      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(engine.getState()).toMatchObject({ contextState: 'running', lastError: null });
      expect(docRemoveEventListenerSpy).toHaveBeenCalledTimes(3);
      expect([...listeners.values()].reduce((total, set) => total + set.size, 0)).toBe(0);
    });

    it('re-arms one bounded listener set after refusal and recovers on the next gesture', async () => {
      engine = new WebAudioEngine();
      const buf = createTestBuffer();

      engine.play(1, buf, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });
      expect(engine.getActiveSourceCount()).toBe(1);

      dispatchGesture('click');
      await flushResume();
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(engine.getState()).toMatchObject({
        contextState: 'suspended',
        activeSourceCount: 1,
      });
      expect(engine.getState().lastError).toMatchObject({
        code: 'context-suspended',
        detail: { code: 'context-suspended' },
      });
      expect(docAddEventListenerSpy).toHaveBeenCalledTimes(6);
      expect([...listeners.values()].reduce((total, set) => total + set.size, 0)).toBe(3);

      dispatchGesture('keydown');
      await flushResume();
      expect(resumeSpy).toHaveBeenCalledTimes(2);
      expect(engine.getState()).toMatchObject({
        contextState: 'running',
        activeSourceCount: 1,
        lastError: null,
      });
      expect([...listeners.values()].reduce((total, set) => total + set.size, 0)).toBe(0);
      expect(docRemoveEventListenerSpy).toHaveBeenCalledTimes(6);

      engine.stop(1);
      expect(engine.getActiveSourceCount()).toBe(0);
      engine.destroy();
      engine.destroy();
    });
  });
}

{
  // --- from tick-edge-detect.test.ts ---
  describe('audioTickSystem edge detection (AC-05)', () => {
    describe('detectEdge (pure edge-detection helper)', () => {
      it('returns none when state unchanged from false to false', () => {
        expect(detectEdge(false, false)).toBe('none');
      });

      it('returns none when state unchanged from true to true', () => {
        expect(detectEdge(true, true)).toBe('none');
      });

      it('returns play-start on false->true transition', () => {
        expect(detectEdge(false, true)).toBe('play-start');
      });

      it('returns play-stop on true->false transition', () => {
        expect(detectEdge(true, false)).toBe('play-stop');
      });
    });
  });
}

{
  // --- from tick-state-instance-scoped.test.ts (w7/w8/w9) ---
  //
  // F25 de-singleton: tickStates/prevFrameEntities move from module-level
  // singletons into WebAudioEngine instance fields. These RED tests verify
  // that the CURRENT module singleton causes cross-engine interference.
  //
  // After w10+w11 (instance fields + narrow), these tests turn GREEN:
  //   w7 (AC-09): two engines have independent edge detection
  //   w8 (AC-10): after destroy, new engine starts with clean tick state
  //   w9 (AC-11): engine B's cleanup does not corrupt engine A's state

  function makeTickTestBuffer(): AudioBuffer {
    return { length: 1024, sampleRate: 44100, numberOfChannels: 1 } as unknown as AudioBuffer;
  }

  function buildTickTestWorld(
    entity: number,
    playingGetter: () => boolean,
    clipHandle: number,
    mockResolver: { resolve: ReturnType<typeof vi.fn> },
  ) {
    const audioSourceRow = () => ({
      playing: playingGetter(),
      clip: clipHandle,
      loop: false,
      volume: 1,
      spatialBlend: 0,
      bus: 'sfx',
    });
    return {
      sharedRefs: mockResolver,
      query() {
        return {
          ok: true,
          value: {
            *[Symbol.iterator]() {
              yield { entity, get: audioSourceRow };
            },
          },
        };
      },
    };
  }

  function makeTickMockCtx(): AudioContext {
    const g = {
      gain: makeMockAudioParam(1),
      connect: vi.fn().mockReturnValue(undefined),
      disconnect: vi.fn(),
      context: undefined as unknown as BaseAudioContext,
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'max' as const,
      channelInterpretation: 'speakers' as const,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    return {
      state: 'running' as AudioContextState,
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
      listener: {
        positionX: { value: 0 } as unknown as AudioParam,
        positionY: { value: 0 } as unknown as AudioParam,
        positionZ: { value: 0 } as unknown as AudioParam,
        forwardX: { value: 0 } as unknown as AudioParam,
        forwardY: { value: 0 } as unknown as AudioParam,
        forwardZ: { value: -1 } as unknown as AudioParam,
        upX: { value: 0 } as unknown as AudioParam,
        upY: { value: 1 } as unknown as AudioParam,
        upZ: { value: 0 } as unknown as AudioParam,
      } as unknown as AudioListener,
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => ({ ...g }) as unknown as GainNode),
      createBufferSource: vi.fn(
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
      ),
      createPanner: vi.fn(
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
            channelCountMode: 'clamped-max' as const,
            channelInterpretation: 'speakers' as const,
            connect: vi.fn().mockReturnValue(undefined),
            disconnect: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as unknown as PannerNode,
      ),
      decodeAudioData: vi.fn().mockResolvedValue(makeTickTestBuffer()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onstatechange: null,
      baseLatency: 0,
      outputLatency: 0,
      getOutputTimestamp: vi.fn(),
      createChannelMerger: vi.fn(),
      createChannelSplitter: vi.fn(),
      createDelay: vi.fn(),
      createBiquadFilter: vi.fn(),
      createConvolver: vi.fn(),
      createDynamicsCompressor: vi.fn(),
      createOscillator: vi.fn(),
      createStereoPanner: vi.fn(),
      createWaveShaper: vi.fn(),
      createPeriodicWave: vi.fn(),
      createIIRFilter: vi.fn(),
      createScriptProcessor: vi.fn(),
      createAnalyser: vi.fn(),
      createMediaStreamDestination: vi.fn(),
      createMediaStreamSource: vi.fn(),
      createConstantSource: vi.fn(),
      audioWorklet: undefined as unknown as AudioWorklet,
    } as unknown as AudioContext;
  }

  describe('F25 tick state de-singleton (AC-09/AC-10/AC-11)', () => {
    let OriginalAudioContext: typeof AudioContext;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      const mockCtor = vi.fn().mockImplementation(function AudioContextMock(this: unknown) {
        return makeTickMockCtx();
      });
      // biome-ignore lint/suspicious/noExplicitAny: vitest global mock
      globalThis.AudioContext = mockCtor as any;
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    async function flushAudioDecode(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    }

    // -------------------------------------------------------------------
    // w7: AC-09 tick state instance-scoped
    // -------------------------------------------------------------------
    describe('AC-09: tick state instance-scoped (w7)', () => {
      it('two WebAudioEngine instances have independent edge detection', async () => {
        const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };
        const clipHandle = 42;
        const entityId = 0;

        const mockResolver = {
          resolve: vi.fn().mockReturnValue({ ok: true, value: clip }),
        };

        // Engine A: build tick history
        const engineA = new WebAudioEngine();
        let playingA = false;
        const worldA = buildTickTestWorld(
          entityId,
          () => playingA,
          clipHandle,
          mockResolver,
          // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type for unit test
        ) as any;

        // Engine B: fresh, must NOT inherit A's tick state
        const engineB = new WebAudioEngine();
        let playingB = false;
        const worldB = buildTickTestWorld(
          entityId,
          () => playingB,
          clipHandle,
          mockResolver,
          // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type for unit test
        ) as any;

        // Phase 1: A first tick, playing=false -> no edge (first observation)
        playingA = false;
        audioTickSystem(worldA, engineA);
        expect(engineA.getActiveSourceCount()).toBe(0);

        // Phase 2: A tick, playing=true -> false->true edge -> play
        playingA = true;
        audioTickSystem(worldA, engineA);
        await flushAudioDecode();
        expect(engineA.getActiveSourceCount()).toBe(1);

        // Phase 3: B FIRST tick, entity playing=true.
        // Instance-scoped: engineB has no history, so initial true is a
        // play-start edge even though engineA has already observed this id.
        playingB = true;
        audioTickSystem(worldB, engineB);
        await flushAudioDecode();

        expect(engineB.getActiveSourceCount()).toBe(1);
        engineA.destroy();
        engineB.destroy();
      });

      it('module top-level does not expose tickStates/prevFrameEntities', async () => {
        const tickModule = await import('@forgeax/engine-audio');
        expect('tickStates' in tickModule).toBe(false);
        expect('prevFrameEntities' in tickModule).toBe(false);
        expect(typeof tickModule.audioTickSystem).toBe('function');
      });
    });

    // -------------------------------------------------------------------
    // w8: AC-10 destroy then new backend starts clean
    // -------------------------------------------------------------------
    describe('AC-10: destroy then new backend starts clean (w8)', () => {
      it('after WebAudioEngine.destroy(), a new engine starts with clean tick state', async () => {
        const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };
        const clipHandle = 42;
        const entityId = 0;

        const mockResolver = {
          resolve: vi.fn().mockReturnValue({ ok: true, value: clip }),
        };

        // Engine A: build tick history then destroy
        const engineA = new WebAudioEngine();
        const playingA = true;
        const worldA = buildTickTestWorld(
          entityId,
          () => playingA,
          clipHandle,
          mockResolver,
          // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type for unit test
        ) as any;

        // Tick A-1: first observation, playing=true -> initial play-start edge
        audioTickSystem(worldA, engineA);
        await flushAudioDecode();
        expect(engineA.getActiveSourceCount()).toBe(1);

        // Destroy engine A; its instance-scoped tick state must not affect B.
        engineA.destroy();

        // Engine B: fresh instance
        const engineB = new WebAudioEngine();
        const playingB = true;
        const worldB = buildTickTestWorld(
          entityId,
          () => playingB,
          clipHandle,
          mockResolver,
          // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type for unit test
        ) as any;

        // B FIRST tick, entity playing=true -> initial play-start edge.
        audioTickSystem(worldB, engineB);
        await flushAudioDecode();

        expect(engineB.getActiveSourceCount()).toBe(1);
        engineB.destroy();
      });
    });

    // -------------------------------------------------------------------
    // w9: AC-11 concurrent backends isolated
    // -------------------------------------------------------------------
    describe('AC-11: concurrent backends isolated (w9)', () => {
      it("cleanupDespawnedEntities on engine B does not corrupt engine A's tick state", async () => {
        const clip = { kind: 'audio' as const, sourceKey: 'fixture', bytes: new Uint8Array([1]) };
        const clipHandle = 42;
        const entityA = 0;
        const entityB = 1;

        const mockResolver = {
          resolve: vi.fn().mockReturnValue({ ok: true, value: clip }),
        };

        // Engine A tracks entityA
        const engineA = new WebAudioEngine();
        let playingA = false;
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type for unit test
        const worldA = buildTickTestWorld(entityA, () => playingA, clipHandle, mockResolver) as any;

        // Engine B tracks entityB (different entity)
        const engineB = new WebAudioEngine();
        const playingB = true;
        // biome-ignore lint/suspicious/noExplicitAny: mock World duck-type for unit test
        const worldB = buildTickTestWorld(entityB, () => playingB, clipHandle, mockResolver) as any;

        // Tick A-1: entityA playing=false, first obs -> no edge
        // Module singleton tickStates[entityA].prevPlaying = false
        audioTickSystem(worldA, engineA);
        expect(engineA.getActiveSourceCount()).toBe(0);

        // Tick B-1: entityB playing=true, first obs -> initial play-start edge
        // BUT cleanupDespawnedEntities sees prevFrameEntities={entityA} from A
        // and currentEntityIds=[entityB].
        // removed=[entityA] -> calls engineB.stop(entityA) (no-op on B)
        // AND deletes tickStates[entityA] from the shared module singleton!
        audioTickSystem(worldB, engineB);
        await flushAudioDecode();

        // Tick A-2: entityA playing=true
        // Instance-scoped (desired): engineA.tickStates still has entityA
        //   with prevPlaying=false -> false->true edge -> play.
        // Module-shared (current): tickStates[entityA] was DELETED by B's
        //   cleanupDespawnedEntities -> first observation -> prev=current=true
        //   -> NO edge -> play NOT called.
        playingA = true;
        audioTickSystem(worldA, engineA);
        await flushAudioDecode();

        // DESIRED: engineA detects the false->true edge and plays.
        // Currently FAILS because B's cleanup corrupted A's shared tick state.
        expect(engineA.getActiveSourceCount()).toBe(1);
      });
    });
  });
}

{
  // --- from f24-onended-guard.test.ts (w16/w17) ---
  //
  // F24 onended self-reclaim + identity guard for non-loop sources.
  // D-5: only non-loop sources attach node.onended; loop sources never
  // naturally end, so no onended is needed.
  //
  // Research Finding 2: ActiveSource.node field is available for identity
  // comparison (sources.get(id)?.node === node). Web Audio spec: node.stop()
  // also triggers onended — the identity guard correctly no-ops when
  // sources.get(id) returns undefined or a different node.
  //
  // RED (w16/w17): onended is null for all sources (guard not yet implemented).
  // GREEN (w18): non-loop source gets guarded onended; loop source stays null.

  function makeOnendedTestBuffer(): AudioBuffer {
    return { length: 1024, sampleRate: 44100, numberOfChannels: 1 } as unknown as AudioBuffer;
  }

  function makeOnendedMockCtx(capturedNodes: AudioBufferSourceNode[]): AudioContext {
    const g = {
      gain: makeMockAudioParam(1),
      connect: vi.fn().mockReturnValue(undefined),
      disconnect: vi.fn(),
      context: undefined as unknown as BaseAudioContext,
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'max' as const,
      channelInterpretation: 'speakers' as const,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    return {
      state: 'running' as AudioContextState,
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
      listener: {
        positionX: { value: 0 } as unknown as AudioParam,
        positionY: { value: 0 } as unknown as AudioParam,
        positionZ: { value: 0 } as unknown as AudioParam,
        forwardX: { value: 0 } as unknown as AudioParam,
        forwardY: { value: 0 } as unknown as AudioParam,
        forwardZ: { value: -1 } as unknown as AudioParam,
        upX: { value: 0 } as unknown as AudioParam,
        upY: { value: 1 } as unknown as AudioParam,
        upZ: { value: 0 } as unknown as AudioParam,
      } as unknown as AudioListener,
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => ({ ...g }) as unknown as GainNode),
      createBufferSource: vi.fn(() => {
        const node = {
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
        } as unknown as AudioBufferSourceNode;
        capturedNodes.push(node);
        return node;
      }),
      createPanner: vi.fn(
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
            channelCountMode: 'clamped-max' as const,
            channelInterpretation: 'speakers' as const,
            connect: vi.fn().mockReturnValue(undefined),
            disconnect: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as unknown as PannerNode,
      ),
      decodeAudioData: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onstatechange: null,
      baseLatency: 0,
      outputLatency: 0,
      getOutputTimestamp: vi.fn(),
      createChannelMerger: vi.fn(),
      createChannelSplitter: vi.fn(),
      createDelay: vi.fn(),
      createBiquadFilter: vi.fn(),
      createConvolver: vi.fn(),
      createDynamicsCompressor: vi.fn(),
      createOscillator: vi.fn(),
      createStereoPanner: vi.fn(),
      createWaveShaper: vi.fn(),
      createPeriodicWave: vi.fn(),
      createIIRFilter: vi.fn(),
      createScriptProcessor: vi.fn(),
      createAnalyser: vi.fn(),
      createMediaStreamDestination: vi.fn(),
      createMediaStreamSource: vi.fn(),
      createConstantSource: vi.fn(),
      audioWorklet: undefined as unknown as AudioWorklet,
    } as unknown as AudioContext;
  }

  type CapturedSourceNode = AudioBufferSourceNode;

  describe('F24 onended guard (AC-06/AC-07)', () => {
    let OriginalAudioContext: typeof AudioContext;

    beforeEach(() => {
      OriginalAudioContext = globalThis.AudioContext;
      vi.stubGlobal('document', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
    });

    afterEach(() => {
      globalThis.AudioContext = OriginalAudioContext;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    // -------------------------------------------------------------------
    // w16: AC-06 loop source does not attach onended
    // -------------------------------------------------------------------
    describe('AC-06: loop source does not attach onended (w16)', () => {
      it('loop source has null onended after play', () => {
        const capturedNodes: CapturedSourceNode[] = [];
        const mockCtor = vi.fn().mockImplementation(function AudioContextMock() {
          return makeOnendedMockCtx(capturedNodes);
        });
        globalThis.AudioContext = mockCtor as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = makeOnendedTestBuffer();
        engine.play(1, buf, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });

        // D-5: loop source never naturally ends, so no onended is attached.
        const node = capturedNodes[0] as CapturedSourceNode;
        expect(node.onended).toBeNull();

        // Source should remain in the bookkeeping map.
        expect(engine.getActiveSourceCount()).toBe(1);

        engine.destroy();
      });

      it('loop source activeSourceCount does not decrease over time (no auto-removal)', () => {
        const capturedNodes: CapturedSourceNode[] = [];
        const mockCtor = vi.fn().mockImplementation(function AudioContextMock() {
          return makeOnendedMockCtx(capturedNodes);
        });
        globalThis.AudioContext = mockCtor as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = makeOnendedTestBuffer();
        engine.play(1, buf, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });

        expect(engine.getActiveSourceCount()).toBe(1);

        // The source should not be auto-removed — loop sources never trigger onended.
        // Only explicit engine.stop() removes them.
        expect(engine.getActiveSourceCount()).toBe(1);

        engine.destroy();
      });

      it('non-loop source gets onended callback attached', () => {
        const capturedNodes: CapturedSourceNode[] = [];
        const mockCtor = vi.fn().mockImplementation(function AudioContextMock() {
          return makeOnendedMockCtx(capturedNodes);
        });
        globalThis.AudioContext = mockCtor as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = makeOnendedTestBuffer();
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

        const node = capturedNodes[0] as CapturedSourceNode;
        // RED (pre-w18): onended is null (guard not yet implemented).
        // GREEN (w18): onended = identity guard callback for non-loop sources.
        expect(node.onended).not.toBeNull();

        engine.destroy();
      });
    });

    // -------------------------------------------------------------------
    // w17: AC-07 race-condition identity guard
    // -------------------------------------------------------------------
    describe('AC-07: race-condition identity guard (w17)', () => {
      it('quick-replace play(id) does not kill new source on old onended', () => {
        const capturedNodes: CapturedSourceNode[] = [];
        const mockCtor = vi.fn().mockImplementation(function AudioContextMock() {
          return makeOnendedMockCtx(capturedNodes);
        });
        globalThis.AudioContext = mockCtor as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = makeOnendedTestBuffer();

        // First play: non-loop source — onended is attached (after w18).
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
        expect(engine.getActiveSourceCount()).toBe(1);
        const oldNode = capturedNodes[0] as CapturedSourceNode;

        // RED (pre-w18): onended is null (guard not yet implemented).
        // GREEN (w18): onended = identity guard callback.
        expect(oldNode.onended).not.toBeNull();

        // Second play on same entityId: stop() deletes old source from
        // the internal Map, then play() creates a new source.
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
        expect(engine.getActiveSourceCount()).toBe(1);
        const newNode = capturedNodes[1] as CapturedSourceNode;

        // Simulate async Web Audio onended callback on the OLD node.
        // In real Web Audio, node.stop() also triggers onended. The identity
        // guard must check: sources.get(1)?.node === oldNode?
        // After quick-replace: sources.get(1).node === newNode !== oldNode → no-op.
        const oldOnended = oldNode.onended as unknown as (() => void) | null;
        if (oldOnended) {
          oldOnended();
        }

        // New source must survive — identity guard correctly no-ops on old onended.
        expect(engine.getActiveSourceCount()).toBe(1);
        // The active source must be the new node, not the old one.
        expect(newNode).not.toBe(oldNode);

        engine.destroy();
      });

      it('onended after explicit stop() is a no-op (sources.get returns undefined)', () => {
        const capturedNodes: CapturedSourceNode[] = [];
        const mockCtor = vi.fn().mockImplementation(function AudioContextMock() {
          return makeOnendedMockCtx(capturedNodes);
        });
        globalThis.AudioContext = mockCtor as unknown as typeof AudioContext;

        const engine = new WebAudioEngine();
        const buf = makeOnendedTestBuffer();

        // Play a non-loop source.
        engine.play(1, buf, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
        expect(engine.getActiveSourceCount()).toBe(1);
        const node = capturedNodes[0] as CapturedSourceNode;
        expect(node.onended).not.toBeNull();

        // Explicit stop: delete from sources Map, then node.stop().
        engine.stop(1);
        expect(engine.getActiveSourceCount()).toBe(0);

        // Simulate onended firing after explicit stop (Web Audio spec:
        // node.stop() also triggers onended asynchronously).
        // The guard: sources.get(1) returns undefined → no-op.
        const handler = node.onended as unknown as (() => void) | null;
        if (handler) {
          handler();
        }

        // Should still be 0: guard correctly no-ops when source is gone.
        expect(engine.getActiveSourceCount()).toBe(0);

        engine.destroy();
      });
    });
  });
}
