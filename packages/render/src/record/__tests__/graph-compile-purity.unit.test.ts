import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { type PhysicsWorld, PhysicsWorldResource } from '@forgeax/engine-physics';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { advancedWaterFixture } from '../../__tests__/advanced-water-fixture';
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  submitFeatureFrame,
} from '../../__tests__/feature-frame-driver';
import { compileAndAdoptViewGraph } from '../../__tests__/graph-compile.fixture';
import { compileSharedFeatureGraph } from '../../assembly/feature-frame-graph';
import { DeviceScope } from '../../device/device-scope';
import {
  createRenderFeatureHost,
  type RenderFeatureFrameResult,
  type RenderFeatureHost,
} from '../../features/host';
import { createRenderFeatureGpuWorkOwner } from '../../features/prepared-gpu-work';
import type { RenderFeature } from '../../features/types';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import type { RenderPipeline } from '../../render-pipeline';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
import { createWaterAdvancedFeature } from '../../water/advanced-feature';
import { createWaterFluidFeature, type WaterFluidFeatureFrame } from '../../water/fluid-feature';
import type { ViewLights } from '../../world/render-lights';
import type { RenderFrameState } from '../frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../render-context';
import {
  compileViewGraph,
  ensureShadowDepthLayers,
  getRenderFeatureGraphInspection,
  mutableFeatureGraphInspection,
  promoteGraphCandidate,
  rollbackGraphCandidate,
} from '../typed-frame-graph';

async function harness(retainBuildBinding = false) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let failBuild = false;
  const activePipeline: RenderPipeline = {
    build: ({ graph, getSharedGraphTextureBinding }) => {
      if (failBuild) return { ok: false, error: { code: 'injected-build-failure' } } as never;
      const buffer = graph.createBuffer('purity-bytes', { size: 16 });
      if (!buffer.ok) return buffer;
      return graph.addCopyPass('purity-seed', {
        accesses: [{ resource: buffer.value, usage: 'copy-dst' }],
        encode: retainBuildBinding
          ? () => {
              getSharedGraphTextureBinding?.('unused');
            }
          : () => undefined,
      });
    },
  };
  const frameState = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: null,
    graphGeneration: 0,
    compiledFrameGraphGeneration: 0,
    standardLightingGraphSignature: '',
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
    frameNumber: 0,
  } as unknown as RenderFrameState;
  const errors: unknown[] = [];
  const errorRegistry = new RhiErrorListenerRegistry();
  errorRegistry.add((error) => errors.push(error));
  const internals = {
    device,
    deviceScope: DeviceScope.create(0, 'graph-purity-test'),
    errorRegistry,
    lookupPostProcess: () => undefined,
    getPostProcessPipeline: () => null,
  } as unknown as RenderSystemInternals;
  const shadowDepthLayers = ensureShadowDepthLayers(frameState, device);
  const input = (width = 1) => ({
    internals,
    frameState,
    pipelineState: {
      format: 'rgba8unorm',
      colorAttachmentFormat: 'rgba8unorm',
    } as unknown as PipelineState,
    camera: makeZeroCameraFallbackSnapshot(),
    lights: {
      cascades: undefined,
      pointShadow: [],
      spot: [],
      shadowViews: [],
    } as unknown as ViewLights,
    surface: { width, height: 1 },
    shadowDepthLayers,
  });
  return {
    frameState,
    internals,
    errors,
    input,
    compile: (width = 1) => compileAndAdoptViewGraph(input(width)),
    accept: () => promoteGraphCandidate(frameState),
    stash: () => rollbackGraphCandidate(frameState, true),
    invalidate: () => {
      const installed = frameState.compiledFrameGraph;
      if (installed === null) throw new Error('no installed graph');
      frameState.compiledFrameGraph = { ...installed, topologyKey: 'invalidated' };
    },
    setFail: (value: boolean) => {
      failBuild = value;
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

it('rejects a failed capsule-consumer switch instead of recording a graph with the old caster policy', async () => {
  const h = await harness();
  h.compile();
  h.accept();
  h.setFail(true);
  const outcome = compileViewGraph({ ...h.input(), forwardCapsuleShadows: true });
  expect(outcome.kind).toBe('rejected');
});

it('never retains a single-sample graph for an unqualified WebGL2 MSAA request', async () => {
  const h = await harness();
  h.compile();
  h.accept();
  Object.defineProperty(h.internals.device, 'caps', {
    value: { ...h.internals.device.caps, backendKind: 'wgpu-webgl2' },
  });
  const input = h.input();
  const outcome = compileViewGraph({ ...input, camera: { ...input.camera, antialias: 'msaa' } });
  expect(outcome.kind).toBe('rejected');
});

it('releases retired view graphs while current passes retain their build bindings', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const h = await harness(true);
  const released = (() => {
    h.compile();
    h.accept();
    const graph = h.frameState.compiledFrameGraph?.graph;
    if (graph === undefined) throw new Error('Missing initial view graph');
    return new WeakRef(graph);
  })();
  for (let frame = 0; frame < 8; frame++) {
    h.compile(frame + 2);
    h.accept();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let attempt = 0; attempt < 10 && released.deref() !== undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  expect(h.frameState.compiledFrameGraph?.graph).toBeDefined();
  expect(h.frameState.retiredCompiledFrameGraphs.size).toBe(0);
  expect(released.deref()).toBeUndefined();
});

/** Each fixture prepares the state its final compile observes and returns that compile's width. */
const fixtures: Record<string, (h: Harness) => number> = {
  compiled: () => 1,
  reused: (h) => {
    h.compile();
    h.accept();
    return 1;
  },
  promoted: (h) => {
    h.compile();
    h.accept();
    h.compile(2);
    h.stash();
    return 2;
  },
  retained: (h) => {
    h.compile();
    h.accept();
    h.invalidate();
    h.setFail(true);
    return 1;
  },
  rejected: (h) => {
    h.setFail(true);
    return 1;
  },
};

function observe(h: Harness) {
  const metrics = getRenderFeatureGraphInspection(h.internals);
  return {
    graphGeneration: h.frameState.graphGeneration,
    compiledFrameGraphGeneration: h.frameState.compiledFrameGraphGeneration,
    standardLightingGraphSignature: h.frameState.standardLightingGraphSignature,
    unsubmitted: h.frameState.unsubmittedCompiledFrameGraph !== undefined,
    candidate: h.frameState.compiledFrameGraphCandidate !== undefined,
    barrel: h.frameState.barrelDistortionGraphResolution,
    retiring: h.frameState.retiredCompiledFrameGraphs.size,
    errors: h.errors.length,
    metrics: {
      ensureCalls: metrics.ensureCalls,
      reuseHits: metrics.reuseHits,
      rebuildAttempts: metrics.rebuildAttempts,
      compileAttempts: metrics.compileAttempts,
      compileSuccesses: metrics.compileSuccesses,
      compileFailures: metrics.compileFailures,
      buildFailures: metrics.buildFailures,
      validationFailures: metrics.validationFailures,
      unsubmittedGraphReuses: metrics.unsubmittedGraphReuses,
      compilePrimaryCauses: metrics.compilePrimaryCauses,
      recentCompileChanges: metrics.recentCompileChanges?.length,
    },
  };
}

/** Golden observations captured from the in-place compile (`ensureCompiledFrameGraph`) on the parent (a1). */
const COUNTERS = {
  reuseHits: 0,
  rebuildAttempts: 1,
  compileAttempts: 1,
  compileSuccesses: 1,
  compileFailures: 0,
  buildFailures: 0,
  validationFailures: 0,
  unsubmittedGraphReuses: 0,
};
const GOLDENS = {
  compiled: {
    identity: 'replacement',
    graphGeneration: 1,
    compiledFrameGraphGeneration: 1,
    standardLightingGraphSignature: 'missing',
    unsubmitted: false,
    candidate: true,
    barrel: 'accepted',
    retiring: 0,
    errors: 0,
    metrics: {
      ...COUNTERS,
      ensureCalls: 1,
      compilePrimaryCauses: { cold: 1 },
      recentCompileChanges: 1,
    },
  },
  reused: {
    identity: 'installed',
    graphGeneration: 1,
    compiledFrameGraphGeneration: 1,
    standardLightingGraphSignature: 'missing',
    unsubmitted: false,
    candidate: false,
    barrel: 'accepted',
    retiring: 0,
    errors: 0,
    metrics: {
      ...COUNTERS,
      ensureCalls: 2,
      reuseHits: 1,
      compilePrimaryCauses: { cold: 1 },
      recentCompileChanges: 1,
    },
  },
  promoted: {
    identity: 'replacement',
    graphGeneration: 2,
    compiledFrameGraphGeneration: 2,
    standardLightingGraphSignature: 'missing',
    unsubmitted: false,
    candidate: true,
    barrel: 'accepted',
    retiring: 0,
    errors: 0,
    metrics: {
      ...COUNTERS,
      ensureCalls: 3,
      rebuildAttempts: 2,
      compileAttempts: 2,
      compileSuccesses: 2,
      unsubmittedGraphReuses: 1,
      compilePrimaryCauses: { cold: 1, 'topology.surface': 1 },
      recentCompileChanges: 2,
    },
  },
  retained: {
    identity: 'installed',
    graphGeneration: 1,
    compiledFrameGraphGeneration: 1,
    standardLightingGraphSignature: 'missing',
    unsubmitted: false,
    candidate: false,
    barrel: 'retained',
    retiring: 0,
    errors: 1,
    metrics: {
      ...COUNTERS,
      ensureCalls: 2,
      rebuildAttempts: 2,
      buildFailures: 1,
      compilePrimaryCauses: { cold: 1 },
      recentCompileChanges: 1,
    },
  },
  rejected: {
    identity: 'null',
    graphGeneration: 0,
    compiledFrameGraphGeneration: 0,
    standardLightingGraphSignature: '',
    unsubmitted: false,
    candidate: false,
    barrel: 'retained',
    retiring: 0,
    errors: 1,
    metrics: {
      ...COUNTERS,
      ensureCalls: 1,
      compileAttempts: 0,
      compileSuccesses: 0,
      buildFailures: 1,
      compilePrimaryCauses: {},
      recentCompileChanges: 0,
    },
  },
} as const;

function freezeOwnedState(h: Harness): void {
  const metrics = mutableFeatureGraphInspection(h.internals);
  Object.freeze(metrics.compilePrimaryCauses);
  Object.freeze(metrics.compileChangedDependencies);
  Object.freeze(metrics.recentCompileChanges);
  Object.freeze(metrics);
  const installed = h.frameState.compiledFrameGraph;
  if (installed !== null) {
    Object.freeze(installed.targets);
    Object.freeze(installed);
  }
  Object.freeze(h.frameState);
}

describe('compileViewGraph purity', () => {
  for (const [kind, prepare] of Object.entries(fixtures)) {
    it(`returns ${kind} without writing frame state or feature metrics`, async () => {
      const h = await harness();
      const width = prepare(h);
      freezeOwnedState(h);
      const errorsBefore = h.errors.length;
      const outcome = compileViewGraph(h.input(width));
      expect(outcome.kind === 'failed' ? outcome.cause : undefined).toBeUndefined();
      expect(outcome.kind).toBe(kind);
      // Errors are carried as data until adoption fires them.
      expect(h.errors.length).toBe(errorsBefore);
    });
  }
});

describe('adoptViewGraph parity', () => {
  it('keeps shared Advanced execution independent of view topology across hold, rejection and live work', async () => {
    const h = await harness();
    const source = await advancedWaterFixture();
    const collisionQueries: Pick<
      PhysicsWorld,
      'getCommittedColliderPrimitives' | 'intersectsCommittedBodyObb'
    > = {
      getCommittedColliderPrimitives: (entity) =>
        ok({
          entity,
          generation: 0,
          completedStep: 0,
          motionDiscontinuity: 0,
          positionM: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          centerOfMassM: [0, 0, 0],
          linearVelocityMps: [0, 0, 0],
          angularVelocityRadps: [0, 0, 0],
          rawAggregateCount: 0,
          elements: [],
        }),
      intersectsCommittedBodyObb: () => ok(false),
    };
    source.world.insertResource(PhysicsWorldResource, collisionQueries as PhysicsWorld);
    source.world.update(1 / 60).unwrap();
    const shader = (
      await rhi.createShaderModule(h.internals.device, { code: 'synthetic' })
    ).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => h.internals.device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const advanced = createWaterAdvancedFeature({});
    const host = createRenderFeatureHost([advanced]).unwrap();
    let viewSubmissions = 0;
    const viewFeature: RenderFeature<undefined> = {
      identity: 'view-copy-control',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'camera:0' },
              resources: [
                {
                  kind: 'buffer',
                  name: 'from',
                  size: 16,
                  usage: ['copy-src'],
                  data: new Uint32Array([1, 2, 3, 4]),
                },
                { kind: 'buffer', name: 'to', size: 16, usage: ['storage'] },
              ],
              passes: [
                {
                  kind: 'copy',
                  name: 'view-copy',
                  copies: [{ source: 'from', destination: 'to', size: 16 }],
                },
              ],
            },
          ],
        }),
      onFrameSubmitted: () => {
        viewSubmissions++;
      },
    };
    Object.assign(h.internals, {
      featureHost: host,
      canvas: { width: 16, height: 16 },
      immediateShaderModuleFactory: { createShaderModule: () => ok(shader) },
    });
    const sharedGraphs: NonNullable<ReturnType<typeof compileSharedFeatureGraph>>[] = [];
    const viewGraphs = new Set<NonNullable<RenderFrameState['compiledFrameGraph']>['graph']>();
    const passCounts = new Set<number>();
    let previous: NonNullable<ReturnType<typeof compileSharedFeatureGraph>> | undefined;
    try {
      for (let frameNumber = 1; frameNumber <= 5; frameNumber++) {
        if (frameNumber !== 2) source.update(frameNumber);
        if (frameNumber === 4) host.install(viewFeature).unwrap();
        const batch = prepareFeatureFrame(host, [
          {
            identity: 'camera:0',
            render: true,
            world: source.world,
            frameNumber,
            generation: 0,
            deviceGeneration: 0,
            caps: {
              ...h.internals.device.caps,
              compute: true,
              storageBuffer: true,
              storageTexture: true,
              rgba16floatStorage: true,
              rgba32floatStorage: true,
            },
            limits: { maxTextureDimension2D: 8192 },
            gpuWork: gpu,
          },
        ]);
        try {
          expect(batch.frame.errors).toEqual([]);
          const view = batch.views.get('camera:0');
          if (view === undefined) throw new Error('missing view');
          expect(view.errors).toEqual([]);
          const shared = compileSharedFeatureGraph(
            h.internals,
            batch.frame,
            [],
            batch.views,
            previous,
          );
          if (shared === undefined) throw new Error('missing Advanced graph');
          sharedGraphs.push(shared);
          passCounts.add(shared.inspect().passes.length);
          h.frameState.frameNumber = frameNumber;
          const input = {
            ...h.input(),
            featurePlan: {
              candidate: {
                plans: view.plans,
                fullscreenEffects: view.fullscreenEffects,
                ...(view.requiresPreparedResourceKey
                  ? { preparedResourceKey: `frame-${frameNumber}` }
                  : {}),
              },
            },
          };
          expect(compileViewGraph(input).kind, `frame ${frameNumber}`).toBe(
            frameNumber === 1 || frameNumber >= 4 ? 'compiled' : 'reused',
          );
          const graph = compileAndAdoptViewGraph(input);
          if (graph === null) throw new Error('missing view graph');
          viewGraphs.add(graph);
          const encoder = h.internals.device.createCommandEncoder().unwrap();
          shared.execute({ encoder, runtime: h.internals }).unwrap();
          if (frameNumber === 2) {
            shared.discardExecution();
            abortFeatureFrame(host);
          } else {
            h.internals.device.queue.submit([encoder.finish().unwrap()]).unwrap();
            shared.commitExecution();
            submitFeatureFrame(host);
            h.accept();
            previous = shared;
          }
        } finally {
          for (const resources of batch.preparedResourceBatches) resources.release().unwrap();
        }
      }
      expect(passCounts.size).toBeGreaterThan(1);
      expect(viewSubmissions).toBe(2);
    } finally {
      for (const graph of [...sharedGraphs, ...viewGraphs]) await graph.retire();
      host.dispose().unwrap();
      gpu.dispose().unwrap();
    }
  });

  it('reuses advancing Fluid payloads and recompiles changed shared texture shape', async () => {
    const h = await harness();
    const hosts: RenderFeatureHost[] = [];
    const graphs = new Set<NonNullable<ReturnType<typeof compileSharedFeatureGraph>>>();
    const makeSource = (resolution: number) => {
      const feature = createWaterFluidFeature({
        contactFoam: { resolution, decayPerSecond: 1, strengthPerMps: 1 },
      });
      const host = createRenderFeatureHost([feature]).unwrap();
      hosts.push(host);
      Object.assign(h.internals, { featureHost: host, canvas: { width: 16, height: 16 } });
      const material = {
        worldIdentity: 'world',
        bodyGuid: 'ocean',
        bodyGeneration: 1,
        materialHandle: 1,
        mapping: { kind: 'mapped' as const, centerXZ: [0, 0] as const, extentM: 16 },
      };
      return (
        frameNumber: number,
        previous?: NonNullable<ReturnType<typeof compileSharedFeatureGraph>>,
      ) => {
        const data: WaterFluidFeatureFrame = {
          kind: 'forgeax-water-fluid-frame',
          sourceFrame: frameNumber,
          simulations: [],
          sourceBlockers: [],
          inspection: [],
          contactFoamBodies: [material],
          contactFoam: {
            worldTimes: [{ worldIdentity: 'world', timeSeconds: frameNumber / 60 }],
            materials: [material],
            roots: [],
            events: [],
          },
        };
        feature
          .plan(data, {
            frame: { frameNumber },
            caps: h.internals.device.caps,
            views: [
              { identity: 'camera:0', render: true, frame: { waterFoamMaterials: [material] } },
            ],
          } as unknown as Parameters<NonNullable<typeof feature.plan>>[1])
          .unwrap();
        const result = {
          plans: [],
          errors: [],
          preparationPending: false,
        } as unknown as RenderFeatureFrameResult;
        const shared = compileSharedFeatureGraph(
          h.internals,
          result,
          [],
          new Map([['camera:0', result]]),
          previous,
        );
        if (shared === undefined) throw new Error('missing Fluid graph');
        graphs.add(shared);
        h.frameState.frameNumber = frameNumber;
        return shared;
      };
    };
    try {
      const advance = makeSource(16);
      const firstShared = advance(1);
      const first = h.compile();
      h.accept();
      advance(2, firstShared);
      expect(compileViewGraph(h.input()).kind).toBe('reused');
      expect(h.compile()).toBe(first);
      expect(h.frameState.graphGeneration).toBe(1);
      makeSource(32)(3);
      expect(compileViewGraph(h.input()).kind).toBe('compiled');
      expect(h.compile()).not.toBe(first);
      expect(h.frameState.graphGeneration).toBe(2);
    } finally {
      const installed = h.frameState.compiledFrameGraph?.graph;
      if (installed !== undefined) await installed.retire();
      for (const graph of graphs) await graph.retire();
      for (const host of hosts) host.dispose().unwrap();
    }
  });

  for (const [kind, prepare] of Object.entries(fixtures)) {
    it(`${kind} matches the in-place compile golden`, async () => {
      const h = await harness();
      const width = prepare(h);
      const before = h.frameState.compiledFrameGraph?.graph;
      const graph = h.compile(width);
      const identity = graph === null ? 'null' : graph === before ? 'installed' : 'replacement';
      expect({ identity, ...observe(h) }).toEqual(GOLDENS[kind as keyof typeof GOLDENS]);
    });
  }

  it('rethrows a failed compile into record recovery after counting the call', async () => {
    const h = await harness();
    h.compile();
    h.accept();
    h.invalidate();
    h.frameState.activePipeline = {
      build: () => {
        throw new Error('injected build throw');
      },
    };
    const outcome = compileViewGraph(h.input());
    expect(outcome.kind).toBe('failed');
    expect(() => h.compile()).toThrow('injected build throw');
    expect(h.frameState.barrelDistortionGraphResolution).toBe('retained');
    expect(getRenderFeatureGraphInspection(h.internals).ensureCalls).toBe(2);
  });
});
