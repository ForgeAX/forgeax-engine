import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { directionalShadowPreparationLimit } from '../record/frame';
import type { RenderFrameState } from '../record/frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import {
  discardCompiledFrameGraphs,
  ensureCompiledFrameGraph,
  executeCompiledFrameGraph,
  getRenderFeatureGraphInspection,
  inspectRenderGraphGenerationAllocation,
  type RenderFeatureGraphCandidate,
  retire as retireCompiledGraph,
  settleCompiledFrameGraphCandidate,
  shareRenderGraphGenerationAllocationOwner,
} from '../record/typed-frame-graph';
import type { RenderPipeline } from '../render-pipeline';
import type { ExtractedLights } from '../render-system-extract';
import { createTemporalFrameTransaction } from '../temporal/frame';
import type { TerrainShadowReceiver } from '../terrain/shadow-family';

function createRecoveryGraphHarness(texture = false, sharedInternals?: RenderSystemInternals) {
  let failBuild = false;
  let importedBuffer: Buffer | undefined;
  const consumedBuffers: Buffer[] = [];
  const activePipeline: RenderPipeline = {
    build: ({ graph }) => {
      if (failBuild) return { ok: false, error: { code: 'injected-build-failure' } } as never;
      if (texture) {
        const target = graph
          .createTexture('recovery-color', { size: { width: 2, height: 2 }, format: 'rgba8unorm' })
          .unwrap();
        const view = graph.view(target).unwrap();
        return graph.addRasterPass('recovery-clear', {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          encode() {},
        });
      }
      const capturedBuffer = importedBuffer;
      const buffer =
        capturedBuffer === undefined
          ? graph.createBuffer('recovery-graph-bytes', { size: 16 })
          : graph.importBuffer(
              'recovery-graph-bytes',
              { size: 16, usage: 8 },
              () => capturedBuffer,
            );
      if (!buffer.ok) return buffer;
      return graph.addCopyPass('recovery-graph-seed', {
        accesses: [{ resource: buffer.value, usage: 'copy-dst' }],
        encode: ({ resources }) => {
          consumedBuffers.push(resources.buffer(buffer.value).unwrap());
        },
      });
    },
  };
  const frameState = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    compiledFrameGraph: null,
    graphGeneration: 0,
    compiledFrameGraphGeneration: 0,
    standardLightingGraphSignature: '',
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
  } as unknown as RenderFrameState;
  const errorRegistry = new RhiErrorListenerRegistry();
  const errors: unknown[] = [];
  errorRegistry.add((error) => errors.push(error));
  let device: RhiDevice | undefined;
  const internals =
    sharedInternals ??
    ({
      get device() {
        return device as RhiDevice;
      },
      errorRegistry,
      lookupPostProcess: () => ({
        source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      }),
      buildPostProcessPipeline() {
        throw new Error('pipeline build is not used by chain admission');
      },
      getPostProcessPipeline: () => null,
    } as unknown as RenderSystemInternals);
  const pipelineState = {
    format: 'rgba8unorm',
    colorAttachmentFormat: 'rgba8unorm',
  } as unknown as PipelineState;
  let lights = {
    cascadeCount: undefined,
    pointShadow: [],
    spot: [],
  } as unknown as ExtractedLights;
  return {
    activePipeline,
    frameState,
    internals,
    pipelineState,
    get lights() {
      return lights;
    },
    setCascadeCount(cascadeCount: 1 | 2 | 3 | 4) {
      lights = { ...lights, cascadeCount };
    },
    setStaticShadowCache(enabled: boolean) {
      lights = {
        ...lights,
        directionalCsmConfig: enabled
          ? undefined
          : ({ staticShadowCache: false } as ExtractedLights['directionalCsmConfig']),
      };
    },
    setDevice(nextDevice: RhiDevice) {
      device = nextDevice;
    },
    setImportedBuffer(buffer: Buffer) {
      importedBuffer = buffer;
    },
    consumedBuffers,
    errors,
    compile(
      width = 1,
      terrainReceivers: readonly TerrainShadowReceiver[] = [],
      shadowMapSize = 16,
      featureCandidate?: RenderFeatureGraphCandidate,
    ) {
      const args: Parameters<typeof ensureCompiledFrameGraph> = [
        internals,
        frameState,
        pipelineState,
        makeZeroCameraFallbackSnapshot(),
        lights,
        width,
        1,
        lights.cascadeCount === undefined ? undefined : shadowMapSize,
      ];
      args[23] = terrainReceivers;
      args[9] = featureCandidate;
      return ensureCompiledFrameGraph(...args);
    },
    submit() {
      if (device === undefined) throw new Error('graph device missing');
      return executeCompiledFrameGraph(
        internals,
        frameState,
        { pipelineState } as never,
        device.createCommandEncoder().unwrap(),
      );
    },
    accept() {
      settleCompiledFrameGraphCandidate(frameState, true);
    },
    invalidateTopology() {
      const installed = frameState.compiledFrameGraph;
      if (installed === null) throw new Error('no installed graph to invalidate');
      frameState.compiledFrameGraph = { ...installed, topologyKey: 'invalidated' };
    },
    requestPendingPostProcess() {
      frameState.installedPipelineConfig = { postEffects: ['test.pending-post'] };
    },
    setFail(value: boolean) {
      failBuild = value;
    },
  };
}

describe('detached recovery graph execution boundary', () => {
  it('retains directional demand with the installed owner across pending, rejection and recovery', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    harness.setCascadeCount(4);
    const first = harness.compile();
    if (first === null || harness.frameState.compiledFrameGraph === null)
      throw new Error('initial graph failed');
    // The stock owning path is covered by Native pixels; here retain its
    // installation fact while exercising the real generic transaction owner.
    harness.frameState.compiledFrameGraph = {
      ...harness.frameState.compiledFrameGraph,
      directionalShadowViewCount: 4,
    };
    harness.accept();
    const accepted = harness.frameState.compiledFrameGraph;
    const limit = () =>
      directionalShadowPreparationLimit(
        1,
        harness.frameState.compiledFrameGraph,
        harness.frameState.compiledFrameGraphCandidate?.previous.installed,
      );
    try {
      harness.setCascadeCount(1);
      harness.requestPendingPostProcess();
      expect(harness.compile()).toBe(first);
      expect(harness.frameState.compiledFrameGraph).toBe(accepted);
      expect(limit()).toBe(4);
      harness.frameState.installedPipelineConfig = undefined;
      harness.setFail(true);
      expect(harness.compile(2)).toBe(first);
      expect(limit()).toBe(4);
      harness.setFail(false);
      const replacement = harness.compile(2);
      expect(replacement).not.toBe(first);
      // A custom pipeline's successful replacement has no stock demand proof.
      expect(limit()).toBeUndefined();
      settleCompiledFrameGraphCandidate(harness.frameState, false);
      expect(harness.frameState.compiledFrameGraph).toBe(accepted);
      expect(limit()).toBe(4);
      harness.frameState.compiledFrameGraph = null;
      expect(limit()).toBeUndefined();
    } finally {
      await first.retire();
    }
  });

  it('does not parse or inspect an unused last-known-good graph on ordinary reuse', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    const original = harness.compile();
    if (original === null) throw new Error('initial graph failed');
    harness.accept();
    const parse = vi.spyOn(JSON, 'parse');
    const inspect = vi.spyOn(original, 'inspect');
    try {
      expect(harness.compile()).toBe(original);
      expect(parse).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      // A real compile failure still validates its fallback after normal admission.
      harness.setFail(true);
      expect(harness.compile(2)).toBe(original);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
      inspect.mockRestore();
      await original.retire();
    }
  });

  it('keeps pending-chain Terrain admission and failed replacement checks in their original order', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    vi.spyOn(device, 'limits', 'get').mockReturnValue({
      ...device.limits,
      maxTextureArrayLayers: 256,
    });
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    harness.setCascadeCount(1);
    const originalRoots = [{ worldId: 0, entityKey: 7 }];
    const original = harness.compile(1, originalRoots);
    if (original === null) throw new Error('initial Terrain graph failed');
    harness.accept();
    harness.requestPendingPostProcess();
    const pipelineLookup = vi.spyOn(harness.internals, 'getPostProcessPipeline');
    const parse = vi.spyOn(JSON, 'parse');
    const inspect = vi.spyOn(original, 'inspect');
    try {
      expect(harness.compile(1, originalRoots)).toBe(original);
      expect(pipelineLookup.mock.invocationCallOrder[0]).toBeLessThan(
        parse.mock.invocationCallOrder[0] ?? 0,
      );
      expect(parse.mock.invocationCallOrder[0]).toBeLessThan(
        inspect.mock.invocationCallOrder[0] ?? 0,
      );
      expect(parse).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledTimes(1);
      parse.mockClear();
      inspect.mockClear();
      harness.setFail(true);
      // Pending admission and failed-build fallback both refuse changed roots.
      expect(harness.compile(1, [{ worldId: 1, entityKey: 7 }])).toBeNull();
      expect(parse).toHaveBeenCalledTimes(2);
      expect(inspect).not.toHaveBeenCalled();
      expect(harness.frameState.compiledFrameGraph?.graph).toBe(original);
    } finally {
      pipelineLookup.mockRestore();
      parse.mockRestore();
      inspect.mockRestore();
      await original.retire();
    }
  });

  it('refuses stale Terrain routing after failed replacement and restores the accepted mapping on rejected submission', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    vi.spyOn(device, 'limits', 'get').mockReturnValue({
      ...device.limits,
      maxTextureArrayLayers: 256,
    });
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    harness.setCascadeCount(4);
    const originalRoots = [{ worldId: 0, entityKey: 7 }];
    const replacementRoots = [{ worldId: 1, entityKey: 7 }];
    const original = harness.compile(1, originalRoots);
    if (original === null) throw new Error('original Terrain graph failed');
    harness.accept();
    const accepted = harness.frameState.compiledFrameGraph;
    harness.setFail(true);
    expect(harness.compile(1, replacementRoots)).toBeNull();
    expect(harness.frameState.compiledFrameGraph).toBe(accepted);
    // The same roster may still use its accepted graph while compilation fails.
    expect(harness.compile(2, originalRoots)).toBe(original);
    expect(harness.compile(1, originalRoots, 32)).toBeNull();
    harness.setCascadeCount(2);
    expect(harness.compile(1, originalRoots)).toBeNull();
    harness.setCascadeCount(4);
    harness.setFail(false);
    const rejected = harness.compile(1, replacementRoots);
    if (rejected === null) throw new Error('replacement Terrain graph failed');
    expect(rejected).not.toBe(original);
    settleCompiledFrameGraphCandidate(harness.frameState, false);
    expect(harness.frameState.compiledFrameGraph).toBe(accepted);
    expect(harness.compile(1, originalRoots)).toBe(original);
    const retry = harness.compile(1, replacementRoots);
    if (retry === null) throw new Error('Terrain graph retry failed');
    expect(retry).not.toBe(rejected);
    expect(retry).not.toBe(original);
    harness.accept();
    expect(harness.compile(1, replacementRoots)).toBe(retry);
    const installed = harness.frameState.compiledFrameGraph;
    if (installed === null) throw new Error('retry graph was not installed');
    const topology = JSON.parse(installed.topologyKey).topology;
    expect(topology.shadow.directional.terrainReceivers).toEqual(replacementRoots);
    await retry.retire();
  });

  it('recompiles when a directional light toggles its static shadow cache', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    harness.setCascadeCount(3);
    const directional = () => {
      const installed = harness.frameState.compiledFrameGraph;
      if (installed === null) throw new Error('no installed graph');
      return JSON.parse(installed.topologyKey).topology.shadow.directional;
    };
    const cached = harness.compile();
    if (cached === null) throw new Error('cached graph failed');
    harness.accept();
    expect(directional()).toEqual({ mapSize: 16, cascadeCount: 3 });
    expect(harness.compile()).toBe(cached);

    harness.setStaticShadowCache(false);
    const single = harness.compile();
    if (single === null) throw new Error('single-layer graph failed');
    expect(single).not.toBe(cached);
    harness.accept();
    expect(directional()).toEqual({ mapSize: 16, cascadeCount: 3, staticLayer: false });
    expect(harness.compile()).toBe(single);

    harness.setStaticShadowCache(true);
    const restored = harness.compile();
    if (restored === null) throw new Error('restored graph failed');
    expect(restored).not.toBe(single);
    harness.accept();
    expect(directional()).toEqual({ mapSize: 16, cascadeCount: 3 });
    await restored.retire();
  });

  it('rejects an exhausted Terrain layer carrier instead of falling back to an accepted graph', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    vi.spyOn(device, 'limits', 'get').mockReturnValue({
      ...device.limits,
      maxTextureArrayLayers: 256,
    });
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    harness.setCascadeCount(4);
    const originalRoots = [{ worldId: 0, entityKey: 1 }];
    const graph = harness.compile(1, originalRoots);
    if (graph === null) throw new Error('original Terrain graph failed');
    harness.accept();
    const accepted = harness.frameState.compiledFrameGraph;
    const exhausted = Array.from({ length: 64 }, (_, entityKey) => ({ worldId: 0, entityKey }));
    expect(harness.compile(1, exhausted)).toBeNull();
    expect(harness.frameState.compiledFrameGraph).toBe(accepted);
    expect(harness.compile(1, originalRoots)).toBe(graph);
    await graph.retire();
  });

  it('counts shared physical textures once across active, candidate and retiring generations', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    let finish: () => void = () => undefined;
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const creates = vi.spyOn(device, 'createTexture');
    const destroys = vi.spyOn(device, 'destroyTexture');
    const harness = createRecoveryGraphHarness(true);
    harness.setDevice(device);
    const first = harness.compile();
    if (first === null) throw new Error('first compile failed');
    harness.invalidateTopology();
    const second = harness.compile();
    if (second === null) throw new Error('replacement compile failed');
    expect(first).not.toBe(second);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(inspectRenderGraphGenerationAllocation(harness.frameState)).toMatchObject({
      liveBytes: 16,
      pendingRetirementBytes: 0,
      peakBytes: 16,
    });
    expect(second.inspect().resourceAllocation).toMatchObject({
      successfulAllocationCount: 0,
      successfulAllocationBytes: 0,
    });
    harness.accept();
    expect(inspectRenderGraphGenerationAllocation(harness.frameState)).toMatchObject({
      liveBytes: 16,
      pendingRetirementBytes: 0,
      peakBytes: 16,
    });
    finish();
    await first.retire();
    expect(destroys).not.toHaveBeenCalled();
    const retiring = second.retire();
    expect(inspectRenderGraphGenerationAllocation(harness.frameState)).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 16,
      peakBytes: 16,
    });
    finish();
    await retiring;
    expect(destroys).toHaveBeenCalledTimes(1);
  });

  it('installs the graph, topology key and target lookup as one record', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const graph = harness.compile();
    if (graph === null) throw new Error('compile failed');
    const installed = harness.frameState.compiledFrameGraph;
    expect(installed?.graph).toBe(graph);
    expect(installed?.topologyKey).toEqual(expect.any(String));
    expect(installed?.targets.graphGeneration).toBe(harness.frameState.graphGeneration);
    harness.accept();
    expect(harness.compile()).toBe(graph);
    expect(harness.frameState.compiledFrameGraph).toBe(installed);
  });

  it('retains the accepted graph when a replacement build fails and retires it on replacement', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const candidate = harness.compile();
    expect(candidate).not.toBeNull();
    if (candidate === null) return;
    harness.accept();
    harness.invalidateTopology();
    harness.setFail(true);
    expect(harness.compile()).toBe(candidate);
    expect(harness.frameState.compiledFrameGraph?.graph).toBe(candidate);

    harness.setFail(false);
    const replacement = harness.compile();
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(candidate);
    expect(harness.frameState.compiledFrameGraph?.graph).toBe(replacement);
    expect(harness.frameState.retiredCompiledFrameGraphs.has(candidate)).toBe(false);
    harness.accept();
    expect(harness.frameState.retiredCompiledFrameGraphs.has(candidate)).toBe(true);

    harness.setFail(true);
    expect(harness.compile()).toBe(replacement);
  });

  it('projects active candidate overlap and graph-generation peak bytes', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const first = harness.compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    harness.accept();
    harness.invalidateTopology();
    const replacement = harness.compile();
    expect(replacement).not.toBeNull();
    if (replacement === null) return;
    // The old graph remains live until the replacement submission is accepted.
    expect(inspectRenderGraphGenerationAllocation(harness.frameState).liveBytes).toBe(32);
    harness.accept();

    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    expect(allocation.availability).toBe('complete');
    expect(allocation.entries).toHaveLength(2);
    expect(
      allocation.entries.find((entry) => entry.generation === replacement.inspect().generation)
        ?.roles,
    ).toEqual(expect.arrayContaining(['active']));
    expect(
      allocation.entries.find((entry) => entry.generation === first.inspect().generation)?.roles,
    ).toEqual(expect.arrayContaining(['retiring']));
    expect(allocation.liveBytes).toBe(16);
    expect(allocation.pendingRetirementBytes).toBe(16);
    expect(allocation.peakBytes).toBe(32);
  });

  it('records graph-generation overlap without an allocation inspection sample', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const first = harness.compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    harness.accept();

    // Force two ordinary graph replacements. Do not call the allocation
    // inspection between them: the renderer owner must observe compile and
    // retirement events itself rather than treating inspect() as a sampler.
    harness.invalidateTopology();
    const second = harness.compile();
    expect(second).not.toBeNull();
    if (second === null) return;
    harness.accept();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    harness.invalidateTopology();
    const third = harness.compile();
    expect(third).not.toBeNull();
    if (third === null) return;
    harness.accept();

    // RHI-null retires the old generations on its queue fence. The first
    // inspection therefore sees one live graph, while peakBytes retains the
    // live + retiring overlap observed during replacement.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    expect(allocation.liveBytes).toBe(16);
    expect(allocation.pendingRetirementBytes).toBe(0);
    expect(allocation.peakBytes).toBe(32);
    expect(allocation.entries).toHaveLength(1);
    expect(allocation.entries[0]?.generation).toBe(third.inspect().generation);
  });

  it('keeps a failed graph retirement visible in the renderer generation ledger', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const first = harness.compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    harness.accept();
    (device as unknown as { destroyBuffer: RhiDevice['destroyBuffer'] }).destroyBuffer = () =>
      ({ ok: false, error: { code: 'webgpu-runtime-error' } }) as never;
    harness.invalidateTopology();
    const replacement = harness.compile();
    expect(replacement).not.toBeNull();
    if (replacement === null) return;
    harness.accept();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    const failed = allocation.entries.find(
      (entry) => entry.generation === first.inspect().generation,
    );
    expect(failed?.retirement).toBe('failed');
    expect(failed?.allocation.pendingRetirementBytes).toBe(16);
    expect(allocation.failedRetirementCount).toBe(1);
    expect(allocation.failedRetirementBytes).toBe(16);
  });

  it('keeps a detached recovery candidate failure in the shared owner', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    const active = harness.compile();
    expect(active).not.toBeNull();
    if (active === null) return;
    harness.accept();

    const candidateFrameState = {
      ...harness.frameState,
      compiledFrameGraph: null,
      retiredCompiledFrameGraphs: new Set(),
    } as unknown as RenderFrameState;
    shareRenderGraphGenerationAllocationOwner(harness.frameState, candidateFrameState);
    const candidate = ensureCompiledFrameGraph(
      harness.internals,
      candidateFrameState,
      harness.pipelineState,
      makeZeroCameraFallbackSnapshot(),
      harness.lights,
      1,
      1,
      undefined,
    );
    expect(candidate).not.toBeNull();
    if (candidate === null) return;

    (device as unknown as { destroyBuffer: RhiDevice['destroyBuffer'] }).destroyBuffer = () =>
      ({ ok: false, error: { code: 'webgpu-runtime-error' } }) as never;
    retireCompiledGraph(candidateFrameState, candidate);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    const failed = allocation.entries.find(
      (entry) => entry.generation === candidate.inspect().generation,
    );
    expect(failed?.retirement).toBe('failed');
    expect(failed?.roles).toEqual(expect.arrayContaining(['retiring']));
    expect(allocation.failedRetirementCount).toBe(1);
    expect(allocation.failedRetirementBytes).toBe(16);
  });
});

it('restores the complete graph projection and retires a failed resize candidate exactly once', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const harness = createRecoveryGraphHarness();
  harness.setDevice(device);
  const accepted = harness.compile();
  if (accepted === null) throw new Error('initial graph missing');
  harness.accept();
  const state = harness.frameState;
  const previous = {
    installed: state.compiledFrameGraph,
    generation: state.graphGeneration,
    compiledGeneration: state.compiledFrameGraphGeneration,
    lighting: state.standardLightingGraphSignature,
  };
  const candidate = harness.compile(2);
  if (candidate === null) throw new Error('resize graph missing');
  const retire = vi.spyOn(candidate, 'retire');
  settleCompiledFrameGraphCandidate(state, false);
  settleCompiledFrameGraphCandidate(state, false);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(state.compiledFrameGraph).toBe(previous.installed);
  expect(state.graphGeneration).toBe(previous.generation);
  expect(state.compiledFrameGraphGeneration).toBe(previous.compiledGeneration);
  expect(state.standardLightingGraphSignature).toBe(previous.lighting);
  const retried = harness.compile(2);
  expect(retried).not.toBe(candidate);
  const retireAccepted = vi.spyOn(accepted, 'retire');
  harness.accept();
  harness.accept();
  expect(retireAccepted).toHaveBeenCalledTimes(1);
  await retried?.retire();
});

it('installs a changed topology once while its frames wait for pipeline preparation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const harness = createRecoveryGraphHarness();
  harness.setDevice(device);
  const accepted = harness.compile();
  if (accepted === null) throw new Error('initial graph missing');
  harness.accept();
  const compiles = () => getRenderFeatureGraphInspection(harness.internals).compileAttempts;
  const before = compiles();
  const changed = harness.compile(2);
  if (changed === null) throw new Error('changed graph missing');
  const retireChanged = vi.spyOn(changed, 'retire');
  // Three frames that did not submit (for example, pending pipelines).
  for (let frame = 0; frame < 3; frame++) {
    settleCompiledFrameGraphCandidate(harness.frameState, false, true);
    expect(harness.compile(2)).toBe(changed);
  }
  harness.accept();
  expect(compiles() - before).toBe(1);
  expect(harness.frameState.compiledFrameGraph?.graph).toBe(changed);
  expect(harness.frameState.unsubmittedCompiledFrameGraph).toBeUndefined();
  // A different unsubmitted topology is retired once another graph is accepted.
  const abandoned = harness.compile(3);
  if (abandoned === null) throw new Error('abandoned graph missing');
  const retireAbandoned = vi.spyOn(abandoned, 'retire');
  settleCompiledFrameGraphCandidate(harness.frameState, false, true);
  expect(harness.compile(2)).toBe(changed);
  expect(retireAbandoned).not.toHaveBeenCalled();
  const replacement = harness.compile(4);
  expect(retireAbandoned).toHaveBeenCalledTimes(1);
  harness.accept();
  expect(retireChanged).toHaveBeenCalledTimes(1);
  await replacement?.retire();
});

it('keeps the accepted graph when an unsubmitted candidate is replaced again and the frame fails', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const harness = createRecoveryGraphHarness();
  harness.setDevice(device);
  const accepted = harness.compile();
  if (accepted === null) throw new Error('initial graph missing');
  harness.accept();
  const acceptedInstall = harness.frameState.compiledFrameGraph;
  const acceptedRetire = vi.spyOn(accepted, 'retire');
  const first = harness.compile(2);
  if (first === null) throw new Error('first candidate missing');
  const firstRetire = vi.spyOn(first, 'retire');
  const second = harness.compile(3);
  if (second === null) throw new Error('second candidate missing');
  const secondRetire = vi.spyOn(second, 'retire');
  settleCompiledFrameGraphCandidate(harness.frameState, false);
  expect(harness.frameState.compiledFrameGraph).toBe(acceptedInstall);
  expect(acceptedInstall?.graph).toBe(accepted);
  expect(acceptedRetire).not.toHaveBeenCalled();
  expect(firstRetire).toHaveBeenCalledTimes(1);
  expect(secondRetire).toHaveBeenCalledTimes(1);
  await accepted.retire();
});

function preparedCandidate(preparedResourceKey?: string): RenderFeatureGraphCandidate {
  return {
    plans: [],
    fullscreenEffects: new Map(),
    ...(preparedResourceKey === undefined ? {} : { preparedResourceKey }),
  };
}

describe('prepared resource graph identity', () => {
  it('retains the replacement imports after its one-frame rebuild request ends', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    const firstBuffer = device.createBuffer({ size: 16, usage: 8 }).unwrap();
    const nextBuffer = device.createBuffer({ size: 16, usage: 8 }).unwrap();
    harness.setImportedBuffer(firstBuffer);
    const first = harness.compile();
    expect(harness.submit(), JSON.stringify(harness.errors)).toBe(true);
    harness.setImportedBuffer(nextBuffer);
    const replacement = harness.compile(1, [], 16, preparedCandidate('frame-2'));
    expect(replacement).not.toBe(first);
    expect(harness.compile(1, [], 16, preparedCandidate('frame-2'))).toBe(replacement);
    expect(harness.submit()).toBe(true);
    device.destroyBuffer(firstBuffer).unwrap();

    expect(harness.compile(1, [], 16, preparedCandidate())).toBe(replacement);
    expect(harness.compile()).toBe(replacement);
    expect(harness.submit()).toBe(true);
    expect(harness.consumedBuffers).toEqual([firstBuffer, nextBuffer, nextBuffer]);
    expect(harness.frameState.compiledFrameGraphGeneration).toBe(2);
    discardCompiledFrameGraphs(harness.frameState);
    device.destroyBuffer(nextBuffer).unwrap();
  });

  it('restores the accepted resource identity after build failure, abort and submit failure', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    const accepted = harness.compile(1, [], 16, preparedCandidate('frame-1'));
    expect(harness.submit()).toBe(true);
    const installed = harness.frameState.compiledFrameGraph;
    harness.setFail(true);
    expect(harness.compile(1, [], 16, preparedCandidate('frame-2'))).toBe(accepted);
    expect(harness.frameState.compiledFrameGraph).toBe(installed);
    harness.setFail(false);

    const aborted = harness.compile(1, [], 16, preparedCandidate('frame-3'));
    expect(aborted).not.toBe(accepted);
    settleCompiledFrameGraphCandidate(harness.frameState, false);
    expect(harness.compile(1, [], 16, preparedCandidate())).toBe(accepted);
    const retry = harness.compile(1, [], 16, preparedCandidate('frame-3'));
    expect(retry).not.toBe(aborted);
    expect(retry).not.toBe(accepted);
    const superseding = harness.compile(1, [], 16, preparedCandidate('frame-4'));
    expect(superseding).not.toBe(retry);
    const submit = vi.spyOn(device.queue, 'submit').mockReturnValue({
      ok: false,
      error: { code: 'webgpu-runtime-error' },
    } as never);
    expect(() => harness.submit()).toThrowError(
      expect.objectContaining({ code: 'frame-submit-rejected' }),
    );
    submit.mockRestore();
    expect(harness.frameState.compiledFrameGraph).toBe(installed);
    expect(harness.compile()).toBe(accepted);
    const recovered = harness.compile(1, [], 16, preparedCandidate('frame-4'));
    expect(recovered).not.toBe(superseding);
    expect(harness.submit()).toBe(true);
    expect(harness.compile(1, [], 16, preparedCandidate())).toBe(recovered);
    discardCompiledFrameGraphs(harness.frameState);
  });

  it('keeps resource identities view-local and forgets them at device recovery', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const main = createRecoveryGraphHarness();
    const auxiliary = createRecoveryGraphHarness(false, main.internals);
    main.setDevice(device);
    auxiliary.setDevice(device);
    const mainGraph = main.compile(1, [], 16, preparedCandidate('frame-1'));
    const auxiliaryGraph = auxiliary.compile(1, [], 16, preparedCandidate('frame-2'));
    main.accept();
    auxiliary.accept();
    expect(main.compile(1, [], 16, preparedCandidate())).toBe(mainGraph);
    expect(auxiliary.compile(1, [], 16, preparedCandidate())).toBe(auxiliaryGraph);
    const replaced = main.compile(1, [], 16, preparedCandidate('frame-3'));
    expect(replaced).not.toBe(mainGraph);
    main.accept();
    expect(auxiliary.compile()).toBe(auxiliaryGraph);

    discardCompiledFrameGraphs(main.frameState);
    discardCompiledFrameGraphs(auxiliary.frameState);
    const replacementDevice = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    main.setDevice(replacementDevice);
    auxiliary.setDevice(replacementDevice);
    const recovered = main.compile(1, [], 16, preparedCandidate('recovery-2'));
    expect(recovered).not.toBe(replaced);
    main.accept();
    expect(main.compile(1, [], 16, preparedCandidate())).toBe(recovered);
    const recoveredAuxiliary = auxiliary.compile();
    expect(recoveredAuxiliary).not.toBe(auxiliaryGraph);
    auxiliary.accept();
    expect(auxiliary.compile()).toBe(recoveredAuxiliary);
    discardCompiledFrameGraphs(main.frameState);
    discardCompiledFrameGraphs(auxiliary.frameState);
  });
});
