import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { mat4 } from '@forgeax/engine-math';
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
import { createPremultipliedForwardPipeline } from '../../pipeline/standard-forward-output';
import { prepareStandardLighting } from '../../pipeline/standard-lighting/prepare';
import { DEFAULT_STANDARD_PROFILE, standardPipeline } from '../../pipeline/standard-pipeline';
import type { RenderPipeline } from '../../render-pipeline';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
import { createStandardSceneSurfaceAdmission } from '../../temporal/standard-scene-data-admission';
import { createWaterAdvancedFeature } from '../../water/advanced-feature';
import { createWaterFluidFeature, type WaterFluidFeatureFrame } from '../../water/fluid-feature';
import { EMPTY_VIEW_PASS_PLAN } from '../../world/pass-plan-systems';
import type { ViewLights } from '../../world/render-lights';
import type { ReflectionProbeGraphWork } from '../frame-graph-history';
import type { RenderFrameState } from '../frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import { buildFramePostProcessParams } from '../frame-temporal';
import { MaterialBgAssemblyCache } from '../material-bg-assembly-cache';
import type { PipelineState, RenderSystemInternals } from '../render-context';
import type { CubeCaptureGraphWork } from '../target-capture-graph';
import {
  compileViewGraph,
  ensureShadowDepthLayers,
  getRenderFeatureGraphInspection,
  getRenderFeatureGraphState,
  mutableFeatureGraphInspection,
  promoteGraphCandidate,
  rollbackGraphCandidate,
  settleFeatureGraphState,
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
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    meshBindGroupCache: new WeakMap(),
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

it('uses current fullscreen uniforms across graph reuse and retains accepted uniforms on rejection', async () => {
  const h = await harness();
  const id = 'test-ray';
  const defaults = new Uint8Array(16);
  const candidate = (value: number) => ({
    plans: [],
    fullscreenEffects: new Map([
      [
        id,
        {
          source: 'fn fs_main() -> vec4f { return vec4f(1); }',
          params: { byteSize: 16, defaultValue: defaults },
          frameParams: new Uint8Array(16).fill(value),
        },
      ],
    ]),
  });
  const currentParams = (explicit = new Map<string, Uint8Array>()) =>
    buildFramePostProcessParams(
      h.internals,
      h.frameState,
      h.input().camera,
      explicit,
      false,
      0,
      { historyValid: false } as never,
      1,
      undefined,
      getRenderFeatureGraphState(h.internals).fullscreenEffects,
    ).get(id);
  const firstInput = { ...h.input(), featurePlan: { candidate: candidate(1) } };
  const graph = compileAndAdoptViewGraph(firstInput);
  if (!graph) throw new Error('missing view graph');
  try {
    h.accept();
    settleFeatureGraphState(h.internals, true);
    expect(currentParams()?.[0]).toBe(1);
    const secondInput = { ...h.input(), featurePlan: { candidate: candidate(2) } };
    expect(compileViewGraph(secondInput).kind).toBe('reused');
    expect(compileAndAdoptViewGraph(secondInput)).toBe(graph);
    expect(currentParams()?.[0]).toBe(2);
    expect(currentParams(new Map([[id, new Uint8Array(16).fill(7)]]))?.[0]).toBe(7);
    h.accept();
    settleFeatureGraphState(h.internals, true);
    h.setFail(true);
    const rejectedInput = { ...h.input(2), featurePlan: { candidate: candidate(3) } };
    expect(compileViewGraph(rejectedInput).kind).toBe('retained');
    expect(compileAndAdoptViewGraph(rejectedInput)).toBe(graph);
    expect(currentParams()?.[0]).toBe(2);
  } finally {
    await graph.retire();
  }
});

function unlitDisplayGraphInput(h: Harness) {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [],
    view: mat4.identity(mat4.create()),
    projection: mat4.identity(mat4.create()),
    near: 0.1,
    far: 100,
    grid: { x: 1, y: 1, z: 1 },
    lightCount: 256,
    renderPath: 'forward',
  }).unwrap();
  return {
    ...h.input(),
    rendererRecording: true,
    clearOnly: true,
    standardLighting: { kind: 'no-local-lights' as const, prepared },
  };
}

it('records changing Standard exposures and probe faces into the same physical display stages', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false };
  const install = (
    camera: typeof input.camera,
    cubeCaptureState?: Parameters<typeof compileViewGraph>[0]['cubeCaptureState'],
  ) => {
    const graph = compileAndAdoptViewGraph({ ...input, camera, cubeCaptureState });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  const camera = { ...input.camera, tonemap: 'reinhard-extended' as const };
  const first = install(camera);
  try {
    expect(h.frameState.compiledFrameGraph?.displayPorts?.standardPost).toBeDefined();
    const passes = first.inspect().passes.map((pass) => pass.name);
    expect(passes).toContain('forward-display-draws');
    expect(passes).toContain('reflection-probe-filters');
    for (let frame = 0; frame < 60; frame++) {
      const probe = {
        probeIndex: frame % 3,
        step: { faceIndex: frame % 6, mipLevel: frame % 4 },
      } as ReflectionProbeGraphWork;
      const changed = { ...camera, exposure: 1 + frame / 60, whitePoint: 2 + frame / 30 };
      expect(install(changed, { work: [], reflectionProbes: { work: [probe] } })).toBe(first);
    }
    const fxaa = install({ ...camera, antialias: 'fxaa' });
    expect(fxaa).not.toBe(first);
    expect(
      fxaa
        .inspect()
        .passes.map((pass) => pass.name)
        .some((name) => name.includes('fxaa')),
    ).toBe(true);
    const noPost = install({ ...camera, antialias: 'fxaa', postProcessing: false });
    expect(noPost).not.toBe(fxaa);
    h.frameState.installedPipelineConfig = { outputDither: false };
    const undithered = install({ ...camera, postProcessing: false });
    expect(undithered).toBe(noPost);
    for (let frame = 0; frame < 60; frame++) {
      h.frameState.installedPipelineConfig = { outputDither: frame % 2 === 0 };
      expect(install({ ...camera, postProcessing: false })).toBe(noPost);
    }
    h.frameState.activePipeline = createPremultipliedForwardPipeline(
      'rgba16float',
      'external-output',
    );
    expect(install(camera)).not.toBe(undithered);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.standardPost).toBeUndefined();
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it.each([
  'forward',
  'deferred',
] as const)('keeps the %s native output ports through neutral crossings and live camera values', async (renderPath) => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  h.frameState.cameraStandardProfile = { ...DEFAULT_STANDARD_PROFILE, renderPath };
  h.frameState.installedPipelineConfig = { outputContract: 'standard-output-v2' };
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false };
  const install = (frame: number) => {
    const active = frame % 2 !== 0;
    const graph = compileAndAdoptViewGraph({
      ...input,
      camera: {
        ...input.camera,
        tonemap: active ? 'aces-filmic' : 'reinhard-extended',
        exposure: 1 + frame / 80,
        lensEffects: active
          ? {
              vignetteIntensity: 0.5,
              vignetteRadius: 0.5,
              vignetteSoftness: 0.2,
              vignetteColor: [0, 0, 0],
              grainIntensity: 0.2,
              grainSize: 1,
              chromaticAberration: 1 + frame / 80,
              chromaticAberrationStartOffset: 0,
            }
          : undefined,
        output: {
          exposure: { kind: 'manual', multiplier: 1 },
          temperature: active ? 5400 : 6504,
          tint: active ? frame / 80 : 0,
          colorLut: 0,
          colorLutStrength: 0,
        },
      },
    });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  try {
    const first = install(0);
    expect(first.inspect().passes.some((p) => p.name === 'standard-grade')).toBe(true);
    for (let frame = 1; frame <= 60; frame++) expect(install(frame)).toBe(first);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.lane).toBe(renderPath);
    expect(getRenderFeatureGraphInspection(h.internals).compileAttempts).toBe(1);
    Object.assign(h.internals, { observationCaptureDomains: ['linear-ldr', 'final-display'] });
    const captured = install(0);
    expect(captured).not.toBe(first);
    const names = (graph: typeof first) => graph.inspect().passes.map((pass) => pass.name);
    expect(names(captured)).toEqual(
      expect.arrayContaining([
        'standard-grade',
        'standard-encode',
        'linear-ldr-observation',
        'final-display-observation',
      ]),
    );
    expect(names(captured).indexOf('debug-overlay')).toBeGreaterThan(
      names(captured).indexOf('standard-encode'),
    );
    const gradedOverlay = install(1);
    expect(gradedOverlay).not.toBe(captured);
    expect(names(gradedOverlay).indexOf('debug-overlay')).toBeLessThan(
      names(gradedOverlay).indexOf('standard-encode'),
    );
    for (let frame = 3; frame <= 61; frame += 2) expect(install(frame)).toBe(gradedOverlay);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.lane).toBe(renderPath);
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('records Forward AO from the current depth before lighting', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  h.frameState.cameraStandardProfile = DEFAULT_STANDARD_PROFILE;
  h.frameState.standardSceneSurfaceAdmission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'camera:0',
    generation: 0,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'forward',
    contributors: [],
  });
  Object.assign(h.internals, { depthPyramidShaders: { seed: {} } });
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false };
  Object.assign(input.pipelineState, {
    perPassResources: { ssaoScreenPipeline: () => undefined },
  });
  const install = (frame: number, method: 'ssao' | 'gtao', enabled = true, quality = 50) => {
    h.frameState.installedPipelineConfig = {
      ambientOcclusion: {
        enabled,
        method,
        quality,
        intensity: 0.25 + frame / 100,
        radius: 0.2 + frame / 200,
      },
    };
    const graph = compileAndAdoptViewGraph({ ...input, currentGpuCamera: frame % 2 === 0 });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  try {
    for (const method of ['ssao', 'gtao'] as const) {
      const graph = install(1, method);
      expect(h.frameState.compiledFrameGraph?.displayPorts?.lane).toBe('forward');
      const passes = graph.inspect().passes.map((pass) => pass.name);
      const depth = passes.indexOf('standard-scene-surface-data');
      const raw = passes.indexOf('ssao-calc');
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(raw).toBeGreaterThan(depth);
      expect(passes.indexOf('main')).toBeGreaterThan(raw);
      expect(passes).not.toContain('ssao-scene-color');
      for (let frame = 1; frame <= 60; frame++) expect(install(frame, method)).toBe(graph);
      expect(install(61, method, true, 100)).not.toBe(graph);
    }
    const disabled = install(62, 'ssao', false);
    expect(disabled.inspect().passes.map((pass) => pass.name)).not.toContain('ssao-calc');
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('records current GBuffer, light, blended and output stages for an ordinary Deferred view', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  h.frameState.cameraStandardProfile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: 'deferred',
  };
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false };
  const install = (frame: number, gpu: boolean) => {
    h.frameState.installedPipelineConfig = { outputDither: frame % 2 === 0, gpuOcclusion: false };
    const graph = compileAndAdoptViewGraph({
      ...input,
      currentGpuCamera: gpu,
      camera: { ...input.camera, tonemap: 'reinhard-extended', exposure: 1 + frame / 60 },
    });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  try {
    const cpu = install(0, false);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.lane).toBe('deferred');
    const names = cpu.inspect().passes.map((pass) => pass.name);
    expect(names).toContain('g-buffer');
    expect(names).toContain('lighting');
    expect(names.indexOf('lighting')).toBeGreaterThan(names.indexOf('g-buffer'));
    expect(names.indexOf('deferred-display-draws')).toBeGreaterThan(names.indexOf('lighting'));
    for (let frame = 1; frame <= 60; frame++) expect(install(frame, false)).toBe(cpu);
    const selected = install(61, true);
    expect(selected).toBe(cpu);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.geometry).toBe('selection');
    expect(selected.inspect().passes.map((pass) => pass.name)).toContain('camera-gpu-selection');
    for (let frame = 62; frame <= 121; frame++) expect(install(frame, frame % 2 === 0)).toBe(cpu);
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('issues current camera selection and five Bloom levels while the scene and lens values change', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false, currentGpuCamera: true };
  const camera = { ...input.camera, tonemap: 'reinhard-extended' as const, bloom: 'on' as const };
  const install = (bloomIntensity: number, frameNumber: number, currentGpuCamera = true) => {
    const graph = compileAndAdoptViewGraph({
      ...input,
      currentGpuCamera,
      camera: {
        ...camera,
        exposure: 1 + frameNumber / 60,
        bloomIntensity,
        bloomThreshold: 0.5 + frameNumber / 20,
      },
    });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  try {
    const graph = install(1, 0);
    const ports = h.frameState.compiledFrameGraph?.displayPorts;
    expect(ports?.geometry).toBe('selection');
    expect(ports?.standardPost?.bloom).toBe(true);
    expect(typeof h.frameState.compiledFrameGraph?.prepareGpuDrivenPipelines).toBe('function');
    const declared = graph.inspect().passes.map((pass) => pass.name);
    expect(declared).toContain('camera-gpu-selection');
    expect(declared).toContain('forward-display-draws');
    expect(declared.filter((name) => /^bloom-(horizontal|vertical)-/.test(name))).toHaveLength(10);
    for (let frame = 1; frame <= 60; frame++) expect(install(frame / 60, frame)).toBe(graph);
    const withoutBloom = install(0, 61);
    expect(withoutBloom).not.toBe(graph);
    expect(withoutBloom.inspect().passes.some((p) => p.name.startsWith('bloom-'))).toBe(false);
    const direct = install(0, 62, false);
    expect(direct).toBe(withoutBloom);
    for (let frame = 63; frame < 123; frame++)
      expect(install(0, frame, frame % 2 === 0)).toBe(direct);
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('submits changing Forward sun shadows through the physical depth and mask ports', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  h.frameState.cameraStandardProfile = { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' };
  h.internals.standardSceneShaders = {
    forwardDirectionalShadow: 'forward-shadow-program',
  } as NonNullable<RenderSystemInternals['standardSceneShaders']>;
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false, currentGpuCamera: true };
  const install = (frame: number, coverage = true) => {
    h.frameState.cameraStandardProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'forward',
      ...(frame % 2
        ? { forwardShadowViewFade: true, forwardShadowSpotFilter: 'gather' as const }
        : {}),
    };
    const graph = compileAndAdoptViewGraph({
      ...input,
      passPlan: {
        ...EMPTY_VIEW_PASS_PLAN,
        ...(coverage ? { forwardShadowCoverage: true as const } : {}),
      },
      lights: {
        ...input.lights,
        cascades: { cascadeCount: 1 + (frame % 4) } as ViewLights['cascades'],
      },
      shadowMapSize: frame % 2 ? 32 : 16,
    });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  try {
    const first = install(0);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.lane).toBe('forward');
    const passes = first.inspect().passes.map((pass) => pass.name);
    expect(passes).toContain('forward-directional-shadow');
    expect(passes.indexOf('forward-directional-shadow')).toBeLessThan(passes.indexOf('main'));
    const begin = getRenderFeatureGraphInspection(h.internals).compileSuccesses;
    for (let frame = 1; frame <= 60; frame++) {
      expect(install(frame)).toBe(first);
      expect(h.frameState.forwardDisplayReceiver?.mode).toBe('screen');
    }
    expect(getRenderFeatureGraphInspection(h.internals).compileSuccesses).toBe(begin);
    const raw = install(61, false);
    expect(raw).not.toBe(first);
    expect(raw.inspect().passes.some((pass) => pass.name === 'forward-directional-shadow')).toBe(
      false,
    );
    expect(h.frameState.forwardDisplayReceiver).toEqual({ mode: 'raw', reason: 'coverage' });
    expect(
      install(62)
        .inspect()
        .passes.map((pass) => pass.name),
    ).toContain('forward-directional-shadow');
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('keeps ordinary shadow atlas ports while cascade counts, directional size and occupied faces rotate', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  const input = { ...unlitDisplayGraphInput(h), clearOnly: false, currentGpuCamera: true };
  const install = (frame: number, pointSize = 16, owner = input.shadowDepthLayers) => {
    const lights = {
      ...input.lights,
      cascades: { cascadeCount: 1 + (frame % 4) } as ViewLights['cascades'],
      pointShadow: [
        {
          shadowAtlasLayer: frame % 4,
          mapSize: pointSize,
        },
      ] as unknown as ViewLights['pointShadow'],
    };
    const graph = compileAndAdoptViewGraph({
      ...input,
      lights,
      shadowDepthLayers: owner,
      shadowMapSize: frame % 2 ? 32 : 16,
    });
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  try {
    const first = install(0);
    expect(h.frameState.compiledFrameGraph?.displayPorts?.directional).toBe(true);
    expect(h.frameState.compiledFrameGraph?.directionalShadowViewCount).toBe('current');
    expect(first.inspect().passes.map((p) => p.name)).toContain('forward-display-draws');
    for (let frame = 1; frame <= 60; frame++) expect(install(frame)).toBe(first);
    const resized = install(61, 32);
    expect(resized).not.toBe(first);
    const otherOwner = ensureShadowDepthLayers({} as RenderFrameState, h.internals.device);
    expect(install(62, 32, otherOwner)).not.toBe(resized);
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('changes the installed Forward targets when a same-identity output recipe changes', async () => {
  const h = await harness();
  const input = unlitDisplayGraphInput(h);
  const install = (format: 'rgba8unorm' | 'rgba16float', name: string) => {
    h.frameState.activePipeline = createPremultipliedForwardPipeline(format, name);
    const graph = compileAndAdoptViewGraph(input);
    if (graph === null) throw new Error(h.errors.map(String).join('\n'));
    h.accept();
    return graph;
  };
  const first = install('rgba16float', 'first');
  try {
    expect(install('rgba16float', 'first')).toBe(first);
    const second = install('rgba8unorm', 'first');
    expect(second).not.toBe(first);
    expect(install('rgba8unorm', 'second')).not.toBe(second);
  } finally {
    await h.frameState.compiledFrameGraph?.graph.retire();
  }
});

it('keeps the display graph across independent capture target, face and roster changes', async () => {
  const h = await harness();
  h.frameState.activePipeline = standardPipeline;
  const input = unlitDisplayGraphInput(h);
  const graph = compileAndAdoptViewGraph(input);
  if (graph === null) throw new Error(h.errors.map(String).join('\n'));
  h.accept();
  // Capture views own their physical descriptors. The display reads only sampler demand.
  const face = (layer: number) =>
    ({
      physical: { descriptor: { shape: 'cube', size: 64, format: 'rgba8unorm' } },
      layer,
      mipLevel: layer % 2,
      faceCamera: {},
    }) as unknown as CubeCaptureGraphWork;
  try {
    for (const work of [[face(1)], [face(3), face(5)], []]) {
      const change = { ...input, cubeCaptureState: { work } };
      expect(compileViewGraph(change).kind).toBe('reused');
      expect(compileAndAdoptViewGraph(change)).toBe(graph);
      h.accept();
    }
    for (let i = 0; i < 300; i++) {
      const probeIndex = i % 7;
      const probe = {
        probeIndex,
        captureGeneration: i,
        filteredGeneration: i + 1,
        filteredLayer: i % 5,
        step: { probeIndex, mipLevel: Math.floor(i / 3) % 4, faceIndex: (i % 3) * 2 },
      } as ReflectionProbeGraphWork;
      const change = {
        ...input,
        cubeCaptureState: { work: [], reflectionProbes: { work: i % 5 === 0 ? [] : [probe] } },
      };
      expect(compileViewGraph(change).kind).toBe('reused');
      expect(compileAndAdoptViewGraph(change)).toBe(graph);
      h.accept();
    }
  } finally {
    await graph.retire();
  }
});

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
