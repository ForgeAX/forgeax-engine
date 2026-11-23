import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  err,
  type RenderPipelineDescriptor,
  type Result,
  type RhiDevice,
  RhiError,
  type RenderPipeline as RhiPipeline,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  ok,
  type ShaderReflection,
  type ShaderSource,
  shaderSourceDescriptor,
} from '@forgeax/engine-types';
import {
  buildCapsuleShadowFrame,
  capsuleTileTableWords,
  MAX_FRAME_CAPSULES,
} from '../capsule-shadow/frame';
import { WORLD_CAPSULE_STRIDE } from '../capsule-shadow/world-capsules';
import type { DeviceScope } from '../device/device-scope';
import { getOrCreateDirectDfgLut, materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import {
  projectAtmosphereViewLayout,
  projectViewLayout,
  viewEntryReads,
} from '../environment/bindings';
import { directionalPcssCapable } from '../environment/capability';
import type { GraphEnvironment } from '../environment/ibl';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import type { ClusterViewResources } from '../hdrp-buffers';
import {
  SKYLIGHT_UNIFORM_BYTES,
  type SkylightBindGroupResources,
} from '../ibl/skylight-bind-group';
import { buildViewBindGroup } from '../record/frame-lighting';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import { reflectionProbeResources } from '../record/reflection-probe-material';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from '../record/render-context';
import {
  registerScenePipelinePreparation,
  type ScenePipelineSourceContext,
} from '../record/scene-pipeline-preparation';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { STANDARD_DEFERRED_SUBSURFACE_CONSTANTS } from '../standard-attachments';
import { recordContext } from '../world/view-record-context';
import {
  DEFERRED_REFLECTION_MAX_PROBE_INDEX,
  DEFERRED_REFLECTION_OVERFLOW_VERTEX,
  DEFERRED_REFLECTION_TABLE_BYTES,
  deferredReflectionArrayEntry,
  deferredReflectionOverflowEntry,
  prepareDeferredReflectionArrays,
  referencedDeferredProbes,
  resolveDeferredReflectionArrayBudget,
} from './deferred-reflection-coverage';
import type { StandardClusterGraphBuffers } from './standard-lighting/graph';

/** Two vec4 lanes shared by the graph allocation and uniform binding layout. */
export const DEFERRED_PCF_LIGHTING_FEATURE = 1 << 3;

export const DEFERRED_LIGHTING_PARAMS_BYTES = 2 * 4 * Float32Array.BYTES_PER_ELEMENT;

export interface StandardSceneShaderSources {
  readonly gbuffer?: import('@forgeax/engine-types').MaterialGBufferLayout;
  readonly compactGbuffer?: import('@forgeax/engine-types').CompactGBufferLayout;
  readonly forwardDirectionalShadow?: string | ShaderSource | undefined;
  readonly forwardScreenCompose?: string | import('@forgeax/engine-types').ShaderSource;
  readonly forwardContact?: string | import('@forgeax/engine-types').ShaderSource;
  readonly compactDecals?: true;
  readonly decalProject?: string | import('@forgeax/engine-types').ShaderSource;
  readonly decalApply?: string | import('@forgeax/engine-types').ShaderSource;
  readonly subsurface?: string | import('@forgeax/engine-types').ShaderSource;
  readonly deferredReflections?: ReadonlyMap<ShaderSource, ShaderReflection>;
  readonly prepareDeferredLighting?: (
    clustered: boolean,
    usesLut: boolean,
    features?: number,
  ) => boolean;
  readonly specializedDeferredLighting?: (
    clustered: boolean,
    usesLut: boolean,
    features: number,
  ) => ShaderSource;
  readonly deferred?: {
    readonly clustered: string | import('@forgeax/engine-types').ShaderSource;
    readonly unclustered: string | import('@forgeax/engine-types').ShaderSource;
    readonly clusteredLut?: string | import('@forgeax/engine-types').ShaderSource | undefined;
    readonly unclusteredLut?: string | import('@forgeax/engine-types').ShaderSource | undefined;
  };
}

interface DeferredPipelineCompilation {
  result?: Result<RhiPipeline, RhiError>;
}

interface DeferredLightingProgram {
  readonly compilation: DeferredPipelineCompilation;
  readonly usesLut: boolean;
  readonly arrayCount: number;
  readonly scope: DeviceScope;
  readonly device: RhiDevice;
  readonly viewLayout: BindGroupLayout;
  readonly source: string | import('@forgeax/engine-types').ShaderSource;
  pipeline?: RhiPipeline;
  readonly overflow?: {
    readonly descriptor: RenderPipelineDescriptor;
    compilation?: DeferredPipelineCompilation;
  };
  readonly material: BindGroupLayout;
  readonly probe: BindGroupLayout | undefined;
}

function compileDeferredPipeline(
  device: RhiDevice,
  descriptor: RenderPipelineDescriptor,
): DeferredPipelineCompilation {
  const compilation: DeferredPipelineCompilation = {};
  const create = device.createRenderPipelineAsync;
  const result =
    create === undefined
      ? device.createRenderPipeline(descriptor)
      : create.call(device, descriptor);
  if (result instanceof Promise) {
    result.then(
      (completed) => {
        compilation.result = completed;
      },
      (cause: unknown) => {
        compilation.result = err(
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'deferred lighting native compilation completes',
                hint: String(cause),
              }),
        );
      },
    );
  } else compilation.result = result;
  return compilation;
}

function deferredLightingSource(
  sources: StandardSceneShaderSources | undefined,
  clustered: boolean,
  usesLut: boolean,
  features: number,
) {
  if (features !== 0) return sources?.specializedDeferredLighting?.(clustered, usesLut, features);
  const deferred = sources?.deferred;
  if (clustered) return usesLut ? deferred?.clusteredLut : deferred?.clustered;
  return usesLut ? deferred?.unclusteredLut : deferred?.unclustered;
}

// Graph targets and bind groups have graph lifetime. Immutable layouts/PSOs
// survive graph replacement only inside their owning live device generation.
function hasDeferredLightingDemand(internal: ScenePipelineSourceContext): boolean {
  const admission = internal.frameState?.standardSceneSurfaceAdmission;
  return (
    admission?.deferredGBufferEmpty !== true ||
    admission.deviceGeneration !== recordContext(internal.runtime).deviceScope.generation
  );
}

const lightingPrograms = new WeakMap<
  DeviceScope,
  WeakMap<
    RhiDevice,
    WeakMap<
      BindGroupLayout,
      Map<
        string | import('@forgeax/engine-types').ShaderSource,
        Map<string, DeferredLightingProgram>
      >
    >
  >
>();

function programsFor(
  scope: DeviceScope,
  device: RhiDevice,
  view: BindGroupLayout,
  source: string | import('@forgeax/engine-types').ShaderSource,
) {
  let devices = lightingPrograms.get(scope);
  if (devices === undefined) {
    devices = new WeakMap();
    lightingPrograms.set(scope, devices);
    scope._adopt('pipeline', devices, () => {
      lightingPrograms.delete(scope);
    });
  }
  let views = devices.get(device);
  if (views === undefined) {
    views = new WeakMap();
    devices.set(device, views);
  }
  let sources = views.get(view);
  if (sources === undefined) {
    sources = new Map();
    views.set(view, sources);
  }
  let variants = sources.get(source);
  if (variants === undefined) {
    variants = new Map();
    sources.set(source, variants);
  }
  return variants;
}

function importDeferredLightProbeRecords(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  lightProbes: boolean | undefined,
) {
  return lightProbes !== true
    ? ok(undefined)
    : graph.importBuffer(
        'deferred-probe-records',
        { size: 256, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST },
        (frame) => {
          const buffer = (frame as _InternalRenderPipelineContext).frameState
            .probeBlendRecordBuffer;
          if (buffer === undefined)
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'prepared Standard probe records',
              hint: 'prepare the deferred frame before recording lighting',
            });
          return buffer.handle;
        },
      );
}

function deferredAuxiliaryAccesses(
  lightProbes: GraphBuffer | undefined,
  diffuseGi: GraphBuffer | undefined,
  arrayTable: GraphBuffer | undefined,
): GraphAccess[] {
  const accesses: GraphAccess[] = [];
  if (arrayTable !== undefined) accesses.push({ resource: arrayTable, usage: 'uniform-read' });
  if (lightProbes !== undefined) accesses.push({ resource: lightProbes, usage: 'storage-read' });
  if (diffuseGi !== undefined) accesses.push({ resource: diffuseGi, usage: 'storage-write' });
  return accesses;
}

function deferredAuxiliaryLayout(
  device: RhiDevice,
  arrayCount: number,
  lightProbes: boolean,
  diffuseGi: boolean,
) {
  if (arrayCount === 0 && !lightProbes && !diffuseGi) return;
  return device
    .createBindGroupLayout({
      entries: [
        ...(!lightProbes
          ? []
          : [
              {
                binding: 0,
                visibility: 2,
                buffer: { type: 'read-only-storage' as const, minBindingSize: 256 },
              },
            ]),
        ...(!diffuseGi
          ? []
          : [{ binding: 4, visibility: 2, buffer: { type: 'storage' as const } }]),
        ...Array.from({ length: arrayCount }, (_, index) => ({
          binding: index + 1,
          visibility: 2,
          texture: { sampleType: 'float' as const, viewDimension: '2d-array' as const },
        })),
        ...(arrayCount === 0
          ? []
          : [
              {
                binding: 3,
                visibility: 2,
                buffer: {
                  type: 'uniform' as const,
                  minBindingSize: DEFERRED_REFLECTION_TABLE_BYTES,
                },
              },
            ]),
      ],
    })
    .unwrap();
}

function deferredBindGroupLayouts(
  view: BindGroupLayout,
  material: BindGroupLayout,
  cluster: BindGroupLayout,
  auxiliary: BindGroupLayout | undefined,
) {
  return auxiliary === undefined ? [view, material, cluster] : [view, material, cluster, auxiliary];
}

function bindDeferredAuxiliaryGroup(
  pass: RhiRenderPassEncoder,
  resources: GraphResourceResolver,
  state: DeferredLightingProgram & { readonly groups: WeakMap<object, unknown> },
  counts: _InternalRenderPipelineContext['bindGroupCounts'],
  lightProbes: GraphBuffer | undefined,
  diffuseGiBaseline: GraphBuffer | undefined,
  arrayTable: GraphBuffer | undefined,
  arrays: ReturnType<typeof prepareDeferredReflectionArrays>,
) {
  if (state.probe === undefined) return;
  const layout = state.probe;
  const device = state.device;
  const tableBuffer =
    arrays === undefined || arrayTable === undefined
      ? undefined
      : resources.buffer(arrayTable).unwrap();
  const probeBuffer =
    lightProbes === undefined ? undefined : resources.buffer(lightProbes).unwrap();
  const baselineBuffer =
    diffuseGiBaseline === undefined ? undefined : resources.buffer(diffuseGiBaseline).unwrap();
  const probeGroup = (pmremViews: readonly TextureView[]) =>
    getOrCreateFromChain(
      state.groups,
      [
        layout,
        ...(probeBuffer === undefined ? [] : [probeBuffer]),
        ...pmremViews,
        ...(baselineBuffer === undefined ? [] : [baselineBuffer]),
        ...(tableBuffer === undefined ? [] : [tableBuffer]),
      ],
      'deferred-probe',
      () =>
        device
          .createBindGroup({
            layout,
            entries: [
              ...(probeBuffer === undefined
                ? []
                : [
                    {
                      binding: 0,
                      resource: { kind: 'buffer' as const, value: { buffer: probeBuffer } },
                    },
                  ]),
              ...(baselineBuffer === undefined
                ? []
                : [
                    {
                      binding: 4,
                      resource: { kind: 'buffer' as const, value: { buffer: baselineBuffer } },
                    },
                  ]),
              ...pmremViews.map((value, index) => ({
                binding: index + 1,
                resource: { kind: 'textureView' as const, value },
              })),
              ...(tableBuffer === undefined
                ? []
                : [
                    {
                      binding: 3,
                      resource: { kind: 'buffer' as const, value: { buffer: tableBuffer } },
                    },
                  ]),
            ],
          })
          .unwrap(),
      counts,
    );
  pass.setBindGroup(3, probeGroup(arrays?.views ?? []));
  return probeGroup;
}

function deferredSunTable(environment: GraphEnvironment | undefined, perPixel?: boolean) {
  return perPixel === false ? undefined : environment?.atmosphere?.transmittance;
}

function resolveDeferredSunTable(
  resources: GraphResourceResolver,
  table: GraphTextureView | undefined,
) {
  return table === undefined ? undefined : { transmittance: resources.textureView(table).unwrap() };
}

/** Geometry initializes emissive; this pass adds deferred lighting radiance. */
export function addStandardDeferredLighting(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly color: RenderPipelineTarget;
    readonly gbuffer: readonly RenderPipelineTarget[];
    readonly receiverGeometry?: RenderPipelineTarget;
    readonly compactGbuffer?: import('@forgeax/engine-types').CompactGBufferLayout;
    readonly projectedDirectionalPcf?: boolean;
    readonly pcfLighting?: boolean;
    readonly depth: GraphTextureView;
    readonly reflectionFallback?: RenderPipelineTarget;
    readonly localProbes: boolean;
    readonly lightProbes?: boolean;
    readonly response?: RenderPipelineTarget;
    readonly diffuse?: RenderPipelineTarget;
    readonly diffuseGiBaseline?: GraphBuffer;
    readonly ssao?: RenderPipelineTarget;
    readonly directionalShadow?: RenderPipelineTarget;
    readonly spotShadow: RenderPipelineTarget | undefined;
    readonly pointShadow?: RenderPipelineTarget;
    readonly cloudShadow?: RenderPipelineTarget;
    readonly environment?: GraphEnvironment;
    readonly perPixelAtmosphereTransmittance?: boolean | undefined;
    readonly cluster: StandardClusterGraphBuffers | null;
    readonly extraAccesses: readonly GraphAccess[];
    /** Lighting target extent; sizes the capsule shadow tile table. */
    readonly size: { readonly width: number; readonly height: number };
  },
) {
  const compact = input.compactGbuffer === 'standard-gbuffer/4';
  const params = graph.createBuffer('deferred-lighting-params', {
    size: DEFERRED_LIGHTING_PARAMS_BYTES,
  });
  if (!params.ok) return params;
  const capsuleBytes = MAX_FRAME_CAPSULES * WORLD_CAPSULE_STRIDE * 4;
  const tileBytes = capsuleTileTableWords(input.size.width, input.size.height) * 4;
  const capsules = graph.createBuffer('capsule-shadow-capsules', { size: capsuleBytes });
  if (!capsules.ok) return capsules;
  const capsuleTiles = graph.createBuffer('capsule-shadow-tiles', {
    size: tileBytes,
  });
  if (!capsuleTiles.ok) return capsuleTiles;
  const diffuseGiBaseline = input.diffuseGiBaseline;
  const features =
    Number(diffuseGiBaseline !== undefined) |
    (Number(input.lightProbes === true) << 1) |
    (Number(input.perPixelAtmosphereTransmittance === false) << 2) |
    (Number(input.pcfLighting === true) * DEFERRED_PCF_LIGHTING_FEATURE);
  const probe = importDeferredLightProbeRecords(graph, input.lightProbes);
  if (!probe.ok) return probe;
  const colors = [
    input.color,
    ...(input.reflectionFallback === undefined ? [] : [input.reflectionFallback]),
    ...(input.response === undefined ? [] : [input.response]),
    ...(input.diffuse === undefined ? [] : [input.diffuse]),
  ];
  const fragmentEntry = compact
    ? 'fs_standard_deferred_compact' +
      (input.reflectionFallback !== undefined
        ? '_reflections'
        : input.diffuse !== undefined
          ? '_subsurface'
          : '') +
      (input.receiverGeometry === undefined ? '' : '_channels')
    : input.diffuse !== undefined && input.reflectionFallback === undefined
      ? 'fs_standard_deferred_subsurface'
      : colors.length === 1
        ? 'fs_standard_deferred'
        : 'fs_standard_deferred_reflections';
  const table = input.localProbes
    ? graph.createBuffer('deferred-reflection-table', { size: DEFERRED_REFLECTION_TABLE_BYTES })
    : ok(undefined);
  if (!table.ok) return table;
  const arrayTable = table.value;
  const environmentPlans = new WeakMap<
    _InternalRenderPipelineContext,
    {
      readonly rows: ReturnType<typeof referencedDeferredProbes>;
      readonly arrays: ReturnType<typeof prepareDeferredReflectionArrays>;
      readonly usesLut: boolean;
    }
  >();
  let lastBudget:
    | {
        readonly reflection: ShaderReflection;
        readonly viewLayout: BindGroupLayout;
        readonly usesLut: boolean;
        readonly value: 0 | 1 | 2;
      }
    | undefined;
  const clustered = input.cluster !== null;
  const lightingViewLayout = (
    internal: _InternalRenderPipelineContext,
    source: ShaderSource | string,
    entryPoint: string,
    hasOverflow: boolean,
  ) => {
    const device = internal.runtime.device;
    const base = internal.pipelineState.viewBindGroupLayout;
    const reflection =
      typeof source === 'object'
        ? internal.runtime.standardSceneShaders?.deferredReflections?.get(source)
        : undefined;
    const reads = viewEntryReads(reflection?.entryPoints, 'vs_standard_deferred', entryPoint);
    const overflowReads = hasOverflow
      ? viewEntryReads(
          reflection?.entryPoints,
          DEFERRED_REFLECTION_OVERFLOW_VERTEX,
          deferredReflectionOverflowEntry(input.reflectionFallback !== undefined, compact),
        )
      : undefined;
    if (reads === undefined || (hasOverflow && overflowReads === undefined))
      return projectAtmosphereViewLayout(
        device,
        base,
        input.perPixelAtmosphereTransmittance !== false,
        clustered,
      );
    if (overflowReads === undefined) return projectViewLayout(device, base, reads);
    const union = new Map(reads);
    for (const [slot, visibility] of overflowReads)
      union.set(slot, (union.get(slot) ?? 0) | visibility);
    return projectViewLayout(device, base, union);
  };
  const lutDemand = new WeakMap<ScenePipelineSourceContext['validatedOrdered'], boolean>();
  const useDirectDfgLut = (rows: ScenePipelineSourceContext['validatedOrdered']) => {
    if (rows === undefined) return false;
    const cached = lutDemand.get(rows);
    if (cached !== undefined) return cached;
    const usesLut = rows.some((entry) =>
      entry.source.materials.some((material) =>
        materialUsesDirectDfgLut(material.snapshot.materialParamSchema),
      ),
    );
    lutDemand.set(rows, usesLut);
    return usesLut;
  };
  const prepareSource = (internal: ScenePipelineSourceContext) => {
    const shaders = internal.runtime.standardSceneShaders;
    if (shaders?.prepareDeferredLighting !== undefined && hasDeferredLightingDemand(internal))
      shaders.prepareDeferredLighting(
        clustered,
        useDirectDfgLut(internal.validatedOrdered),
        features,
      );
  };
  const environmentPlan = (internal: _InternalRenderPipelineContext) => {
    const cached = environmentPlans.get(internal);
    if (cached !== undefined) return cached;
    if (!hasDeferredLightingDemand(internal)) return;
    const usesLut = useDirectDfgLut(internal.validatedOrdered);
    const shaders = internal.runtime.standardSceneShaders;
    if (shaders?.prepareDeferredLighting?.(clustered, usesLut, features) === false) {
      markPipelinePreparationPending(internal.frameState, { code: 'scene-pipeline-preparation' });
      return;
    }
    const rows = referencedDeferredProbes(internal.reflectionProbes);
    const source = deferredLightingSource(shaders, clustered, usesLut, features);
    const reflection =
      typeof source === 'object' ? shaders?.deferredReflections?.get(source) : undefined;
    let arrays: ReturnType<typeof prepareDeferredReflectionArrays>;
    if (arrayTable !== undefined && rows.length > 0 && reflection !== undefined) {
      const viewLayout = internal.pipelineState.viewBindGroupLayout;
      if (
        lastBudget?.reflection !== reflection ||
        lastBudget.viewLayout !== viewLayout ||
        lastBudget.usesLut !== usesLut
      ) {
        lastBudget = {
          reflection,
          viewLayout,
          usesLut,
          value: resolveDeferredReflectionArrayBudget(
            internal.runtime.device.limits,
            internal.pipelineState,
            reflection,
            fragmentEntry,
            clustered,
            usesLut,
            input.reflectionFallback !== undefined,
            compact,
            input.perPixelAtmosphereTransmittance !== false,
          ),
        };
      }
      arrays = prepareDeferredReflectionArrays(rows, lastBudget.value);
    }
    const plan = { rows, arrays, usesLut };
    environmentPlans.set(internal, plan);
    return plan;
  };
  const upload = graph.addCopyPass('deferred-lighting-prepare', {
    accesses: [
      { resource: params.value, usage: 'copy-dst' },
      ...(arrayTable === undefined ? [] : [{ resource: arrayTable, usage: 'copy-dst' as const }]),
      { resource: capsules.value, usage: 'copy-dst' },
      { resource: capsuleTiles.value, usage: 'copy-dst' },
    ],
    encodeDirect: (encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const queue = frame.runtime.device.queue;
      const arrays = environmentPlan(internal)?.arrays;
      if (arrays !== undefined && arrayTable !== undefined)
        queue.writeBuffer(resources.buffer(arrayTable).unwrap(), 0, arrays.data).unwrap();
      // Lane y rotates the contact-shadow noise only under temporal
      // accumulation; without it a static pattern avoids visible crawl.
      const noiseFrame = (frame.camera.temporal?.temporalFrameIndex ?? 0) % 64;
      const light = internal.capsuleShadowLight;
      // Capsule storage has its own budget; scene sources survive release of
      // unused legacy geometry slots in the GPU-driven Shadow lane.
      const capsuleFrame =
        light === undefined
          ? undefined
          : buildCapsuleShadowFrame(
              light.renderables,
              internal.materialFrame,
              frame.camera,
              light.direction,
              light.coneHalfAngle,
              input.size.width,
              input.size.height,
              internal.runtime.demandCapsuleShadow ?? (() => undefined),
            );
      if (capsuleFrame !== undefined) {
        // Auxiliary capture views shade their own tiles; inspection reports the display view.
        if (frame.camera.captureProjection === undefined)
          internal.frameState.capsuleShadowSubmission = capsuleFrame.submission;
        if (capsuleFrame.capsules.length > 0) {
          queue
            .writeBuffer(resources.buffer(capsules.value).unwrap(), 0, capsuleFrame.capsules)
            .unwrap();
          queue
            .writeBuffer(resources.buffer(capsuleTiles.value).unwrap(), 0, capsuleFrame.tiles)
            .unwrap();
        }
      }
      // The graph declares full storage reads. Define the unused tails too,
      // including the disabled case, so captured frames need no previous contents.
      // Queue uploads precede encoder submission: clear only beyond their prefixes.
      const populated = (capsuleFrame?.capsules.length ?? 0) > 0;
      for (const [ref, capacity, used] of [
        [capsules.value, capsuleBytes, populated ? (capsuleFrame?.capsules.byteLength ?? 0) : 0],
        [capsuleTiles.value, tileBytes, populated ? (capsuleFrame?.tiles.byteLength ?? 0) : 0],
      ] as const) {
        if (used < capacity)
          encoder.clearBuffer(resources.buffer(ref).unwrap(), used, capacity - used);
      }
      queue
        .writeBuffer(
          resources.buffer(params.value).unwrap(),
          0,
          new Float32Array([
            input.ssao === undefined ? 0 : 1,
            noiseFrame,
            // Lane z gates the capsule evaluation; lane w is the light cone half-angle.
            capsuleFrame?.submission.capsuleCount ?? 0,
            capsuleFrame?.coneHalfAngle ?? 0,
            0,
            0,
            0,
            0,
          ]),
        )
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  const solarTable = deferredSunTable(input.environment, input.perPixelAtmosphereTransmittance);
  const sampled = [
    ...input.gbuffer.map((target) => target.view),
    ...(input.receiverGeometry === undefined ? [] : [input.receiverGeometry.view]),
    input.depth,
    ...[
      input.ssao,
      input.directionalShadow,
      input.spotShadow,
      input.pointShadow,
      input.cloudShadow,
    ].flatMap((target) => (target === undefined ? [] : [target.view])),
    ...(input.environment === undefined ? [] : [input.environment.prefilter]),
    ...(solarTable === undefined ? [] : [solarTable]),
  ];
  const states = new Map<
    string,
    DeferredLightingProgram & {
      readonly groups: WeakMap<object, unknown>;
      readonly baseViewLayout: BindGroupLayout;
    }
  >();
  const subsurface = input.diffuse !== undefined;
  const targetKey = JSON.stringify(colors.map((target) => target.format));
  const prepareProgram = (internal: _InternalRenderPipelineContext) => {
    // Complete current-device surface demand owns shader module preparation.
    const environment = environmentPlan(internal);
    if (environment === undefined) return;
    const device = internal.runtime.device;
    const projectedPcf =
      input.projectedDirectionalPcf === true && directionalPcssCapable(device.caps.backendKind);
    const { usesLut, arrays } = environment;
    const arrayCount = arrays?.views.length ?? 0;
    const entryPoint =
      arrayCount === 0 ? fragmentEntry : deferredReflectionArrayEntry(fragmentEntry, arrayCount);
    if (internal.runtime.standardSceneShaders?.gbuffer !== 'standard-gbuffer/2')
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'standard-gbuffer/2 Deferred readers',
        hint: 'Rebuild the Engine shader manifest for this GBuffer layout.',
      });
    if (compact && internal.runtime.standardSceneShaders.compactGbuffer !== input.compactGbuffer)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'standard-gbuffer/4 Deferred readers',
        hint: 'Rebuild the Engine shader manifest for the compact layout.',
      });
    const source = deferredLightingSource(
      internal.runtime.standardSceneShaders,
      input.cluster !== null,
      usesLut,
      features,
    );
    if (source === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'cooked Standard deferred lighting program',
        hint: 'rebuild the Engine shader manifest and reinitialize the Renderer',
      });
    const scope = recordContext(internal.runtime).deviceScope;
    if (!scope.isAlive())
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'a live device scope for deferred lighting',
        hint: 'recreate the Renderer after device retirement',
      });

    const baseViewLayout = internal.pipelineState.viewBindGroupLayout;
    const stateKey = `${usesLut}:${arrayCount}`;
    let state = states.get(stateKey);
    if (
      state === undefined ||
      state.scope !== scope ||
      state.device !== device ||
      state.baseViewLayout !== baseViewLayout ||
      state.source !== source
    ) {
      const viewLayout = lightingViewLayout(internal, source, entryPoint, arrayCount > 0);
      const programs = programsFor(scope, device, viewLayout, source);
      const key = `${input.cluster !== null}:${usesLut}:${entryPoint}:${projectedPcf}:${subsurface}:${targetKey}`;
      let program = programs.get(key);
      if (program === undefined) {
        const factory = internal.runtime.shaderModuleFactory;
        if (factory === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'deferred shader module factory',
            hint: 'initialize the Renderer backend',
          });
        const moduleResult = factory.createShaderModule(
          shaderSourceDescriptor(source, `standard_deferred_${input.cluster !== null}_${usesLut}`),
        );
        if (!moduleResult.ok && factory.isPending?.(moduleResult.error) === true) {
          markPipelinePreparationPending(internal.frameState, {
            code: 'scene-pipeline-preparation',
          });
          return;
        }
        const module = moduleResult.unwrap();
        const material = device
          .createBindGroupLayout({
            label: 'deferred-surface-environment',
            entries: [
              ...Array.from({ length: 6 }, (_, binding) => ({
                binding,
                visibility: 2,
                texture: {
                  sampleType:
                    binding < 4
                      ? ('uint' as const)
                      : binding === 4
                        ? ('depth' as const)
                        : ('float' as const),
                  viewDimension: '2d' as const,
                },
              })),
              { binding: 6, visibility: 2, sampler: { type: 'filtering' } },
              {
                binding: 7,
                visibility: 2,
                buffer: { type: 'uniform', minBindingSize: DEFERRED_LIGHTING_PARAMS_BYTES },
              },
              ...[9, 10].map((binding) => ({
                binding,
                visibility: 2,
                texture: {
                  sampleType: 'float' as const,
                  viewDimension: '2d' as const,
                },
              })),
              {
                binding: 12,
                visibility: 2,
                buffer: { type: 'uniform', minBindingSize: SKYLIGHT_UNIFORM_BYTES },
              },
              { binding: 13, visibility: 2, buffer: { type: 'read-only-storage' } },
              { binding: 14, visibility: 2, buffer: { type: 'read-only-storage' } },
              ...(input.receiverGeometry === undefined
                ? []
                : [
                    {
                      binding: 15,
                      visibility: 2,
                      texture: { sampleType: 'uint' as const, viewDimension: '2d' as const },
                    },
                  ]),
              ...(usesLut
                ? [
                    {
                      binding: 16,
                      visibility: 2,
                      texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
                    },
                  ]
                : []),
            ],
          })
          .unwrap();
        const probeLayout = deferredAuxiliaryLayout(
          device,
          arrayCount,
          probe.value !== undefined,
          diffuseGiBaseline !== undefined,
        );
        const layout = device
          .createPipelineLayout({
            bindGroupLayouts:
              probeLayout === undefined
                ? [viewLayout, material]
                : deferredBindGroupLayouts(
                    viewLayout,
                    material,
                    device.createBindGroupLayout({ entries: [] }).unwrap(),
                    probeLayout,
                  ),
          })
          .unwrap();
        const descriptor: RenderPipelineDescriptor = {
          label: 'standard-deferred-lighting',
          layout,
          vertex: { module, entryPoint: 'vs_standard_deferred', buffers: [] },
          fragment: {
            module,
            entryPoint,
            constants: {
              ...(projectedPcf ? { '64005': 1 } : {}),
              ...(subsurface ? STANDARD_DEFERRED_SUBSURFACE_CONSTANTS : {}),
            },
            targets: colors.map((target, index) => ({
              format: target.format,
              ...(index === 0
                ? {
                    blend: {
                      color: {
                        operation: 'add' as const,
                        srcFactor: 'one' as const,
                        dstFactor: 'one' as const,
                      },
                      alpha: {
                        operation: 'add' as const,
                        srcFactor: 'zero' as const,
                        dstFactor: 'one' as const,
                      },
                    },
                  }
                : {}),
            })),
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
        };
        const overflow =
          arrayCount === 0
            ? undefined
            : {
                descriptor: {
                  ...descriptor,
                  label: 'standard-deferred-reflection-overflow',
                  vertex: { module, entryPoint: DEFERRED_REFLECTION_OVERFLOW_VERTEX, buffers: [] },
                  fragment: {
                    module,
                    entryPoint: deferredReflectionOverflowEntry(
                      input.reflectionFallback !== undefined,
                      compact,
                    ),
                    targets: Array.from(descriptor.fragment?.targets ?? [], (target, index) =>
                      target == null ||
                      index === 0 ||
                      (index === 1 && input.reflectionFallback !== undefined)
                        ? target
                        : { ...target, writeMask: 0 },
                    ),
                  },
                },
              };
        program = {
          usesLut,
          arrayCount,
          scope,
          device,
          viewLayout,
          source,
          material,
          probe: probeLayout,
          compilation: compileDeferredPipeline(device, descriptor),
          ...(overflow === undefined ? {} : { overflow }),
        };
        programs.set(key, program);
      }
      if (program.compilation.result === undefined) {
        markPipelinePreparationPending(internal.frameState, { code: 'scene-pipeline-preparation' });
        return undefined;
      }
      if (!program.compilation.result.ok) {
        programs.delete(key);
        throw program.compilation.result.error;
      }
      program.pipeline = program.compilation.result.value;
      state = { ...program, baseViewLayout, groups: new WeakMap() };
      states.set(stateKey, state);
    }

    if (arrays !== undefined && arrays.overflow.length > 0) {
      const overflow = state.overflow;
      if (overflow === undefined)
        throw new RhiError({
          code: 'shader-compile-failed',
          expected: 'the matching Deferred reflection overflow program',
          hint: 'rebuild the Engine shader manifest',
        });
      overflow.compilation ??= compileDeferredPipeline(device, overflow.descriptor);
      const result = overflow.compilation.result;
      if (result === undefined) {
        markPipelinePreparationPending(internal.frameState, { code: 'scene-pipeline-preparation' });
        return;
      }
      if (!result.ok) {
        delete overflow.compilation;
        throw result.error;
      }
    }
    return state;
  };
  registerScenePipelinePreparation(
    graph,
    Object.assign(
      (context: _InternalRenderPipelineContext) => {
        prepareProgram(context);
        return false;
      },
      { prepareSource },
    ),
    'utility',
  );
  return graph.addRasterPass('lighting', {
    accesses: [
      ...(input.environment === undefined
        ? []
        : [{ resource: input.environment.skySh, usage: 'uniform-read' as const }]),
      ...sampled.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      ...colors.map((target) => ({ resource: target.view, usage: 'color-attachment' as const })),
      { resource: params.value, usage: 'uniform-read' },
      ...deferredAuxiliaryAccesses(probe.value, diffuseGiBaseline, arrayTable),
      { resource: capsules.value, usage: 'storage-read' },
      { resource: capsuleTiles.value, usage: 'storage-read' },
      ...input.extraAccesses,
    ],
    colorAttachments: colors.map((target, index) => ({
      view: target.view,
      loadOp: index === 0 ? ('load' as const) : ('clear' as const),
      storeOp: 'store' as const,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    })),
    encodeDirect: (pass, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = prepareProgram(internal);
      if (state === undefined || state.pipeline === undefined) {
        // The shared frame seal rejects pending work; no partial lighting draw
        // or surface submission may escape this existing preparation barrier.
        return;
      }
      const current = state;
      const device = state.device;
      const directDfgLut = state.usesLut
        ? getOrCreateDirectDfgLut(device, recordContext(internal.runtime).deviceScope).unwrap()
        : undefined;
      const view = (target: RenderPipelineTarget | undefined) =>
        target === undefined ? undefined : resources.textureView(target.view).unwrap();
      if (input.cluster?.kind === 'texture')
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'Deferred lighting requires storage-buffer capabilities',
          hint: 'use the Standard Forward path on this device',
        });
      const cluster: ClusterViewResources | undefined =
        input.cluster === null
          ? undefined
          : {
              kind: 'storage',
              lightDataBuffer: resources.buffer(input.cluster.lightData).unwrap(),
              clusterGridBuffer: resources.buffer(input.cluster.clusterGrid).unwrap(),
              lightIndexListBuffer: resources.buffer(input.cluster.lightIndexList).unwrap(),
              clusterUniformBuffer: resources.buffer(input.cluster.clusterUniform).unwrap(),
            };
      const environment =
        input.environment === undefined
          ? internal
          : {
              ...internal,
              environmentIbl: {
                skySh: resources.buffer(input.environment.skySh).unwrap(),
                prefilter: resources.textureView(input.environment.prefilter).unwrap(),
              },
            };
      const sky = prepareMaterialSkylight(environment).skylightResources;
      const viewBindGroup = buildViewBindGroup(
        internal.runtime as RenderSystemInternals,
        internal.frameState,
        internal.pipelineState,
        internal.bindGroupCounts,
        {
          viewBindGroupLayout: state.viewLayout,
          sky,
          cluster,
          atmosphere: resolveDeferredSunTable(resources, solarTable),
          directionalShadow: view(input.directionalShadow),
          spotShadow: view(input.spotShadow),
          cloudShadow: view(input.cloudShadow),
          projector: internal.spotLightProjector?.view,
          projectorSampler: internal.spotLightProjector?.sampler,
        },
      );
      if (viewBindGroup === null)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'Standard view/shadow resources',
          hint: 'repair the frame lighting resources',
        });
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, viewBindGroup, [0, 0]);
      const reflectionPlan = environmentPlan(internal);
      if (reflectionPlan === undefined) return;
      const { rows, arrays } = reflectionPlan;
      const probeGroup = bindDeferredAuxiliaryGroup(
        pass,
        resources,
        state,
        internal.bindGroupCounts,
        probe.value,
        diffuseGiBaseline,
        arrayTable,
        arrays,
      );
      const environments: SkylightBindGroupResources[] = [sky];
      for (const row of arrays === undefined ? rows : []) {
        if (row.index > DEFERRED_REFLECTION_MAX_PROBE_INDEX)
          throw new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'at most 255 deferred reflection environments',
            hint: 'reduce the resident reflection-probe roster',
          });
        environments.push(reflectionProbeResources(sky, row));
      }
      const surfaces = [
        ...input.gbuffer.map((target) => resources.textureView(target.view).unwrap()),
        resources.textureView(input.depth).unwrap(),
        view(input.ssao) ?? internal.pipelineState.defaultWhiteTextureView,
      ];
      const paramsBuffer = resources.buffer(params.value).unwrap();
      const receiverView =
        input.receiverGeometry === undefined
          ? undefined
          : resources.textureView(input.receiverGeometry.view).unwrap();
      const capsuleBuffers = [capsules.value, capsuleTiles.value].map((ref) =>
        resources.buffer(ref).unwrap(),
      );
      for (const env of environments) {
        const keys = [
          ...surfaces,
          ...(receiverView === undefined ? [] : [receiverView]),
          env.irradianceSampler,
          paramsBuffer,
          ...capsuleBuffers,
          env.prefilterView,
          env.brdfLutView,
          env.intensityBuffer,
          ...(directDfgLut === undefined ? [] : [directDfgLut.view]),
        ];
        const group = getOrCreateFromChain(
          state.groups,
          keys,
          'deferred-environment',
          () =>
            device
              .createBindGroup({
                layout: current.material,
                entries: [
                  ...(receiverView === undefined
                    ? []
                    : [
                        {
                          binding: 15,
                          resource: {
                            kind: 'textureView' as const,
                            value: receiverView,
                          },
                        },
                      ]),
                  ...surfaces.map((resource, binding) => ({
                    binding,
                    resource: { kind: 'textureView' as const, value: resource },
                  })),
                  {
                    binding: 6,
                    resource: { kind: 'sampler' as const, value: env.irradianceSampler },
                  },
                  {
                    binding: 7,
                    resource: { kind: 'buffer' as const, value: { buffer: paramsBuffer } },
                  },
                  {
                    binding: 9,
                    resource: { kind: 'textureView' as const, value: env.prefilterView },
                  },
                  {
                    binding: 10,
                    resource: { kind: 'textureView' as const, value: env.brdfLutView },
                  },
                  {
                    binding: 12,
                    resource: { kind: 'buffer' as const, value: { buffer: env.intensityBuffer } },
                  },
                  ...capsuleBuffers.map((buffer, index) => ({
                    binding: 13 + index,
                    resource: { kind: 'buffer' as const, value: { buffer } },
                  })),
                  ...(directDfgLut === undefined
                    ? []
                    : [
                        {
                          binding: 16,
                          resource: { kind: 'textureView' as const, value: directDfgLut.view },
                        },
                      ]),
                ],
              })
              .unwrap(),
          internal.bindGroupCounts,
        );
        pass.setBindGroup(1, group);
        pass.draw(3);
      }
      const overflowPipeline = state.overflow?.compilation?.result;
      if (
        probeGroup === undefined ||
        arrays === undefined ||
        !overflowPipeline?.ok ||
        arrays.overflow.length === 0
      )
        return;
      pass.setPipeline(overflowPipeline.value);
      for (const { view: pmrem, sizeClass } of arrays.overflow) {
        const views = arrays.views[1] === undefined ? [pmrem] : [pmrem, arrays.views[1]];
        pass.setBindGroup(3, probeGroup(views));
        pass.draw(3, 1, 0, sizeClass);
      }
    },
  });
}
