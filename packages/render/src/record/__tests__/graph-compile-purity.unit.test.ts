import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { compileAndAdoptViewGraph } from '../../__tests__/graph-compile.fixture';
import { DeviceScope } from '../../device/device-scope';
import { RhiErrorListenerRegistry } from '../../lifecycle';
import type { RenderPipeline } from '../../render-pipeline';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
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

async function harness() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let failBuild = false;
  const activePipeline: RenderPipeline = {
    build: ({ graph }) => {
      if (failBuild) return { ok: false, error: { code: 'injected-build-failure' } } as never;
      const buffer = graph.createBuffer('purity-bytes', { size: 16 });
      if (!buffer.ok) return buffer;
      return graph.addCopyPass('purity-seed', {
        accesses: [{ resource: buffer.value, usage: 'copy-dst' }],
        encode: () => undefined,
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
