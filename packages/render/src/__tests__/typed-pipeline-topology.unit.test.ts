import { readFileSync } from 'node:fs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { type GraphTextureView, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RenderFeaturePlanExecution } from '../features/host';
import { createRenderFeatureProjectionState } from '../features/render-graph-contribution';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
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
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
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
import { resolveOutputDither } from '../render-pipeline';
import { admitSsrSpatial } from '../ssr/admission';
import {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
} from '../temporal/scene-data';
import { standardTemporalPostOrder } from '../temporal/standard-scene-data';
import { type OpaquePassPlan, planOpaque } from '../world/pass-plan-systems';
import { selectTestStandardClusterTransport as selectStandardClusterTransport } from './cluster-test-abi';

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
  context: { readonly gtaoExecutionOverride?: 'fragment' | 'compute' } = {},
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
      ...context,
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

  it('produces Forward AO from shared material surface data on the no-storage lane', () => {
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
    expect(info.passes.find((pass) => pass.name === 'ssao-calc')?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'standard-scene-surface-normal', usage: 'sampled-read' },
        { resource: 'standard-scene-surface-depth', usage: 'sampled-read' },
      ]),
    );
    expect(info.passes.find((pass) => pass.name === 'ssao-cluster-pack')?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'ssao-blurred', usage: 'sampled-read' },
        { resource: 'standard-cluster-tables', usage: 'color-attachment' },
      ]),
    );
    const normalResource = info.resources.find(
      (resource) => resource.label === 'standard-scene-surface-normal',
    );
    expect(normalResource?.derivedUsage).toBe(
      GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    );
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
              screenSpaceReflection: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
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

  it('feeds the SSR source-reactivity producer to final TAA without a second mask resource', () => {
    const ssr = admitSsrSpatial({
      camera: {
        projection: 'perspective',
        near: 0.1,
        far: 100,
        screenSpaceReflection: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
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
