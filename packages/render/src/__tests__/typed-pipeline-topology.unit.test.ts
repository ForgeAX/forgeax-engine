import { readFileSync } from 'node:fs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { type GraphTextureView, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEPTH_OF_FIELD_PARAMS } from '../features/depth-of-field/depth-of-field-params';
import type { RenderFeaturePlanExecution } from '../features/host';
import { createRenderFeatureProjectionState } from '../features/render-graph-contribution';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { shouldExecuteStandardClusterMembershipPass } from '../pipeline/standard-lighting/graph';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';
import {
  deriveStandardTopologyInput,
  standardLightingTopologySignature,
} from '../pipeline/standard-lighting/topology';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import { CPU_SETUP_SHADER, cpuSetupFixture } from '../record/__tests__/main-pass-cpu-setup-fixture';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import { scenePipelinePreparations } from '../record/scene-pipeline-preparation';
import { standardFeatureContribution } from '../record/standard-feature-contribution';
import {
  isMotionBlurTemporalDemand,
  resolvePostProcessChainAdmission,
} from '../record/typed-frame-graph';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import { createRenderPipelineTarget, resolveOutputDither } from '../render-pipeline';
import { admitSsrSpatial } from '../ssr/admission';
import {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
} from '../temporal/scene-data';
import { standardTemporalPostOrder } from '../temporal/standard-scene-data';
import { type OpaquePassPlan, planOpaque } from '../world/pass-plan-systems';
import { selectTestStandardClusterTransport as selectStandardClusterTransport } from './cluster-test-abi';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

let device: RhiDevice;

type TopologyOverrides = Omit<Partial<RenderPipelineTopology>, 'camera'> & {
  readonly camera?: Partial<RenderPipelineTopology['camera']>;
};

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
});

function topology(
  pipelineId: 'forgeax::standard',
  overrides: TopologyOverrides = {},
): RenderPipelineTopology {
  const { camera: cameraOverride, ...rest } = overrides;
  const planned: Omit<RenderPipelineTopology, 'opaque'> & { opaque?: OpaquePassPlan } = {
    pipelineId,
    config: undefined,
    surface: {
      width: 800,
      height: 600,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: {
      tonemap: 'aces-filmic',
      antialias: 'fxaa',
      bloom: 'on',
      bloomIntensity: 1,
      ...cameraOverride,
    },
    shadow: {
      directional: { mapSize: 1024, cascadeCount: 4 },
      spotMapSize: 1024,
      pointCount: 1,
      pointFaceSize: 512,
      spotCount: 1,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: true,
      maxColorAttachments: 8,
      maxColorAttachmentBytesPerSample: 128,
    },
    featureTopologySignature: 'none',
    gpuDrivenTopologySignature: '',
    ...rest,
  };
  // Fixtures plan the opaque lane exactly as the view's RenderQueue does.
  return {
    ...planned,
    opaque:
      rest.opaque ??
      planOpaque({
        renderPath: (planned.standardProfile ?? DEFAULT_STANDARD_PROFILE).renderPath,
        gpuOcclusion: planned.config?.gpuOcclusion,
        clearOnly: planned.clearOnly === true,
      }),
  };
}

function zeroStandardLighting(caps: { compute: boolean; storageBuffer: boolean }, localCount = 1) {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: Array.from({ length: localCount }, (_, index) => ({
      kind: 'point' as const,
      shadowed: false,
      position: vec3.create(index, 0, -4),
      range: 2,
    })),
    view: mat4.create(),
    projection: mat4.create(),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: DEFAULT_STANDARD_PROFILE.lightCount,
    renderPath: 'forward',
  });
  if (!prepared.ok) throw prepared.error;
  const transport = selectStandardClusterTransport(
    { ...caps, maxTextureDimension2D: 8192, membershipPipelineReady: caps.compute },
    prepared.value,
  );
  if (!transport.ok) return transport;
  return deriveStandardTopologyInput({
    kind: 'clustered',
    prepared: prepared.value,
    transport: transport.value,
  });
}

function noLocalStandardLighting() {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [],
    view: mat4.create(),
    projection: mat4.create(),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: 1,
    renderPath: 'forward',
  });
  if (!prepared.ok) throw prepared.error;
  return deriveStandardTopologyInput({ kind: 'no-local-lights', prepared: prepared.value });
}

function compile(
  pipeline: RenderPipeline,
  input: RenderPipelineTopology,
  projectGpuDriven: (
    graph: RenderGraphBuilder<RenderPipelineFrame>,
  ) => RenderPipelineBuildContext<RenderPipelineFrame>['projectGpuDriven'] = () => () =>
    ok(undefined),
  context:
    | { readonly gtaoExecutionOverride?: 'fragment' | 'compute' }
    | ((
        graph: RenderGraphBuilder<RenderPipelineFrame>,
      ) => Partial<RenderPipelineBuildContext<RenderPipelineFrame>>) = {},
  featureContribution?: (
    graph: RenderGraphBuilder<RenderPipelineFrame>,
  ) => RenderPipelineBuildContext<RenderPipelineFrame>['contributeFeatures'],
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const standardLighting = zeroStandardLighting({
    compute: input.lane.compute,
    storageBuffer: input.lane.storageBuffer,
  });
  if (!standardLighting.ok) return standardLighting;
  const importedHistory =
    input.camera.antialias === 'taa' ? createImportedHistory(graph) : undefined;
  const built = pipeline.build(
    {
      graph,
      standardLighting: standardLighting.value,
      capabilities: { rgba16floatRenderable: true },
      ...(importedHistory === undefined ? {} : { taaHistory: importedHistory }),
      projectGpuDriven: projectGpuDriven(graph),
      contributeFeatures: featureContribution?.(graph) ?? (() => ok(undefined)),
      ...(typeof context === 'function' ? context(graph) : context),
    },
    input,
  );
  if (!built.ok) return built;
  return graph.compile({
    device,
    surfaceSize: { width: input.surface.width, height: input.surface.height },
  });
}

function disabledDirectionalTopology(): RenderPipelineTopology {
  return topology('forgeax::standard', {
    shadow: {
      directional: 'disabled',
      pointCount: 0,
      pointFaceSize: 512,
      spotCount: 0,
    } as unknown as RenderPipelineTopology['shadow'],
  });
}

function disabledDirectionalVolumeTopology(lightKind: 'point' | 'spot'): RenderPipelineTopology {
  return topology('forgeax::standard', {
    shadow: {
      directional: 'disabled',
      spotMapSize: 1024,
      pointCount: 0,
      pointFaceSize: 512,
      spotCount: lightKind === 'spot' ? 1 : 0,
    },
    volumetricFog: {
      enabled: true,
      lightKind,
      lightEntity: 1,
      format: 'rgba8unorm',
      extent: { width: 8, height: 8, depth: 8 },
      froxelExtent: { width: 16, height: 16, depth: 8 },
      resolvedExtent: { width: 8, height: 8, depth: 1 },
    },
  });
}

function createImportedHistory(graph: RenderGraphBuilder<RenderPipelineFrame>) {
  const target = (
    label: string,
    format: 'rgba16float' | 'r8unorm' | 'rgba8unorm' = 'rgba16float',
  ) => {
    const texture = graph.importTexture(
      label,
      { format, size: 'surface', usage: 0x17 },
      (frame) => frame.outputTarget().texture,
    );
    if (!texture.ok) throw texture.error;
    const view = graph.importView(
      texture.value,
      { label: `${label}.view` },
      (frame) => frame.outputTarget().view,
    );
    if (!view.ok) throw view.error;
    return {
      texture: texture.value,
      view: view.value,
      format,
      sampleCount: 1 as const,
    };
  };
  return {
    currentColor: target('taa-history-current-color'),
    previousColor: target('taa-history-previous-color'),
    currentTemporal: target('taa-history-current-temporal'),
    previousTemporal: target('taa-history-previous-temporal'),
    currentStability: target('taa-history-current-stability', 'r8unorm'),
    previousStability: target('taa-history-previous-stability', 'r8unorm'),
    currentFlicker: target('taa-history-current-flicker', 'rgba8unorm'),
    previousFlicker: target('taa-history-previous-flicker', 'rgba8unorm'),
  };
}

describe('typed built-in pipeline topology', () => {
  it.each([
    'forward',
    'deferred',
  ] as const)('compiles native scene contribution through the real Standard %s pipeline', async (renderPath) => {
    const input = topology('forgeax::standard', {
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath, ssao: true },
      config: { ssao: { enabled: true } },
      camera: { antialias: 'taa' },
      shadow: {
        directional: { mapSize: 1024, cascadeCount: 3 },
        spotMapSize: 1024,
        spotCount: 0,
        pointFaceSize: 512,
        pointCount: 0,
      },
    });
    // The same real Standard topology without a native contribution must compile.
    const ordinary = compile(standardPipeline, input);
    expect(ordinary.ok).toBe(true);
    if (ordinary.ok) await ordinary.value.retire();
    const execution: RenderFeaturePlanExecution = {
      featureIdentity: 'test.standard-native-view',
      scope: 'view:main',
      order: 0,
      placement: 'scene',
      passes: [],
    };
    const compiled = compile(standardPipeline, input, undefined, {}, (builder) =>
      standardFeatureContribution({
        // No shader/binding execution is needed to test the actual graph ports.
        internals: { device } as RenderSystemInternals,
        frameState: { frameNumber: 1 } as RenderFrameState,
        builder,
        projectedFeaturePlans: [execution],
        featurePostProcessEntries: new Map(),
        fullscreenFeatureIds: new Set(),
        featureProjection: createRenderFeatureProjectionState(),
        sceneDataDepthViews: new Map(),
        transientViews: new Set([execution.featureIdentity]),
        transientSlots: new Map(),
        sceneInputs: undefined,
        surfaceSize: { width: input.surface.width, height: input.surface.height },
        reportError: (error) => {
          throw error;
        },
      }),
    );
    if (!compiled.ok)
      console.info(
        '[standard-native-scene-compile]',
        JSON.stringify({
          renderPath,
          code: compiled.error.code,
          expected: compiled.error.expected,
          detail: 'detail' in compiled.error ? compiled.error.detail : undefined,
        }),
      );
    expect(compiled.ok).toBe(true);
    if (compiled.ok) await compiled.value.retire();
  });
  it('builds the actual Forward 4x normal producer with its own vertex and single-target depth contract', async () => {
    let builtGraph: RenderGraphBuilder<RenderPipelineFrame> | undefined;
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', { camera: { antialias: 'msaa' }, water: true }),
      undefined,
      (graph) => {
        builtGraph = graph;
        return {};
      },
    ).unwrap();
    if (builtGraph === undefined) throw new Error('missing Standard graph');
    const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
    const fixture = cpuSetupFixture(device, module);
    const entry = fixture.add({ entity: 1, submeshes: 1 });
    entry.source.material.adopt({
      ...entry.source.material.snapshot,
      renderState: { alphaToCoverageEnabled: true },
    });
    Object.assign(entry.source, {
      pipelinePreparation: [
        {
          materialHandle: 7,
          passIndex: 0,
          tags: { LightMode: 'Forward' },
          materialShaderId: entry.source.material.snapshot.materialShaderId,
          vertexEntry: 'vs_main',
          fragmentEntry: 'fs_main',
        },
      ],
    });
    Object.assign(fixture.c, { pipelinePreparationEntries: [entry] });
    fixture.acceptMaterials();
    const lookup = vi.spyOn(fixture.c.runtime, 'getMaterialShaderPipelineEntry');
    const descriptors: import('@forgeax/engine-rhi').RenderPipelineDescriptor[] = [];
    try {
      for (const prepare of scenePipelinePreparations(builtGraph)) prepare(fixture.c, new Map());
      const request = lookup.mock.calls.find((args) => args[19] === 'fs_ao_input_msaa');
      if (request === undefined) throw new Error('missing actual normal producer request');
      const built = buildPipelineForMaterialShader(
        request[0],
        {
          source: `
            struct VsOut { @builtin(position) position: vec4<f32>, @location(0) normal: vec3<f32> }
            @vertex fn vs_main() -> VsOut { return VsOut(vec4<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0)); }
            @vertex fn vs_temporal() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
            @fragment fn fs_temporal() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }
            @fragment fn fs_ao_input_msaa(input: VsOut) -> @location(0) vec4<u32> { return vec4<u32>(vec3<u32>(input.normal), 1u); }
          `,
          paramSchema: [],
        },
        {
          device,
          createRenderPipeline: (descriptor) => {
            descriptors.push(descriptor);
            return device.createRenderPipeline(descriptor);
          },
          shaderModuleFactory: { createShaderModule: () => ok(module) },
          pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
          colorFormat: request[9] ?? 'rgba8uint',
          colorFormats: [request[9] ?? 'rgba8uint', ...(request[17] ?? [])],
          depthFormat: 'depth32float-stencil8',
          vertexBuffers: [],
        },
        request[2],
        undefined,
        request[18],
        request[19],
        undefined,
        request[6],
        request[8],
      );
      expect(built.ok, built.ok ? undefined : built.error.message).toBe(true);
      expect(request[6]).toBe('forward');
      expect(descriptors).toEqual([
        expect.objectContaining({
          vertex: expect.objectContaining({ entryPoint: 'vs_main' }),
          fragment: expect.objectContaining({
            entryPoint: 'fs_ao_input_msaa',
            targets: [{ format: 'rgba8uint', writeMask: 15 }],
          }),
          depthStencil: expect.objectContaining({
            depthWriteEnabled: false,
            depthCompare: 'greater-equal',
          }),
          multisample: { count: 4 },
        }),
      ]);
    } finally {
      lookup.mockRestore();
      fixture.dispose();
      await compiled.retire();
    }
  });
  it.each([
    false,
    true,
  ])('keeps matched opaque samples through the real 4x Water/Fog caller (underwater=%s)', (underwater) => {
    const ssr = admitSsrSpatial({
      camera: {
        projection: 'perspective',
        near: 0.1,
        far: 100,
        screenSpaceReflection: {
          waterTemporal: 0,
          maxDistance: 12,
          thickness: 0.2,
          maxRoughness: 0.65,
        },
      },
      environment: {
        lane: 'forward',
        pairedMsaaSurface: true,
        m0: { status: 'admitted' },
        sceneInputs: true,
        temporal: true,
        reflectionFallback: true,
        capabilities: {
          compute: true,
          storageTexture: true,
          rgba16floatRenderable: true,
          r32floatSampledStorage: true,
        },
      },
    });
    expect(ssr.status).toBe('admitted');
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { antialias: 'msaa', bloom: 'off' },
        water: true,
        waterView: { kind: 'available', underwater },
        analyticFog: true,
        unfoggedOpaque: true,
        reflectionFallback: { enabled: true },
        ssr,
      }),
    ).unwrap();
    const info = compiled.inspect();
    const names = info.passes.map((pass) => pass.name);
    const pass = (name: string) => info.passes.find((entry) => entry.name === name);
    const resource = (label: string) => info.resources.find((entry) => entry.label === label);
    for (const label of [
      'scene-color-msaa',
      'scene-depth',
      'water-opaque-normal-msaa',
      'water-opaque-temporal-msaa',
    ]) {
      expect(resource(label)?.descriptor).toMatchObject({ sampleCount: 4 });
    }
    expect(resource('water-opaque-normal-msaa')?.descriptor).toMatchObject({
      format: 'rgba8uint',
      sampleCount: 4,
    });
    expect(resource('water-opaque-normal')?.descriptor).toMatchObject({ format: 'r32uint' });
    for (const label of [
      'water-opaque-selected-sample',
      'water-opaque-normal',
      'standard-scene-temporal',
      'water-opaque-raw-depth',
      'water-opaque-depth',
      'water-opaque-nearest-color',
      'water-prepass-depth',
      'water-slw-optics-hdr',
    ]) {
      expect(resource(label)?.descriptor).toMatchObject({ sampleCount: 1 });
    }
    expect(resource('water-opaque-depth')?.descriptor).toMatchObject({
      format: 'depth32float-stencil8',
    });
    expect(names.filter((name) => name === 'water-opaque-msaa-surface-resolve')).toHaveLength(1);
    expect(names).not.toContain('g-buffer');
    expect(names.indexOf('analytic-fog')).toBeGreaterThan(names.indexOf('main'));
    expect(names.indexOf('main-unfogged')).toBeGreaterThan(names.indexOf('analytic-fog'));
    expect(names.indexOf('water-opaque-msaa-surface-resolve')).toBeGreaterThan(
      names.indexOf('main-unfogged'),
    );
    expect(pass('analytic-fog')?.accesses).toContainEqual({
      resource: 'scene-color-msaa',
      usage: 'color-attachment',
    });
    expect(pass('analytic-fog')?.accesses).toContainEqual({
      resource: 'scene-color',
      usage: 'color-attachment',
    });
    expect(pass('water-opaque-msaa-surface-resolve')?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'scene-depth', usage: 'sampled-read' },
        { resource: 'water-opaque-normal-msaa', usage: 'sampled-read' },
        { resource: 'water-opaque-temporal-msaa', usage: 'sampled-read' },
        { resource: 'water-opaque-depth', usage: 'depth-stencil-write' },
      ]),
    );
    const gather = pass('water-opaque-msaa-color-resolve');
    expect(gather?.accesses).toContainEqual({
      resource: 'water-opaque-selected-sample',
      usage: 'sampled-read',
    });
    expect(gather?.accesses).toContainEqual({
      resource: 'scene-color-msaa',
      usage: 'sampled-read',
    });
    expect(gather?.accesses.some((access) => access.resource.includes('depth'))).toBe(false);
    expect(names.indexOf('water-opaque-msaa-surface-resolve')).toBeLessThan(
      names.indexOf('transparent'),
    );
    expect(names.indexOf('analytic-fog')).toBeLessThan(names.indexOf('transparent'));
    if (underwater) {
      expect(pass('transparent')?.accesses).toContainEqual({
        resource: 'scene-color-msaa',
        usage: 'color-attachment',
      });
      expect(names.indexOf('transparent')).toBeLessThan(
        names.indexOf('water-opaque-msaa-color-resolve'),
      );
    } else {
      expect(pass('transparent')?.accesses).toContainEqual({
        resource: 'scene-color',
        usage: 'color-attachment',
      });
      expect(names.indexOf('transparent')).toBeGreaterThan(
        names.indexOf('water-reflection-composite'),
      );
    }
    expect(names.indexOf('water-opaque-msaa-color-resolve')).toBeLessThan(
      names.indexOf('water-no-water-color-copy'),
    );
    expect(pass('water-no-water-color-copy')?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'water-opaque-nearest-color', usage: 'copy-src' },
        { resource: 'scene-color', usage: 'copy-src' },
        { resource: 'water-no-water-color-hdr', usage: 'copy-dst' },
        { resource: 'water-no-water-display-hdr', usage: 'copy-dst' },
      ]),
    );
    expect(pass('water-slw-inner-color')?.accesses).toContainEqual({
      resource: 'water-no-water-color-hdr',
      usage: 'sampled-read',
    });
    expect(pass('water-reflection-composite')?.accesses).toContainEqual({
      resource: 'water-no-water-display-hdr',
      usage: 'sampled-read',
    });
    expect(names).toContain('water-ssr-trace');
    expect(pass('water-ssr-trace')?.accesses).toContainEqual({
      resource: 'water-opaque-normal',
      usage: 'sampled-read',
    });
    expect(pass('water-ssr-trace')?.accesses).toContainEqual({
      resource: 'water-no-water-depth',
      usage: 'sampled-read',
    });
  });
  it('snapshots no-TAA HDR after actual DoF and before Motion Blur and Bloom in the Standard caller', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: {
          antialias: 'none',
          depthOfField: { blurSide: 'both', useNear: true, useFar: true },
        },
        temporal: { taa: false, motionBlur: true },
      }),
      undefined,
      (graph) => ({
        camera: { depthOfField: DEFAULT_DEPTH_OF_FIELD_PARAMS },
        ssrSceneColorOutput: createRenderPipelineTarget(graph, 'ssr-color-output', {
          format: 'rgba16float',
          size: 'surface',
          domain: 'linear-hdr',
        }).unwrap(),
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const focus = names.indexOf('dof-composite');
    const snapshot = names.indexOf('ssr-scene-color-history');
    const motion = names.indexOf('motion-blur');
    const bloom = names.findIndex((name) => name.startsWith('bloom-'));
    expect(focus).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(focus);
    expect(motion).toBeGreaterThan(snapshot);
    expect(bloom).toBeGreaterThan(motion);
    const saved = info.passes[snapshot];
    expect(saved?.accesses).toContainEqual({ resource: 'dof-composite', usage: 'sampled-read' });
    expect(saved?.accesses).toContainEqual({
      resource: 'ssr-color-output',
      usage: 'color-attachment',
    });
    expect(info.passes[motion]?.accesses).toContainEqual({
      resource: 'dof-composite',
      usage: 'sampled-read',
    });
  });
  it('routes generic post writers to the current DoF result consumed by Bloom', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: {
          antialias: 'none',
          depthOfField: { blurSide: 'both', useNear: true, useFar: true },
        },
      }),
      undefined,
      (graph) => ({
        camera: { depthOfField: DEFAULT_DEPTH_OF_FIELD_PARAMS },
        contributeFeatures: (projection) => {
          if (projection.placement !== undefined) return ok(undefined);
          const color = projection.targets.find((target) => target.kind === 'scene-color');
          if (color === undefined) throw new Error('missing current post target');
          return graph.addRasterPass('generic-post-writer', {
            accesses: [{ resource: color.view, usage: 'color-attachment' }],
            colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
            encodeDirect: () => {},
          });
        },
      }),
    ).unwrap();
    const info = compiled.inspect();
    expect(info.passes.find((pass) => pass.name === 'generic-post-writer')?.accesses).toEqual([
      { resource: 'dof-composite', usage: 'color-attachment' },
    ]);
    const names = info.passes.map((pass) => pass.name);
    expect(names.indexOf('generic-post-writer')).toBeGreaterThan(names.indexOf('dof-composite'));
    expect(names.indexOf('bloom-horizontal-0')).toBeGreaterThan(
      names.indexOf('generic-post-writer'),
    );
  });
  it('defaults final output dither on and accepts an asset-level opt-out', () => {
    expect(resolveOutputDither(undefined)).toBe(true);
    expect(resolveOutputDither({})).toBe(true);
    expect(resolveOutputDither({ outputDither: true })).toBe(true);
    expect(resolveOutputDither({ outputDither: false })).toBe(false);
  });

  it('omits every Directional shadow graph resource and pass when disabled', () => {
    const compiled = compile(standardPipeline, disabledDirectionalTopology());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.resources.some((resource) => resource.label === 'directional-shadow-depth')).toBe(
      false,
    );
    expect(
      info.passes.some(
        (pass) =>
          pass.name.startsWith('shadowCascade') || pass.name === 'directional-shadow-observation',
      ),
    ).toBe(false);
    const main = info.passes.find((pass) => pass.name === 'main');
    expect(main?.accesses.some((access) => access.resource === 'directional-shadow-depth')).toBe(
      false,
    );
  });

  it('falsifies a test-only shadow-off topology that still builds a Directional pass', () => {
    const compiled = compile(standardPipeline, disabledDirectionalTopology());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const count = compiled.value
      .inspect()
      .passes.filter(
        (pass) =>
          pass.name.startsWith('shadowCascade') || pass.name === 'directional-shadow-observation',
      ).length;
    const expected = process.env.FALSIFY === 'shadow-off-still-builds-pass' ? 1 : 0;
    expect(count).toBe(expected);
  });

  it.each([
    'point',
    'spot',
  ] as const)('keeps %s volumetric fog graphable when directional shadows are disabled', (lightKind) => {
    const compiled = compile(standardPipeline, disabledDirectionalVolumeTopology(lightKind));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.resources.some((resource) => resource.label === 'directional-shadow-depth')).toBe(
      false,
    );
    expect(info.passes.some((pass) => pass.name === 'volume-inject')).toBe(true);
    expect(
      info.passes.some(
        (pass) =>
          pass.name.startsWith('shadowCascade') || pass.name === 'directional-shadow-observation',
      ),
    ).toBe(false);
  });

  it('derives topology only from prepared transport facts', () => {
    const frame: StandardLightFrame = {
      directional: undefined,
      local: [{ kind: 'point', shadowed: false, position: vec3.create(0, 0, -4), range: 2 }],
      view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
      projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 32,
      renderPath: 'forward',
    };
    const prepared = prepareStandardLighting(frame);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const transport = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      prepared.value,
    );
    expect(transport.ok).toBe(true);
    if (!transport.ok) return;
    const derived = deriveStandardTopologyInput({
      prepared: prepared.value,
      kind: 'clustered',
      transport: transport.value,
    });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value.kind).toBe('clustered');
    if (derived.value.kind !== 'clustered') return;
    expect(derived.value.transport.kind).toBe('compute-storage');
    expect(derived.value.prepared).toBe(prepared.value);
  });

  it('admits the complete local-light corpus through the no-storage texture transport', () => {
    const make = (count: number, kind: 'point' | 'spot' = 'point', shadowed = false) => {
      const prepared = prepareStandardLighting({
        directional: undefined,
        local: Array.from({ length: count }, (_, index) => ({
          kind,
          shadowed,
          position: vec3.create(index, 0, -4),
          range: 2,
        })),
        view: mat4.create(),
        projection: mat4.create(),
        near: 0.1,
        far: 100,
        grid: { x: 4, y: 3, z: 4 },
        lightCount: 32,
        renderPath: 'forward',
      });
      if (!prepared.ok) throw prepared.error;
      const transport = selectStandardClusterTransport(
        {
          compute: false,
          storageBuffer: false,
          maxTextureDimension2D: 4096,
          membershipPipelineReady: false,
        },
        prepared.value,
      );
      if (!transport.ok) throw transport.error;
      return deriveStandardTopologyInput({
        kind: 'clustered',
        prepared: prepared.value,
        transport: transport.value,
      });
    };
    expect(make(1).ok).toBe(true);
    expect(make(4).ok).toBe(true);
    expect(make(0).ok).toBe(true);
    expect(make(5).ok).toBe(true);
    expect(make(1, 'spot').ok).toBe(true);
    expect(make(1, 'point', true).ok).toBe(true);
    const one = make(1);
    const four = make(4);
    if (!one.ok || !four.ok) return;
    expect(standardLightingTopologySignature(one.value)).toBe(
      standardLightingTopologySignature(four.value),
    );
  });

  it('keeps graph identity stable for per-frame light movement and count changes', () => {
    const make = (localCount: number) => {
      const prepared = prepareStandardLighting({
        directional: undefined,
        local: Array.from({ length: localCount }, (_, index) => ({
          kind: index % 2 === 0 ? ('point' as const) : ('spot' as const),
          shadowed: false,
          position: vec3.create(index, 0, -4),
          range: 2,
        })),
        view: mat4.create(),
        projection: mat4.create(),
        near: 0.1,
        far: 100,
        grid: { x: 4, y: 3, z: 4 },
        lightCount: 32,
        renderPath: 'forward',
      });
      if (!prepared.ok) throw prepared.error;
      const transport = selectStandardClusterTransport(
        { compute: true, storageBuffer: true, membershipPipelineReady: true },
        prepared.value,
      );
      if (!transport.ok) throw transport.error;
      const input = deriveStandardTopologyInput({
        kind: 'clustered',
        prepared: prepared.value,
        transport: transport.value,
      });
      if (!input.ok) throw input.error;
      return input.value;
    };
    expect(standardLightingTopologySignature(make(1))).toBe(
      standardLightingTopologySignature(make(2)),
    );
    const empty = noLocalStandardLighting();
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(standardLightingTopologySignature(make(1))).not.toBe(
      standardLightingTopologySignature(empty.value),
    );
    expect(standardLightingTopologySignature(undefined)).not.toBe(
      standardLightingTopologySignature(empty.value),
    );
  });

  it('keeps the clustered graph and ABI stable across local-light 1 to 0 to 1', () => {
    const capabilities = { compute: true, storageBuffer: true };
    const one = zeroStandardLighting(capabilities, 1);
    const zero = zeroStandardLighting(capabilities, 0);
    const oneAgain = zeroStandardLighting(capabilities, 1);
    expect(one.ok && zero.ok && oneAgain.ok).toBe(true);
    if (!one.ok || !zero.ok || !oneAgain.ok) return;
    expect(one.value.kind).toBe('clustered');
    expect(zero.value.kind).toBe('clustered');
    expect(oneAgain.value.kind).toBe('clustered');
    expect(standardLightingTopologySignature(zero.value)).toBe(
      standardLightingTopologySignature(one.value),
    );
    expect(standardLightingTopologySignature(oneAgain.value)).toBe(
      standardLightingTopologySignature(one.value),
    );

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: zero.value,
        capabilities: { rgba16floatRenderable: true },
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      topology('forgeax::standard', {
        shadow: {
          directional: 'disabled',
          pointCount: 0,
          pointFaceSize: 512,
          spotCount: 0,
        } as unknown as RenderPipelineTopology['shadow'],
        camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const compiled = graph.compile({ device, surfaceSize: { width: 800, height: 600 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.passes.map((pass) => pass.name)).toContain('cluster-membership-producer');
    expect(info.resources.map((resource) => resource.label)).toContain('hdrp-light-data');
  });

  it('evaluates Cluster membership from the current frame, not graph-build light count', () => {
    const one = zeroStandardLighting({ compute: true, storageBuffer: true }, 1);
    const zero = zeroStandardLighting({ compute: true, storageBuffer: true }, 0);
    expect(one.ok && zero.ok).toBe(true);
    if (!one.ok || !zero.ok) return;
    const asFrame = (standardLighting: typeof one.value) =>
      ({ standardLighting }) as unknown as RenderPipelineFrame;
    expect(shouldExecuteStandardClusterMembershipPass(asFrame(zero.value))).toBe(false);
    expect(shouldExecuteStandardClusterMembershipPass(asFrame(one.value))).toBe(true);
    expect(shouldExecuteStandardClusterMembershipPass(asFrame(zero.value))).toBe(false);
  });

  it('rejects raw capability and light data at the topology adapter boundary', () => {
    const empty = zeroStandardLighting({ compute: true, storageBuffer: true });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.kind).toBe('clustered');
    if (empty.value.kind !== 'clustered') return;
    const derived = deriveStandardTopologyInput({
      kind: 'clustered',
      prepared: empty.value.prepared,
      transport: empty.value.transport,
      lights: [],
    } as unknown as Parameters<typeof deriveStandardTopologyInput>[0]);
    expect(derived.ok).toBe(false);
    if (derived.ok) return;
    expect(derived.error.code).toBe('topology-input-invalid');
  });

  it('accepts an explicit no-local topology without allocating Cluster resources', () => {
    const standardLighting = noLocalStandardLighting();
    expect(standardLighting.ok).toBe(true);
    if (!standardLighting.ok) return;
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: standardLighting.value,
        capabilities: { rgba16floatRenderable: false },
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      topology('forgeax::standard', {
        lane: { compute: false, storageBuffer: false, multisample: false, maxColorAttachments: 4 },
        camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const compiled = graph.compile({ device, surfaceSize: { width: 800, height: 600 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.passes.map((pass) => pass.name)).not.toContain('cluster-membership-producer');
    expect(info.resources.map((resource) => resource.label)).not.toContain('hdrp-light-data');
  });
  it('declares explicit output target domain and avoids alternate sRGB views', () => {
    const source = readFileSync(new URL('../render-pipeline.ts', import.meta.url), 'utf8');
    const postChainSource = readFileSync(
      new URL('../pipeline/standard-post.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('domain');
    expect(source).toContain("'display-encoded'");
    expect(postChainSource).toContain("'rgba16float'");
    expect(source).not.toContain('viewFormats: [topology.surface.viewFormat]');
  });

  it('forwards the output dither override into the fullscreen UBO write', () => {
    const typedSource = readFileSync(
      new URL('../typed-render-graph-primitives.ts', import.meta.url),
      'utf8',
    );
    const dispatcherSource = readFileSync(
      new URL('../render-graph-primitives.ts', import.meta.url),
      'utf8',
    );
    const fxaaOwnerSource = readFileSync(
      new URL('../record/skybox-post-pass.ts', import.meta.url),
      'utf8',
    );
    const standardPostSource = readFileSync(
      new URL('../pipeline/standard-post.ts', import.meta.url),
      'utf8',
    );
    expect(typedSource).toMatch(
      /paramsOverride:\s*options\.paramsTransform\(\s*frame\.postProcessParams\.get\(options\.shader\),\s*frame,\s*resources,?\s*\)/,
    );
    expect(dispatcherSource).toContain('paramsOverride?: Uint8Array');
    expect(dispatcherSource).toContain(
      'const data = paramsOverride ?? ctx.postProcessParams.get(shader);',
    );
    expect(dispatcherSource).toContain('input.paramsOverride,');
    expect(fxaaOwnerSource).toContain('paramsOverride?.byteLength === 16');
    expect(fxaaOwnerSource).toContain(
      'resolveOutputDither(c.frameState.installedPipelineConfig) ? 1 : 0',
    );
    expect(standardPostSource).toContain('paramsTransform: (): Uint8Array => new Uint8Array(16)');
    expect(standardPostSource).toContain('dither: outputDither');
  });

  it('keeps the admitted LUT topology linear until the single encoding writer', () => {
    const source = readFileSync(new URL('../pipeline/standard-post.ts', import.meta.url), 'utf8');
    const tone = source.indexOf("name: 'standard-tone'");
    const lut = source.indexOf("'standard-color-lut'");
    const fxaa = source.indexOf("name: 'fxaa'");
    const encoding = source.indexOf("name: 'standard-output-encoding'");
    expect(tone).toBeGreaterThanOrEqual(0);
    expect(lut).toBeGreaterThan(tone);
    expect(fxaa).toBeGreaterThan(lut);
    expect(encoding).toBeGreaterThan(fxaa);
    expect(source).toContain("fragmentEntryPoint: 'fs_tone_only'");
    expect(source).toContain("fragmentEntryPoint: 'fs_encode_only'");
    expect(source).toContain("domain: 'linear-ldr'");
    expect(source).toMatch(/\{\s*dither: false,?\s*\}/);
  });

  it('declares stable JSON-safe output and observation inspection facts', () => {
    const source = readFileSync(new URL('../render-contract.ts', import.meta.url), 'utf8');
    for (const field of [
      'outputTransform',
      'displayEncoded',
      'intermediateFormat',
      'surfaceStorage',
      'surfaceDisplay',
      'endpoint',
      'capability',
      'observationId',
      'frameId',
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toContain('readonly output: RenderOutputInspection;');
    expect(source).not.toContain('pixelPayload');
  });

  it('orders HDRP compute, g-buffer, shadow, SSAO, lighting, forward, observation, and output work', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred', ssao: true },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const ordered = [
      'cluster-membership-producer',
      // Deferred shadows follow the g-buffer so final casters can test the
      // camera depth pyramid the g-buffer phases produce.
      'g-buffer',
      'shadowCascade0',
      'directional-shadow-observation',
      'ssao-calc',
      'ssao-blur',
      'lighting',
      'forward',
      'linear-hdr-observation',
      'output-transform',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(names.indexOf(ordered[index] ?? '')).toBeGreaterThan(
        names.indexOf(ordered[index - 1] ?? ''),
      );
    }
    expect(names.filter((name) => /^point-shadow-\d+-\d+$/.test(name))).toHaveLength(6);
    expect(names.filter((name) => name.startsWith('shadowCascade'))).toHaveLength(4);
    expect(names).toContain('directional-shadow-observation');
    expect(names).toContain('linear-hdr-observation');

    const membership = info.passes.find((pass) => pass.name === 'cluster-membership-producer');
    expect(membership?.kind).toBe('compute');
    expect(membership?.accesses).toContainEqual({
      resource: 'hdrp-light-index-list',
      usage: 'storage-write',
    });
    const lighting = info.passes.find((pass) => pass.name === 'lighting');
    expect(lighting?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'gbuffer-normal-roughness', usage: 'sampled-read' },
        { resource: 'gbuffer-albedo-metallic', usage: 'sampled-read' },
        { resource: 'gbuffer-f0-occlusion', usage: 'sampled-read' },
        { resource: 'gbuffer-lighting-context', usage: 'sampled-read' },
        { resource: 'hdrp-depth', usage: 'sampled-read' },
        { resource: 'ssao-blurred', usage: 'sampled-read' },
        { resource: 'hdrp-scene-color', usage: 'color-attachment' },
      ]),
    );
  });

  it('produces Forward AO from a depth-only prepass on the no-storage lane', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward', ssao: true },
        lane: {
          compute: false,
          storageBuffer: false,
          multisample: false,
          maxColorAttachments: 1,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names.indexOf('standard-scene-surface-data')).toBeLessThan(names.indexOf('ssao-calc'));
    expect(names.indexOf('ssao-calc')).toBeLessThan(names.indexOf('ssao-blur'));
    expect(names.indexOf('ssao-blur')).toBeLessThan(names.indexOf('ssao-cluster-pack'));
    expect(names.indexOf('ssao-cluster-pack')).toBeLessThan(names.indexOf('main'));
    // AO is the only prepass consumer: depth only, normals reconstructed from it.
    expect(info.passes.find((pass) => pass.name === 'ssao-calc')?.accesses).toEqual([
      { resource: 'standard-scene-surface-depth', usage: 'sampled-read' },
      { resource: 'ssao-raw', usage: 'color-attachment' },
    ]);
    expect(
      info.passes.find((pass) => pass.name === 'standard-scene-surface-data')?.accesses,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ usage: 'color-attachment' })]));
    expect(info.passes.find((pass) => pass.name === 'ssao-cluster-pack')?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'ssao-blurred', usage: 'sampled-read' },
        { resource: 'standard-cluster-tables', usage: 'color-attachment' },
      ]),
    );
    expect(
      info.resources.find((resource) => resource.label === 'standard-scene-surface-normal'),
    ).toBeUndefined();
    const depthResource = info.resources.find(
      (resource) => resource.label === 'standard-scene-surface-depth',
    );
    expect(depthResource?.derivedUsage).toBeDefined();
    expect((depthResource?.derivedUsage ?? 0) & GPU_TEXTURE_USAGE_COPY_SRC).toBe(0);
  });

  it.each([
    'contact',
    'capsules',
    'decals',
    'ssr',
    'scene-data-normal',
    'scene-data-depth',
    'compute-gtao',
  ] as const)('keeps the Forward prepass normal when %s also reads it beside AO', (reader) => {
    const ssr =
      reader === 'ssr'
        ? admitSsrSpatial({
            camera: {
              projection: 'perspective',
              near: 0.1,
              far: 100,
              screenSpaceReflection: {
                maxDistance: 12,
                thickness: 0.2,
                maxRoughness: 0.65,
                waterTemporal: 0,
              },
            },
            environment: {
              lane: 'forward',
              m0: { status: 'admitted' },
              sceneInputs: true,
              temporal: true,
              reflectionFallback: true,
              capabilities: {
                compute: true,
                storageTexture: true,
                rgba16floatRenderable: true,
                r32floatSampledStorage: true,
              },
            },
          })
        : undefined;
    if (ssr !== undefined) expect(ssr.status).toBe('admitted');
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward', ssao: true },
        config: { ssao: { enabled: true } },
        ...(reader === 'contact' ? { forwardContactShadows: true } : {}),
        ...(reader === 'capsules' ? { forwardCapsuleShadows: true } : {}),
        ...(reader === 'decals' ? { projectedDecals: [[]] } : {}),
        ...(ssr === undefined
          ? {}
          : {
              ssr,
              reflectionFallback: { enabled: true },
              camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
            }),
        ...(reader === 'scene-data-normal'
          ? {
              sceneDataBindings: [
                { schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA, owners: [] },
              ],
            }
          : {}),
        ...(reader === 'scene-data-depth'
          ? {
              sceneDataBindings: [
                { schema: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA, owners: [] },
              ],
            }
          : {}),
      }),
      undefined,
      reader === 'compute-gtao' ? { gtaoExecutionOverride: 'compute' } : {},
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(
      info.passes.find((pass) => pass.name === 'standard-scene-surface-data')?.accesses,
    ).toContainEqual({ resource: 'standard-scene-surface-normal', usage: 'color-attachment' });
    expect(
      info.resources.find((resource) => resource.label === 'standard-scene-surface-normal'),
    ).toBeDefined();
  });

  it('omits disabled Forward AO and keeps material-normal inputs independent of MSAA', () => {
    const plain = compile(standardPipeline, topology('forgeax::standard'));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const names = plain.value.inspect().passes.map((pass) => pass.name);
    for (const name of ['ssao-calc', 'ssao-blur']) expect(names).not.toContain(name);
    // Forward keeps its depth prepass without AO (UE ShouldForceFullDepthPass).
    expect(names.indexOf('standard-scene-surface-data')).toBeLessThan(names.indexOf('main'));

    const msaa = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward', ssao: true },
        camera: { antialias: 'msaa' },
      }),
    );
    expect(msaa.ok).toBe(true);
    if (!msaa.ok) return;
    const passes = msaa.value.inspect().passes.map((pass) => pass.name);
    expect(passes.filter((name) => name === 'ssao-calc')).toHaveLength(1);
    expect(passes.indexOf('standard-scene-surface-data')).toBeLessThan(passes.indexOf('main'));
    expect(passes).not.toContain('g-buffer');
    expect(passes).not.toContain('forward-ao-composite');
  });

  it('seeds single-sample Forward main depth from the surface-data prepass', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward', ssao: true },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const seed = names.indexOf('forward-depth-seed');
    expect(seed).toBeGreaterThan(names.indexOf('standard-scene-surface-data'));
    expect(seed).toBeLessThan(names.indexOf('main'));
    expect(info.passes[seed]?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'standard-scene-surface-depth', usage: 'sampled-read' },
        { resource: 'scene-depth', usage: 'depth-stencil-write' },
      ]),
    );

    const msaa = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward', ssao: true },
        camera: { antialias: 'msaa' },
      }),
    );
    expect(msaa.ok).toBe(true);
    if (!msaa.ok) return;
    expect(msaa.value.inspect().passes.map((pass) => pass.name)).not.toContain(
      'forward-depth-seed',
    );
    // Without AO the single-sample prepass still seeds `main`
    // (UE RendererScene.cpp DDM_AllOpaque for Forward shading).
    const plain = compile(standardPipeline, topology('forgeax::standard'));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const plainNames = plain.value.inspect().passes.map((pass) => pass.name);
    expect(plainNames.indexOf('forward-depth-seed')).toBeGreaterThan(
      plainNames.indexOf('standard-scene-surface-data'),
    );
    expect(plainNames.indexOf('forward-depth-seed')).toBeLessThan(plainNames.indexOf('main'));
  });

  it('omits SSAO and compute membership on the bounded fallback lane', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
        config: { ssao: { enabled: false } },
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 8,
          maxColorAttachmentBytesPerSample: 128,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const names = compiled.value.inspect().passes.map((pass) => pass.name);
    expect(names).not.toContain('cluster-membership-producer');
    expect(names.some((name) => name.startsWith('ssao-'))).toBe(false);
  });

  it('keeps URP post effects after output and before debug overlay', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        config: { postEffects: ['example::a', 'example::b'] },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names.filter((name) => name.startsWith('shadowCascade'))).toHaveLength(4);
    expect(names.indexOf('post-effect-0')).toBeGreaterThan(names.indexOf('fxaa'));
    expect(names.indexOf('post-effect-1')).toBeGreaterThan(names.indexOf('post-effect-0'));
    expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('post-effect-1'));
    expect(info.resources.map((resource) => resource.label)).toEqual(
      expect.arrayContaining([
        'post-effect-scratch-0',
        'post-effect-output-0',
        'post-effect-scratch-1',
      ]),
    );
    const copy0 = info.passes.find((pass) => pass.name === 'post-effect-copy-0');
    const effect0 = info.passes.find((pass) => pass.name === 'post-effect-0');
    const copy1 = info.passes.find((pass) => pass.name === 'post-effect-copy-1');
    const effect1 = info.passes.find((pass) => pass.name === 'post-effect-1');
    expect(copy0?.accesses).toContainEqual({ resource: 'surface', usage: 'copy-src' });
    expect(copy1?.accesses).toContainEqual({
      resource: 'post-effect-output-0',
      usage: 'copy-src',
    });
    expect(effect0?.accesses).toContainEqual({
      resource: 'post-effect-output-0',
      usage: 'color-attachment',
    });
    expect(effect1?.accesses).toContainEqual({
      resource: 'surface',
      usage: 'color-attachment',
    });
    expect(copy1?.dependencies).toContain('post-effect-0');
    expect(effect1?.dependencies).toContain('post-effect-copy-1');
  });

  it('admits the fullscreen post-effect chain atomically', () => {
    const visited: string[] = [];
    const pending = resolvePostProcessChainAdmission(['example::a', 'example::b'], (identity) => {
      visited.push(identity);
      return identity === 'example::a';
    });
    expect(pending).toEqual({ admitted: [], pending: true });
    expect(visited).toEqual(['example::a', 'example::b']);

    const ready = resolvePostProcessChainAdmission(['example::a', 'example::b'], () => true);
    expect(ready).toEqual({
      admitted: ['example::a', 'example::b'],
      pending: false,
    });
  });

  it('removes unsupported MSAA while retaining the CPU storage lane', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'none', antialias: 'msaa', bloom: 'off' },
        config: { postEffects: ['example::a'] },
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 4,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.resources.some((resource) => resource.label.includes('msaa'))).toBe(false);
    expect(info.passes.some((pass) => pass.name.startsWith('post-effect-'))).toBe(true);
  });

  it('declares one TAA producer and resolve for TAA demand', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const names = compiled.value.inspect().passes.map((pass) => pass.name);
    expect(names.filter((name) => name === 'standard-scene-data')).toHaveLength(1);
    expect(names.filter((name) => name === 'taa-resolve')).toHaveLength(1);
    expect(names.filter((name) => name.includes('taa')).length).toBe(1);
    expect(compiled.value.inspect().resources.map((resource) => resource.label)).toEqual(
      expect.arrayContaining([
        'taa-history-current-color',
        'taa-history-previous-color',
        'taa-history-current-temporal',
        'taa-history-previous-temporal',
      ]),
    );
    expect(
      compiled.value.inspect().passes.find((pass) => pass.name === 'taa-resolve')?.accesses,
    ).toEqual(
      expect.arrayContaining([
        { resource: 'taa-history-previous-color', usage: 'sampled-read' },
        { resource: 'taa-history-previous-temporal', usage: 'sampled-read' },
      ]),
    );
  });

  it.each([
    { antialias: 'taa' as const, afterTonemap: true, readsDepth: true },
    { antialias: 'taa' as const, afterTonemap: true, readsDepth: false },
    { antialias: 'taa' as const, afterTonemap: false, readsDepth: true },
    { antialias: 'none' as const, afterTonemap: true, readsDepth: true },
  ])('pairs after-tonemap scene inputs with the actual TAA output ($antialias/$afterTonemap)', ({
    antialias,
    afterTonemap,
    readsDepth,
  }) => {
    let projection:
      | Parameters<RenderPipelineBuildContext<RenderPipelineFrame>['contributeFeatures']>[0]
      | undefined;
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'aces-filmic', antialias, bloom: 'off' },
        extent: {
          outputWidth: 800,
          outputHeight: 600,
          internalWidth: 536,
          internalHeight: 402,
          scale: 0.67,
          generation: 1,
        },
      }),
      undefined,
      (graph) => ({
        hasFeatureWork: (_identity, placement, sceneInput) =>
          placement === 'after-tonemap' && afterTonemap && (sceneInput === undefined || readsDepth),
        contributeFeatures: (input) => {
          if (input.placement !== 'after-tonemap') return ok(undefined);
          projection = input;
          const color = input.targets.find((target) => target.kind === 'scene-color');
          const depth = input.targets.find((target) => target.kind === 'scene-depth');
          if (color === undefined || depth === undefined)
            throw new Error('missing post-process input');
          return graph.addRasterPass('after-tonemap-depth-consumer', {
            accesses: [
              { resource: color.view, usage: 'color-attachment' },
              { resource: depth.view, usage: 'sampled-read' },
            ],
            colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
            encodeDirect: () => {},
          });
        },
      }),
    ).unwrap();
    const info = compiled.inspect();
    const matched = antialias === 'taa' && afterTonemap && readsDepth;
    const producer = info.passes.find((pass) => pass.name === 'standard-post-process-coverage');
    expect(producer !== undefined).toBe(matched);
    expect(projection?.postProcessView).toBe(matched ? 'unjittered' : undefined);
    if (!matched) return;
    expect(producer?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'standard-post-process-coverage', usage: 'color-attachment' },
        { resource: 'standard-post-process-depth', usage: 'depth-stencil-write' },
      ]),
    );
    expect(producer?.accesses).not.toContainEqual({
      resource: 'taa-history-current-temporal',
      usage: 'sampled-read',
    });
    expect(
      info.resources.find((resource) => resource.label === 'standard-post-process-depth')
        ?.descriptor,
    ).toMatchObject({ format: 'depth32float-stencil8', width: 800, height: 600, sampleCount: 1 });
    expect(
      info.passes.find((pass) => pass.name === 'after-tonemap-depth-consumer')?.accesses,
    ).toContainEqual({
      resource: 'standard-post-process-depth',
      usage: 'sampled-read',
    });
  });

  it.each([
    false,
    true,
  ])('shares the Water foam producer with post-process geometry when underwater=%s', (underwater) => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
        camera: { antialias: 'taa', bloom: 'off' },
        water: true,
        waterView: { kind: 'available', underwater },
      }),
      undefined,
      () => ({ hasFeatureWork: (_identity, placement) => placement === 'after-tonemap' }),
    ).unwrap();
    const info = compiled.inspect();
    expect(
      info.resources.filter((resource) => resource.label === 'water-foam-simulation'),
    ).toHaveLength(1);
    const producers = info.passes.filter(
      (pass) => pass.name === 'water-foam-no-simulation-initialize',
    );
    expect(producers).toHaveLength(1);
    for (const name of [
      'water-depth-mask-velocity',
      'water-slw-inner-color',
      'standard-post-process-water-velocity',
    ]) {
      const consumer = info.passes.find((pass) => pass.name === name);
      expect(consumer, name).toBeDefined();
      expect(consumer?.accesses, name).toContainEqual({
        resource: 'water-foam-simulation',
        usage: 'sampled-read',
      });
      expect(requiredFixtureValue(producers[0]).executionIndex, name).toBeLessThan(
        requiredFixtureValue(consumer).executionIndex,
      );
    }
    expect(info.passes.find((pass) => pass.name === 'water-scene-temporal')?.accesses).toEqual([
      { resource: 'water-wpo-velocity', usage: 'sampled-read' },
      { resource: 'standard-scene-temporal', usage: 'color-attachment' },
      { resource: 'water-mask', usage: 'sampled-read' },
    ]);
  });

  it('feeds the SSR source-reactivity producer to final TAA without a second mask resource', () => {
    const ssr = admitSsrSpatial({
      camera: {
        projection: 'perspective',
        near: 0.1,
        far: 100,
        screenSpaceReflection: {
          waterTemporal: 0,
          maxDistance: 12,
          thickness: 0.2,
          maxRoughness: 0.65,
        },
      },
      environment: {
        lane: 'deferred',
        m0: { status: 'admitted' },
        sceneInputs: true,
        temporal: true,
        reflectionFallback: true,
        capabilities: {
          compute: true,
          storageTexture: true,
          rgba16floatRenderable: true,
          r32floatSampledStorage: true,
        },
      },
    });
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
        camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
        reflectionFallback: { enabled: true },
        ssr,
      }),
    ).unwrap();
    const info = compiled.inspect();
    expect(info.resources.filter((r) => r.label === 'ssr-hit-reactivity')).toHaveLength(1);
    expect(info.passes.find((p) => p.name === 'ssr-trace')?.accesses).toContainEqual({
      resource: 'ssr-hit-reactivity',
      usage: 'storage-write',
    });
    // The separable footprint max reads the producer once; TAA samples its rows.
    expect(
      info.passes.find((p) => p.name === 'taa-secondary-reactivity-rows')?.accesses,
    ).toContainEqual({ resource: 'ssr-hit-reactivity', usage: 'sampled-read' });
    expect(info.passes.find((p) => p.name === 'taa-resolve')?.accesses).toContainEqual({
      resource: 'taa-secondary-reactivity-rows',
      usage: 'sampled-read',
    });
    expect(info.passes.find((p) => p.name === 'taa-resolve')?.accesses).toContainEqual({
      resource: 'ssr-hit-reactivity',
      usage: 'sampled-read',
    });
    const names = info.passes.map((p) => p.name);
    expect(names.indexOf('ssr-trace')).toBeLessThan(names.indexOf('taa-secondary-reactivity-rows'));
    expect(names.indexOf('taa-secondary-reactivity-rows')).toBeLessThan(
      names.indexOf('taa-resolve'),
    );
  });

  it('pairs post-TAA Motion Blur color with resolved temporal coverage', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
        temporal: { taa: true, motionBlur: true },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const accesses = compiled.value
      .inspect()
      .passes.find((pass) => pass.name === 'motion-blur')?.accesses;
    expect(accesses).toEqual(
      expect.arrayContaining([
        { resource: 'taa-history-current-color', usage: 'sampled-read' },
        { resource: 'taa-history-current-temporal', usage: 'sampled-read' },
      ]),
    );
    expect(accesses).not.toContainEqual({
      resource: 'standard-scene-temporal',
      usage: 'sampled-read',
    });
  });

  it('fails closed when TAA history imports are missing', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const standardLighting = zeroStandardLighting({ compute: true, storageBuffer: true });
    if (!standardLighting.ok) throw standardLighting.error;
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: standardLighting.value,
        capabilities: { rgba16floatRenderable: true },
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      topology('forgeax::standard', {
        camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
      }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatchObject({
      code: 'scene-data-unavailable',
      detail: { reason: 'producer-missing' },
    });
  });

  it('uses an owned scene intermediate for CPU WebGL2 temporal output', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'none', antialias: 'taa', bloom: 'off' },
        temporal: { taa: true, motionBlur: true },
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 4,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const ordered = ['standard-scene-data', 'taa-resolve', 'motion-blur', 'output-transform'];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(names.indexOf(ordered[index] ?? '')).toBeGreaterThan(
        names.indexOf(ordered[index - 1] ?? ''),
      );
    }

    const sceneColor = info.resources.find((resource) => resource.label === 'scene-color');
    const surface = info.resources.find((resource) => resource.label === 'surface');
    expect(sceneColor?.origin).toBe('created');
    expect(sceneColor?.derivedUsage).toBeGreaterThanOrEqual(0x04);
    expect(surface?.derivedUsage).toBe(0x10);

    const resolve = info.passes.find((pass) => pass.name === 'taa-resolve');
    expect(resolve?.accesses).toContainEqual({
      resource: 'scene-color',
      usage: 'sampled-read',
    });
    const motionBlur = info.passes.find((pass) => pass.name === 'motion-blur');
    expect(motionBlur?.accesses).toContainEqual({
      resource: 'motion-blurred-color',
      usage: 'color-attachment',
    });
    expect(motionBlur?.accesses).toContainEqual({
      resource: 'taa-history-current-color',
      usage: 'sampled-read',
    });
    const output = info.passes.find((pass) => pass.name === 'output-transform');
    expect(output?.accesses).toContainEqual({
      resource: 'motion-blurred-color',
      usage: 'sampled-read',
    });
    expect(output?.accesses).toContainEqual({ resource: 'surface', usage: 'color-attachment' });
  });

  it('keeps none and fxaa free of temporal topology', () => {
    for (const antialias of ['none', 'fxaa'] as const) {
      const compiled = compile(
        standardPipeline,
        topology('forgeax::standard', {
          camera: { tonemap: 'aces-filmic', antialias, bloom: 'off' },
        }),
      );
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      const names = compiled.value.inspect().passes.map((pass) => pass.name);
      expect(names.some((name) => name.includes('taa'))).toBe(false);
      expect(names.some((name) => name.includes('temporal'))).toBe(false);
    }
  });

  it('keeps zero-shutter Motion Blur free of temporal target and passes', () => {
    expect(
      isMotionBlurTemporalDemand({
        shutterAngle: 0,
        maxRadiusPixels: 32,
        sampleCount: 8,
        targetFps: 60,
      }),
    ).toBe(false);
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'aces-filmic', antialias: 'none', bloom: 'off' },
        temporal: { taa: false, motionBlur: false },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.resources.filter((resource) => resource.label.includes('temporal'))).toHaveLength(
      0,
    );
    expect(
      info.passes.filter((pass) =>
        ['standard-scene-data', 'taa-resolve', 'motion-blur'].includes(pass.name),
      ),
    ).toHaveLength(0);
  });

  it('rejects insufficient MRT capability even with Cluster transport', () => {
    const built = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
        lane: {
          compute: true,
          storageBuffer: true,
          multisample: true,
          maxColorAttachments: 3,
        },
      }),
    );
    expect(built).toMatchObject({ ok: false, error: { code: 'resource-descriptor-invalid' } });
  });
});

describe('Standard temporal post topology', () => {
  it('orders TAA then Motion Blur before Bloom and tone', () => {
    expect(standardTemporalPostOrder({ taa: true, motionBlur: true, bloom: true })).toEqual([
      'scene',
      'standard-scene-data',
      'taa-resolve',
      'motion-blur',
      'bloom',
      'tone',
      'output',
    ]);
  });

  it('does not reserve temporal work when both consumers are disabled', () => {
    expect(standardTemporalPostOrder({ taa: false, motionBlur: false, bloom: false })).toEqual([
      'scene',
      'output',
    ]);
  });
});

describe('Standard two-phase GPU occlusion topology', () => {
  // Stands in for the GPU-driven projection: the late cull writes the late
  // indirect region that every GPU-driven scene pass reads.
  function lateOcclusionProjection(requests: boolean[]) {
    return (graph: RenderGraphBuilder<RenderPipelineFrame>) => {
      const indirect = graph.importBuffer(
        'stub-gpu-driven-indirect',
        { size: 256, usage: 0x100 | 0x80 },
        (frame) => frame.pipelineState.viewUniformBuffer,
      );
      if (!indirect.ok) throw indirect.error;
      return (target: { readonly lateOcclusion?: boolean }) => {
        requests.push(target.lateOcclusion === true);
        return ok({
          accesses: [{ resource: indirect.value, usage: 'indirect-read' as const }],
          hasWork: () => true,
          encode: () => {},
          ...(target.lateOcclusion === true
            ? {
                addLateOcclusion: (pyramid: GraphTextureView) => {
                  const cull = graph.addComputePass('gpu-driven.occlusion-cull', {
                    accesses: [
                      { resource: pyramid, usage: 'sampled-read' },
                      { resource: indirect.value, usage: 'storage-read-write' },
                    ],
                    encode: () => {},
                  });
                  if (!cull.ok) return cull;
                  return ok(['gpu-driven.occlusion-cull']);
                },
              }
            : {}),
        });
      };
    };
  }

  function passNames(input: RenderPipelineTopology, requests: boolean[] = []) {
    const compiled = compile(standardPipeline, input, lateOcclusionProjection(requests));
    if (!compiled.ok) throw compiled.error;
    return compiled.value.inspect().passes.map((pass) => pass.name);
  }

  function expectOrder(names: readonly string[], ordered: readonly string[]) {
    for (const name of ordered) expect(names).toContain(name);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(names.indexOf(ordered[index] ?? '')).toBeGreaterThan(
        names.indexOf(ordered[index - 1] ?? ''),
      );
    }
  }

  it('builds the furthest pyramid from the forward depth prepass before the late prepass', () => {
    // Forward always rasterizes its depth prepass, so two-phase occlusion
    // resolves there and `main` draws once after the late cull.
    const requests: boolean[] = [];
    const names = passNames(topology('forgeax::standard'), requests);
    expect(requests).toContain(true);
    expectOrder(names, [
      'standard-scene-surface-data',
      'occlusion-depth-pyramid-seed',
      'gpu-driven.occlusion-cull',
      'standard-scene-surface-data-late',
      'forward-depth-seed',
      'main',
    ]);
    expect(names).not.toContain('main-late');
  });

  it('keeps the late main pass under MSAA, where the prepass cannot seed main', () => {
    const requests: boolean[] = [];
    const names = passNames(
      topology('forgeax::standard', { camera: { antialias: 'msaa' } }),
      requests,
    );
    expect(requests).toContain(true);
    expectOrder(names, [
      'main',
      'occlusion-depth-pyramid-seed',
      'gpu-driven.occlusion-cull',
      'main-late',
    ]);
  });

  it.each([
    'ao',
    'contact',
    'capsules',
    'decals',
  ] as const)('completes late visibility before Forward %s consumes its surface', (consumer) => {
    const names = passNames(
      topology('forgeax::standard', {
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'forward',
          ssao: consumer === 'ao',
        },
        ...(consumer === 'ao' ? { config: { ssao: { enabled: true } } } : {}),
        ...(consumer === 'contact' ? { forwardContactShadows: true } : {}),
        ...(consumer === 'capsules' ? { forwardCapsuleShadows: true } : {}),
        ...(consumer === 'decals' ? { projectedDecals: [[]] } : {}),
      }),
    );
    const firstConsumer =
      consumer === 'ao'
        ? 'ssao-calc'
        : consumer === 'contact' || consumer === 'capsules'
          ? 'forward-contact-shadow'
          : 'decal-project';
    expectOrder(names, [
      'standard-scene-surface-data',
      'occlusion-depth-pyramid-seed',
      'gpu-driven.occlusion-cull',
      'standard-scene-surface-data-late',
      firstConsumer,
      'main',
    ]);
    expect(names.filter((name) => name === 'gpu-driven.occlusion-cull')).toHaveLength(1);
    expect(names).not.toContain('main-late');
  });

  it('builds the furthest pyramid from deferred G-buffer depth before the late G-buffer', () => {
    const names = passNames(
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
      }),
    );
    expectOrder(names, [
      'g-buffer',
      'occlusion-depth-pyramid-seed',
      'gpu-driven.occlusion-cull',
      'g-buffer-late',
      'lighting',
    ]);
  });

  it('seeds the late phase from every MSAA sample', () => {
    const msaaRequests: boolean[] = [];
    const msaa = passNames(
      topology('forgeax::standard', { camera: { antialias: 'msaa' } }),
      msaaRequests,
    );
    expect(msaaRequests).toContain(true);
    expect(msaa).toContain('main-late');
    expect(msaa).toContain('occlusion-depth-pyramid-seed');
  });

  it('adds no late phase when the asset opts out or without a reservation', () => {
    const optOutRequests: boolean[] = [];
    const optOut = passNames(
      topology('forgeax::standard', { config: { gpuOcclusion: false } }),
      optOutRequests,
    );
    expect(optOutRequests).not.toContain(true);
    expect(optOut).not.toContain('main-late');

    const compiled = compile(standardPipeline, topology('forgeax::standard'));
    if (!compiled.ok) throw compiled.error;
    const plain = compiled.value.inspect().passes.map((pass) => pass.name);
    expect(plain).not.toContain('main-late');
    expect(plain).not.toContain('occlusion-depth-pyramid-seed');
  });
});
