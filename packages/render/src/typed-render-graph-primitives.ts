import {
  type GraphAccess,
  type GraphResourceResolver,
  type GraphTextureView,
  type RasterDepthStencilAttachment,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupLayout,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import { TAA_SCENE_VELOCITY_WGSL, TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import {
  err,
  ok,
  type PassKind,
  type PassSelector,
  type Result,
  SINGLE_LAYER_WATER_PASS_OUTPUTS,
} from '@forgeax/engine-types';
import {
  deferredPostProcessEntry,
  postProcessFragmentEntry,
} from './assembly/deferred-post-process-entry';
import {
  atmosphereAccesses,
  atmosphereVolumeViews,
  type RasterAtmosphereReads,
} from './environment/luts';
import type { PostProcessShaderEntry } from './fullscreen-post-process-pass';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';
import { BloomDraw, type BloomStage } from './record/bloom-draw';
import { addCurrentMaterialDepth } from './record/current-material-depth';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import { geometryPipelineRequestContext } from './record/geometry-pipeline-requests';
import {
  type GraphBindingViews,
  graphBindingViewsCurrent,
  type NativeMaterialView,
} from './record/graph-binding-views';
import {
  encodeMainPass,
  type MainPassOptions,
  prepareMainPassGeometryPipelines,
  requestVisibleForwardPipelines,
} from './record/main-pass';
import { prepareMaterialSkylight } from './record/main-pass-material';
import {
  isWaterForwardColorMode,
  type MaterialRecordMode,
  waterRecordPass,
} from './record/material-pass-selection';
import { encodeFrameObservationCapture } from './record/observation-capture';
import {
  addOrdinaryMaterialDepthSnapshot,
  ordinaryMaterialDepthDemand,
} from './record/ordinary-material-depth';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from './record/render-context';
import {
  resolveScenePassSelection,
  type ScenePassSelection,
  selectScenePassPipelineEntries,
} from './record/scene-pass-selection';
import {
  isCurrentTransparencyPassActive,
  registerScenePass,
  type ScenePassRequest,
  scenePassContext,
} from './record/scene-pass-work';
import { registerScenePipelinePreparation } from './record/scene-pipeline-preparation';
import { encodeSkyboxPass } from './record/skybox-post-pass';
import { selectForwardFragmentEntry } from './record/standard-opaque-entry';
import { prepareTypedScenePipelineDemand } from './record/typed-scene-pipeline-demand';
import { POST_PROCESS_VIEW_UNIFORM_OFFSET, VIEW_UNIFORM_BYTES } from './record/view-ubo';
import {
  STANDARD_OUTPUT_GLARE_FEATURE_ID,
  STANDARD_OUTPUT_SMAA_FEATURE_ID,
  STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
} from './render-contract';
import {
  encodeFullscreenPass,
  type FullscreenPassInputs,
  recordGtaoComputePass,
  recordSsaoBlurPass,
  recordSsaoCalcPass,
  recordSsaoDepthPass,
} from './render-graph-primitives';
import type {
  GpuDrivenDrawPhase,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineSurfaceMediumPair,
} from './render-pipeline';
import {
  createRenderPipelineTarget,
  frameOutputDither,
  type OutputDither,
  type RenderPipelineTarget,
} from './render-pipeline';
import { markPipelinePreparationPending } from './render-system-presentation';
import { projectedProbeCount } from './scene/probe-blend';
import type { DeferredAoNormalLayout } from './ssao-config';
import type { SceneVelocityInputs } from './temporal/default-gbuffer-velocity';
import {
  flickerTerms,
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuWrite,
  TEMPORAL_PARAMS_BYTES,
} from './temporal/gpu';
import { recordContext } from './world/view-record-context';

function resolvedView(resources: GraphResourceResolver, view: GraphTextureView): TextureView {
  const result = resources.textureView(view);
  if (!result.ok) throw result.error;
  return result.value;
}

function throwTemporalEncodeFailure(expected: string, cause?: unknown): never {
  throw new RhiError({
    code: 'webgpu-runtime-error',
    expected,
    hint:
      cause === undefined
        ? 'retry the temporal frame after repairing its GPU resource'
        : String(cause),
  });
}

export function typedFrameClearColor(frame: RenderPipelineFrame): GPUColor {
  return {
    r: frame.clear[0] ?? 0,
    g: frame.clear[1] ?? 0,
    b: frame.clear[2] ?? 0,
    a: frame.clear[3] ?? 1,
  };
}

function depthSampleView(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  label: string,
): Result<GraphTextureView, RenderGraphError> {
  return graph.view(target.texture, {
    label,
    // Multisampling belongs to the texture; its sampled view stays 2d.
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
}

export function addObservationCapturePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  domain: import('./render-contract').FrameObservationDomain,
): Result<void, RenderGraphError> {
  return graph.addCopyPass(
    `${domain}-observation`,
    {
      accesses: [{ resource: target.view, usage: 'copy-src' }],
      encodeDirect: (encoder, frame, resources) => {
        const texture = resources.texture(target.texture);
        if (!texture.ok) throw texture.error;
        const extent = resources.textureViewExtent(target.view);
        if (!extent.ok) throw extent.error;
        const size = { width: extent.value.width, height: extent.value.height };
        const internal = frame as _InternalRenderPipelineContext;
        // The RenderSystem frame counter is the identity used by
        // observeCurrentFrame after this submission. The public receipt counter
        // is intentionally separate and is only used by receipt-bound copies;
        // using observationFrameId here makes a current source look stale by one
        // frame to the legacy same-frame observer.
        if (domain === 'linear-hdr') {
          internal.frameState.frameOutputs.observationSource = {
            texture: texture.value,
            descriptor: {
              texture: texture.value,
              format: target.format,
              size,
              usage:
                GPU_TEXTURE_USAGE_COPY_SRC |
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING,
              sample: target.sampleCount,
            },
            frameId: internal.frameState.frameNumber,
            pipelineId: 'forgeax::standard',
            backendId: frame.runtime.device.caps.backendKind,
          };
          if (target.sampleCount === 1) {
            recordContext(frame.runtime).encodeFramebufferSnapshots?.(encoder, {
              texture: texture.value,
              format: target.format,
              ...size,
              camera: undefined,
              role: 'display',
            });
          }
        }
        encodeFrameObservationCapture(frame.runtime, encoder, {
          texture: texture.value,
          format: target.format,
          domain,
          ...(domain === 'visible-surface'
            ? { surfaceRecords: internal.visibleSurface?.records }
            : {}),
          ...size,
          frameNumber: internal.frameState.frameNumber,
          graphGeneration: frame.runtime.observationGraphGeneration,
        });
      },
    },
    'transfer',
  );
}

export function addTypedSkyboxPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
  sceneDepth?: { readonly target: RenderPipelineTarget; readonly loadOp: GPULoadOp },
): Result<void, RenderGraphError> {
  return graph.addRasterPass('skybox', {
    accesses: [
      ...graph.consumerReads('render-feature.scene'),
      { resource: color.view, usage: 'color-attachment' },
      ...(sceneDepth === undefined
        ? []
        : [{ resource: sceneDepth.target.view, usage: 'depth-stencil-write' as const }]),
    ],
    ...(sceneDepth === undefined
      ? {}
      : {
          depthStencilAttachment: {
            view: sceneDepth.target.view,
            depthClearValue: 0,
            depthLoadOp: sceneDepth.loadOp,
            depthStoreOp: 'store' as const,
            stencilClearValue: 0,
            stencilLoadOp: sceneDepth.loadOp,
            stencilStoreOp: 'store' as const,
          },
        }),
    colorAttachments: [
      {
        view: color.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: typedFrameClearColor,
      },
    ],
    encodeDirect: (pass, frame, _graphresources) => {
      encodeSkyboxPass(
        frame as _InternalRenderPipelineContext,
        pass,
        sceneDepth?.target.format,
        color.format,
      );
    },
  });
}

export type SceneRasterWriter = Pick<
  RenderGraphBuilder<RenderPipelineFrame>,
  'addRasterPass' | 'addSubgraphPass'
>;

export interface TypedScenePassOptions {
  /** The owning view can issue this raster and its before-pass snapshots in physical order. */
  readonly writer?: SceneRasterWriter;
  /** Explicit native command retention for this pass. Ordinary passes encode indirect draws directly. */
  readonly retainIndirectBundles?: boolean;
  /** Stock single-sample transparent phases select their own frame work. */
  readonly currentTransparencyPass?: ScenePassRequest['currentTransparencyPass'];
  /** Native view topology omits before-pass resources when no material reads them. */
  readonly materialSceneDepth?: boolean | undefined;
  /** A renderer-owned selection recipe, re-read for normal recording and candidate demand. */
  readonly selection?: ScenePassSelection;
  /** Raster geometry on the display lattice used by after-tonemap consumers. */
  readonly rasterProjection?: 'unjittered';
  /** The common borrowed frame and this exact pass's prepared draw-work identity. */
  readonly executeIf?:
    | ((frame: RenderPipelineFrame, request: ScenePassRequest) => boolean)
    | undefined;
  readonly selectEntities?: (frame: RenderPipelineFrame) => {
    readonly entities: readonly number[];
  };
  /** Exact atmospheric texture demand of a pass with an admitted stock entry. */
  readonly atmosphereReads?: RasterAtmosphereReads;
  readonly environment?: import('./environment/ibl').GraphEnvironment | undefined;
  readonly name: string;
  /** Omitted (with no colorTargets) for a depth-only pass: no color attachment. */
  readonly color?: RenderPipelineTarget | undefined;
  readonly depth: RenderPipelineTarget;
  readonly resolve?: RenderPipelineTarget | undefined;
  readonly sampled?: readonly RenderPipelineTarget[] | undefined;
  /** Format-specific Graph-owned WaterInfo arrays sampled by water materials. */
  readonly waterInfoTargets?:
    | import('./pipeline/standard-build-context').WaterInfoGraphTargets
    | undefined;
  readonly directionalShadow?: RenderPipelineTarget | undefined;
  readonly spotShadow?: RenderPipelineTarget | undefined;
  /** Stable world-space cloud shadow map sampled by direct-solar receivers. */
  readonly cloudShadow?: RenderPipelineTarget | undefined;
  readonly ssao?: RenderPipelineTarget | undefined;
  readonly selector: PassSelector;
  readonly passKind?: PassKind | undefined;
  /** Explicit geometry fragment entry for owner-internal scene producers. */
  readonly fragmentEntryPoint?: string | undefined;
  readonly colorTargets?: readonly RenderPipelineTarget[] | undefined;
  readonly clearColor?: readonly [number, number, number, number] | undefined;
  readonly colorClearValues?: readonly (readonly [number, number, number, number])[];
  readonly colorLoadOp?: GPULoadOp | readonly GPULoadOp[] | undefined;
  /** Auto lets the graph release resolved MSAA color after its last declared consumer. */
  readonly colorStoreOp?: GPUStoreOp | 'auto' | undefined;
  readonly depthLoadOp?: GPULoadOp | undefined;
  /** The loaded depth is the exact prepass raster of this pass's opaque draws. */
  readonly seededDepth?: boolean | undefined;
  /** The native Forward display can assign depth to the color draw after material admission. */
  readonly forwardDisplayDepth?: 'prepass' | 'color' | 'primed-color';
  /** Standard opaque rasters share their view's prepared rows across physical outputs. */
  readonly standardOpaqueRows?: true;
  /** Preserve nearest transparent fragment depth for downstream medium clipping. */
  readonly transparentDepthWrite?: boolean | undefined;
  /** Main opaque depth has already been written by this view's prepass. */
  readonly opaqueDepthPrimed?: boolean | undefined;
  readonly coverageOnly?: boolean | undefined;
  readonly recordMode?: MaterialRecordMode | undefined;
  /** Graph-paired Surface inputs. The raw depth status is intentionally typed. */
  readonly surfacePair?: RenderPipelineSurfaceMediumPair | undefined;
  /** Nearest-layer color produced by the preceding medium pass. */
  readonly surfaceNearestLayer?: GraphTextureView | undefined;
  /** Nearest-layer depth produced by the preceding medium pass. */
  readonly surfaceNearestDepth?: GraphTextureView | undefined;
  /** Water graph-owned FoamRT sampled by the connected Surface foam branch. */
  readonly surfaceFoamSimulation?: GraphTextureView | undefined;
  readonly surfaceFluidSimulation?: import('./water/fluid-graph').WaterFluidGraphInputs;
  /** Declares the pass's GPU material lane even before its first live projection. */
  readonly gpuDrivenFilter?: RenderPipelineGpuDrivenFilter | undefined;
  /** Exclude material/pass pairs consumed by an earlier graph lane. */
  readonly excludeSelector?: PassSelector | undefined;
  readonly transmissionBackdrop?: GraphTextureView | undefined;
  readonly ssrSource?: { readonly hiZ: GraphTextureView; readonly color: GraphTextureView };
  readonly extraAccesses?: readonly GraphAccess[] | undefined;
  readonly gpuDriven?: RenderPipelineGpuDrivenProjection | undefined;
  /** `late` draws only HZB-revealed GPU items and skips CPU geometry. */
  readonly gpuDrivenPhase?: GpuDrivenDrawPhase | undefined;
}

/** Scene work is detached; a direct helper caller still borrows the incoming frame. */
function detachedScenePassContext(
  frame: RenderPipelineFrame,
  request: Parameters<typeof scenePassContext>[1],
): { -readonly [K in keyof _InternalRenderPipelineContext]: _InternalRenderPipelineContext[K] } {
  const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
  return internal === frame ? { ...internal } : internal;
}

function scenePassFragmentEntryPoint(options: TypedScenePassOptions): string | undefined {
  return (
    options.fragmentEntryPoint ??
    waterRecordPass(options.recordMode)?.[1] ??
    (options.passKind === 'temporal'
      ? 'fs_temporal'
      : options.passKind === 'deferred'
        ? 'fs_gbuffer'
        : options.recordMode === 'single-layer-medium-nearest-layer'
          ? 'fs_nearest_layer'
          : options.recordMode === 'single-layer-medium-color'
            ? 'fs_color'
            : undefined)
  );
}

function addSceneEnvironmentAccesses(accesses: GraphAccess[], options: TypedScenePassOptions) {
  const { environment, atmosphereReads } = options;
  if (environment === undefined) return;
  if (environment.prefilter !== undefined)
    accesses.push({ resource: environment.prefilter, usage: 'sampled-read' });
  if (environment.atmosphere !== undefined)
    accesses.push(...atmosphereAccesses(environment.atmosphere, atmosphereReads));
  accesses.push({ resource: environment.skySh, usage: 'uniform-read' });
}

function typedScenePassAccesses(
  options: TypedScenePassOptions,
  colorTargets: readonly RenderPipelineTarget[],
): GraphAccess[] {
  const accesses: GraphAccess[] = [];
  for (const target of colorTargets)
    accesses.push({ resource: target.view, usage: 'color-attachment' });
  accesses.push({ resource: options.depth.view, usage: 'depth-stencil-write' });
  const sampled = (view: GraphTextureView | undefined) => {
    if (view !== undefined) accesses.push({ resource: view, usage: 'sampled-read' });
  };
  if (options.sampled !== undefined) for (const target of options.sampled) sampled(target.view);
  if (options.waterInfoTargets !== undefined)
    for (const target of options.waterInfoTargets.values()) sampled(target.view);
  sampled(options.cloudShadow?.view);
  sampled(options.ssrSource?.hiZ);
  sampled(options.ssrSource?.color);
  sampled(options.transmissionBackdrop);
  if (options.surfacePair?.rawDepth.status === 'available')
    sampled(options.surfacePair.rawDepth.view);
  if (
    options.recordMode === 'single-layer-medium-color' ||
    options.recordMode === 'water-color' ||
    isWaterForwardColorMode(options.recordMode)
  ) {
    sampled(options.surfaceNearestLayer);
    sampled(options.surfaceNearestDepth);
  }
  sampled(options.surfaceFoamSimulation);
  if (options.surfaceFluidSimulation !== undefined) {
    sampled(options.surfaceFluidSimulation.fields);
    accesses.push({ resource: options.surfaceFluidSimulation.descriptors, usage: 'storage-read' });
  }
  addSceneEnvironmentAccesses(accesses, options);
  // These declarations belong to contributors. Capture them before transferring our pass.
  if (options.extraAccesses !== undefined)
    for (const access of options.extraAccesses) accesses.push({ ...access });
  if (options.gpuDriven !== undefined)
    for (const access of options.gpuDriven.accesses) accesses.push({ ...access });
  for (const target of colorTargets) {
    if (target.resolveTarget !== undefined)
      accesses.push({ resource: target.resolveTarget, usage: 'color-attachment' });
  }
  if (options.resolve !== undefined) {
    accesses.push({ resource: options.resolve.view, usage: 'color-attachment' });
  }
  return accesses;
}

function materialGraphViewsForPass(
  frame: RenderPipelineFrame,
  options: TypedScenePassOptions,
  transmissionBackdrop: TextureView | null,
  surfaceRawDepth: TextureView | null,
  surfaceNearestLayer: TextureView | null,
  surfaceNearestDepth: TextureView | null,
  nativeBackdrop?: NativeMaterialView,
): GraphBindingViews | undefined {
  if (
    transmissionBackdrop === null &&
    surfaceRawDepth === null &&
    surfaceNearestLayer === null &&
    surfaceNearestDepth === null
  )
    return undefined;
  const resources = (frame as _InternalRenderPipelineContext).frameState.compiledFrameGraph
    ?.nativeResources;
  if (resources !== undefined) {
    const views: GraphBindingViews['views'][number][] = [];
    const backdrop = nativeBackdrop ?? options.transmissionBackdrop;
    if (backdrop !== undefined && transmissionBackdrop !== null)
      views.push(['backdrop', backdrop, transmissionBackdrop]);
    if (options.surfacePair?.rawDepth.status === 'available' && surfaceRawDepth !== null)
      views.push(['raw-depth', options.surfacePair.rawDepth.view, surfaceRawDepth]);
    if (options.surfaceNearestLayer !== undefined && surfaceNearestLayer !== null)
      views.push(['nearest-layer', options.surfaceNearestLayer, surfaceNearestLayer]);
    if (options.surfaceNearestDepth !== undefined && surfaceNearestDepth !== null)
      views.push(['nearest-depth', options.surfaceNearestDepth, surfaceNearestDepth]);
    const facts = { resources, views };
    if (views.length > 0 && graphBindingViewsCurrent(facts)) return facts;
  }
  return undefined;
}

function scenePassBindingDemand(
  options: TypedScenePassOptions,
): NonNullable<import('./record/scene-pipeline-preparation').ScenePipelineDemand['bindings']> {
  const keys = [
    'directionalShadow',
    'spotShadow',
    'cloudShadow',
    'ssao',
    'ssrSource',
    'environment',
    'atmosphereReads',
    'transmissionBackdrop',
    'surfacePair',
    'surfaceNearestLayer',
    'surfaceNearestDepth',
  ] as const;
  return Object.freeze(
    Object.fromEntries(
      keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
    ),
  );
}

function assignOptionalMaterialDepth(
  options: { materialSceneDepth?: TextureView },
  resources: GraphResourceResolver,
  depth: GraphTextureView | undefined,
): void {
  if (depth !== undefined) options.materialSceneDepth = resolvedView(resources, depth);
}

type EncodeSceneRaster = (
  pass: RhiRenderPassEncoder,
  frame: RenderPipelineFrame,
  resources: GraphResourceResolver,
  nativeBackdrop?: NativeMaterialView,
) => void;

export interface PhysicalSceneRaster {
  readonly colorFormats: GPUTextureFormat[];
  add(
    graph: Pick<SceneRasterWriter, 'addSubgraphPass'>,
    accesses: GraphAccess[],
    enabled: (frame: RenderPipelineFrame) => boolean,
    encode: EncodeSceneRaster,
    request: ScenePassRequest,
  ): Result<void, RenderGraphError>;
}

function prepareScenePassSkylight(
  internal: ReturnType<typeof detachedScenePassContext>,
  resources: GraphResourceResolver,
  environment: TypedScenePassOptions['environment'],
  forward: boolean,
  colorCount: number,
  hasValidated: boolean,
): MainPassOptions['preparedSkylight'] {
  if (environment !== undefined)
    internal.environmentIbl = {
      skySh: resources.buffer(environment.skySh).unwrap(),
      prefilter: resolvedView(resources, environment.prefilter),
    };
  return forward && colorCount > 0 && hasValidated ? prepareMaterialSkylight(internal) : undefined;
}

function sceneUsesCurrentSkybox(
  options: TypedScenePassOptions,
  firstColorWriter: boolean,
): boolean {
  return firstColorWriter && options.environment === undefined;
}

export function addTypedScenePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedScenePassOptions,
  physical?: PhysicalSceneRaster,
): Result<void, RenderGraphError> {
  const colorTargets = options.colorTargets ?? (options.color === undefined ? [] : [options.color]);
  const validateWaterAttachments = () => {
    const waterPass = waterRecordPass(options.recordMode)?.[0];
    const waterOutputs =
      waterPass === undefined ? undefined : SINGLE_LAYER_WATER_PASS_OUTPUTS[waterPass];
    if (waterOutputs !== undefined) {
      const mismatch = waterOutputs.findIndex(
        (output, index) => colorTargets[index]?.format !== output.format,
      );
      if (colorTargets.length !== waterOutputs.length || mismatch !== -1) {
        const location =
          mismatch === -1 ? Math.min(colorTargets.length, waterOutputs.length) : mismatch;
        const output = waterOutputs[location];
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'Water scene attachments match the selected model/pass output contract',
            hint: 'declare the complete Water attachment roster in WGSL location order',
            detail: {
              passName: options.name,
              resourceLabel: output?.name ?? `color[${location}]`,
              field: `colorAttachments[${location}].format`,
              expected: output?.format ?? 'no attachment',
              actual: colorTargets[location]?.format ?? 'missing attachment',
            },
          }),
        );
      }
    }

    return undefined;
  };
  const attachmentFailure = validateWaterAttachments();
  if (attachmentFailure !== undefined) return attachmentFailure;
  const request = registerScenePass(
    graph,
    {
      selector: options.selector,
      excludeSelector: options.excludeSelector,
      recordMode: options.recordMode,
      passKind: options.passKind ?? 'forward',
      gpu: options.gpuDriven !== undefined,
      gpuFilter: options.gpuDrivenFilter,
      late: options.gpuDrivenPhase === 'late',
      capture: false,
      selectsEntities: options.selectEntities !== undefined,
      ...(options.currentTransparencyPass === undefined
        ? {}
        : { currentTransparencyPass: options.currentTransparencyPass }),
    },
    options.standardOpaqueRows === true && options.selection === undefined,
  );
  const phaseActive = (frame: RenderPipelineFrame) =>
    isCurrentTransparencyPassActive(
      request,
      (frame as _InternalRenderPipelineContext).currentTransparency,
      (frame as _InternalRenderPipelineContext).currentTransmissionDemand,
    );
  const readsDepth = (frame: RenderPipelineFrame) =>
    phaseActive(frame) && ordinaryMaterialDepthDemand(frame, request);
  const currentDepth =
    options.materialSceneDepth !== undefined && options.depth.sampleCount === 1
      ? options.depth.currentMaterialDepthExtent
      : undefined;
  // Depth snapshots identify a physical writer even when several rasters
  // consume one prepared geometry selection.
  const depthWriter = currentDepth === undefined ? undefined : {};
  if (currentDepth !== undefined && depthWriter !== undefined) {
    const producer = addCurrentMaterialDepth(
      options.writer ?? graph,
      options.depth,
      currentDepth,
      depthWriter,
      options.name,
      options.depthLoadOp !== 'load',
      readsDepth,
    );
    if (!producer.ok) return producer;
  }
  const sampledMaterialDepth =
    currentDepth !== undefined || options.materialSceneDepth !== true
      ? ok(undefined)
      : addOrdinaryMaterialDepthSnapshot(
          graph,
          options.depth,
          options.name,
          readsDepth,
          options.depthLoadOp !== 'load',
        );
  if (!sampledMaterialDepth.ok) return sampledMaterialDepth;
  const fragmentEntryPoint = scenePassFragmentEntryPoint(options);
  const formats =
    physical?.colorFormats ?? colorTargets.map((target) => target.format as GPUTextureFormat);
  const sampleCount = colorTargets[0]?.sampleCount ?? options.depth.sampleCount;
  const bundleDescriptor =
    (options.retainIndirectBundles ?? options.gpuDriven?.retainIndirectBundles) === true
      ? {
          colorFormats: formats,
          depthStencilFormat: options.depth.format as GPUTextureFormat,
          sampleCount,
        }
      : undefined;
  const gpuFragmentEntryPoint = selectForwardFragmentEntry({
    passKind: options.passKind ?? 'forward',
    fragmentEntry: fragmentEntryPoint,
    oitAccumulate: options.recordMode === 'oit-accumulate',
    viewOffset: 0,
    atmosphereCapture: false,
  });
  const prepareVisible = (context: _InternalRenderPipelineContext) => {
    if (!enabled(context)) return;
    const selected = detachedScenePassContext(context, request);
    selected.transparentColorFormat = formats[0] as GPUTextureFormat;
    if (formats[1] === 'rgba16float') selected.reflectionFallbackColorFormat = 'rgba16float';
    if (options.rasterProjection === 'unjittered')
      selected.viewBindGroupDynamicOffset = POST_PROCESS_VIEW_UNIFORM_OFFSET;
    requestVisibleForwardPipelines(selected, request.selector, {
      formats,
      sampleCount,
      ...(request.recordMode === undefined ? {} : { recordMode: request.recordMode }),
      ...(request.excludeSelector === undefined
        ? {}
        : { excludeSelector: request.excludeSelector }),
      coverageOnly: options.coverageOnly ?? false,
      opaqueDepthPrimed: options.opaqueDepthPrimed ?? false,
      seededDepth:
        options.seededDepth === true &&
        (options.forwardDisplayDepth !== 'color' || loadForwardDepth(context) === 'load'),
      ...(fragmentEntryPoint === undefined ? {} : { fragmentEntryPoint }),
    });
  };
  const registerDepthVariant = (seededDepth: boolean) =>
    registerScenePipelinePreparation(
      graph,
      (context, artifacts) => {
        const selection = options.selectEntities?.(context);
        const entries =
          options.selectEntities === undefined
            ? context.pipelinePreparationEntries
            : context.pipelinePreparationEntries?.filter(
                (entry) => selection?.entities.includes(entry.source.entityKey) === true,
              );
        // A graph can declare this preparation lane while the current frame has
        // no pending material pipelines. Do not copy its whole context in that case.
        if (entries === undefined || entries.length === 0) return false;
        const matched = prepareTypedScenePipelineDemand(
          {
            ...geometryPipelineRequestContext(context),
            ...(entries === undefined ? {} : { pipelinePreparationEntries: entries }),
            ...(context.materialFrame === undefined
              ? {}
              : { materialFrame: context.materialFrame }),
            frameState: context.frameState,
            selectionCamera: context.camera,
            tonemapActive: context.tonemapActive,
            ...(context.viewBindGroupDynamicOffset === undefined
              ? {}
              : { viewBindGroupDynamicOffset: context.viewBindGroupDynamicOffset }),
            gpuDrivenGeometryLane: context.gpuDrivenGeometryLane,
            hasLocalLights: (context.standardLighting?.prepared.local.length ?? 0) > 0,
            ssao: context.frameState.installedPipelineConfig?.ambientOcclusion?.enabled === true,
            reflectionFallbackDemand: context.reflectionFallbackDemand === true,
            probeBlend:
              projectedProbeCount(context.frameState.probeBlendRecordProjection?.projection) > 0,
          },
          artifacts,
          {
            pass: request,
            formats,
            sampleCount,
            fragmentEntryPoint,
            coverageOnly: options.coverageOnly ?? false,
            transparentDepthWrite: options.transparentDepthWrite ?? false,
            seededDepth,
            opaqueDepthPrimed: options.opaqueDepthPrimed === true,
            ...(options.selectEntities !== undefined || options.selection === undefined
              ? {}
              : { selection: options.selection }),
          },
        );
        if (matched && options.selector !== undefined)
          prepareMainPassGeometryPipelines(
            context,
            options.selector,
            options,
            selectScenePassPipelineEntries(entries, options.selection, context.camera),
          );
        return matched;
      },
      options.selectEntities === undefined
        ? {
            bindings: scenePassBindingDemand(options),
            ...(bundleDescriptor === undefined ? {} : { bundleDescriptor }),
            gpuFragmentEntryPoint,
            gpuPhase: options.gpuDrivenPhase ?? 'all',
            pass: request,
            formats,
            sampleCount,
            fragmentEntryPoint,
            coverageOnly: options.coverageOnly ?? false,
            transparentDepthWrite: options.transparentDepthWrite ?? false,
            seededDepth,
            opaqueDepthPrimed: options.opaqueDepthPrimed === true,
            ...(options.selection === undefined ? {} : { selection: options.selection }),
          }
        : undefined,
      (options.standardOpaqueRows === true || request.recordMode === 'opaque-depth') &&
        request.passKind === 'forward' &&
        options.selectEntities === undefined &&
        options.selection === undefined &&
        seededDepth === (options.seededDepth === true)
        ? prepareVisible
        : undefined,
    );
  registerDepthVariant(options.seededDepth === true);
  if (options.forwardDisplayDepth === 'color') registerDepthVariant(false);
  options.gpuDriven?.registerPipelinePreparation?.(
    formats,
    options.gpuDrivenFilter,
    gpuFragmentEntryPoint,
    options.coverageOnly,
    sampleCount,
    options.seededDepth,
    options.opaqueDepthPrimed,
  );
  // One result object per recording; optional fields need no temporary spread objects.
  const recordOptions = (
    frame: RenderPipelineFrame,
    resources: GraphResourceResolver,
    transmissionBackdrop: TextureView | null,
    surfaceRawDepth: TextureView | null,
    surfaceNearestLayer: TextureView | null,
    surfaceNearestDepth: TextureView | null,
    surfaceFoamSimulation: TextureView | null,
    preparedSkylight: MainPassOptions['preparedSkylight'],
    gpu: RenderPipelineGpuDrivenProjection | undefined,
    nativeBackdrop?: NativeMaterialView,
  ): MainPassOptions => {
    const result: { -readonly [K in keyof MainPassOptions]: MainPassOptions[K] } = {
      sampleCount,
      preparedSkylight,
    };
    if (bundleDescriptor !== undefined) result.bundleDescriptor = bundleDescriptor;
    if (options.selectEntities !== undefined) result.selection = options.selectEntities(frame);
    else if (options.selection !== undefined)
      result.selection = resolveScenePassSelection(options.selection, frame.camera);
    result.colorFormats = formats;
    if (depthWriter === undefined)
      assignOptionalMaterialDepth(result, resources, sampledMaterialDepth.value);
    else {
      const sampled = (
        frame as _InternalRenderPipelineContext
      ).frameState.ordinaryMaterialDepth?.sampled(depthWriter);
      if (sampled !== undefined) result.materialSceneDepth = sampled;
    }
    result.passKind = request.passKind;
    if (request.recordMode !== undefined) result.recordMode = request.recordMode;
    if (options.transparentDepthWrite !== undefined)
      result.transparentDepthWrite = options.transparentDepthWrite;
    if (options.opaqueDepthPrimed !== undefined)
      result.opaqueDepthPrimed = options.opaqueDepthPrimed;
    if (options.coverageOnly !== undefined) result.coverageOnly = options.coverageOnly;
    result.seededDepth =
      options.seededDepth === true &&
      (options.forwardDisplayDepth !== 'color' || loadForwardDepth(frame) === 'load');
    if (request.excludeSelector !== undefined) result.excludeSelector = request.excludeSelector;
    if (options.transmissionBackdrop !== undefined || nativeBackdrop !== undefined)
      result.transmissionBackdropView = transmissionBackdrop;
    if (surfaceRawDepth !== null) result.surfaceRawDepthView = surfaceRawDepth;
    if (surfaceNearestLayer !== null) result.surfaceNearestLayerView = surfaceNearestLayer;
    if (surfaceNearestDepth !== null) result.surfaceNearestDepthView = surfaceNearestDepth;
    if (surfaceFoamSimulation !== null) result.surfaceFoamSimulationView = surfaceFoamSimulation;
    applySurfaceFluidBindings(result, options.surfaceFluidSimulation, resources);
    if (options.waterInfoTargets !== undefined && options.waterInfoTargets.size > 0)
      result.waterFrame = { targets: options.waterInfoTargets, resources };
    const graphViews = materialGraphViewsForPass(
      frame,
      options,
      transmissionBackdrop,
      surfaceRawDepth,
      surfaceNearestLayer,
      surfaceNearestDepth,
      nativeBackdrop,
    );
    if (graphViews !== undefined) result.materialGraphViews = graphViews;
    if (fragmentEntryPoint !== undefined) result.fragmentEntryPoint = fragmentEntryPoint;
    if (gpu !== undefined)
      result.gpuDriven = {
        projection: gpu,
        resources,
        ...(options.gpuDrivenPhase === undefined ? {} : { phase: options.gpuDrivenPhase }),
      };
    if (options.gpuDrivenFilter !== undefined) result.gpuDrivenFilter = options.gpuDrivenFilter;
    return result;
  };
  const accesses = typedScenePassAccesses(options, colorTargets);
  if (sampledMaterialDepth.value !== undefined)
    accesses.push({ resource: sampledMaterialDepth.value, usage: 'sampled-read' });
  graph.appendConsumerReads('render-feature.scene', accesses);
  // The same current writer decides whether the early geometry issues and which
  // depth the opaque raster loads. Resource declarations still cover both outcomes.
  const firstColorWriter =
    options.forwardDisplayDepth === 'color' || options.forwardDisplayDepth === 'primed-color';
  const writesSkybox = sceneUsesCurrentSkybox(options, firstColorWriter);
  const loadForwardDepth = (frame: RenderPipelineFrame): GPULoadOp =>
    (frame as _InternalRenderPipelineContext).forwardColorWritesDepth === true &&
    !(options.gpuDriven?.currentCameraWork?.() ?? options.gpuDriven !== undefined)
      ? 'clear'
      : 'load';
  const enabled = (frame: RenderPipelineFrame) =>
    phaseActive(frame) &&
    (options.forwardDisplayDepth !== 'prepass' || loadForwardDepth(frame) === 'load') &&
    (!request.late || (options.gpuDriven?.currentCameraWork?.() ?? true)) &&
    (options.executeIf?.(frame, request) ?? true);
  const encode: EncodeSceneRaster = (pass, frame, resources, nativeBackdrop) => {
    const gpu = options.gpuDriven?.currentCameraWork?.() === false ? undefined : options.gpuDriven;
    const internal = detachedScenePassContext(frame, request);
    if (writesSkybox && internal.skyboxActive)
      encodeSkyboxPass(internal, pass, options.depth.format, colorTargets[0]?.format);
    const directionalShadow =
      options.directionalShadow === undefined
        ? undefined
        : resolvedView(resources, options.directionalShadow.view);
    const spotShadow =
      options.spotShadow === undefined
        ? undefined
        : resolvedView(resources, options.spotShadow.view);
    const cloudShadow =
      options.cloudShadow === undefined
        ? undefined
        : resolvedView(resources, options.cloudShadow.view);
    const ssao =
      options.ssao === undefined ? undefined : resolvedView(resources, options.ssao.view);
    const transmissionBackdrop =
      nativeBackdrop?.view ??
      (options.transmissionBackdrop === undefined
        ? null
        : resolvedView(resources, options.transmissionBackdrop));
    const surfaceRawDepth =
      options.surfacePair?.rawDepth.status === 'available'
        ? resolvedView(resources, options.surfacePair.rawDepth.view)
        : null;
    const surfaceNearestLayer =
      options.surfaceNearestLayer === undefined
        ? null
        : resolvedView(resources, options.surfaceNearestLayer);
    const surfaceNearestDepth =
      options.surfaceNearestDepth === undefined
        ? null
        : resolvedView(resources, options.surfaceNearestDepth);
    const surfaceFoamSimulation =
      options.surfaceFoamSimulation === undefined
        ? null
        : resolvedView(resources, options.surfaceFoamSimulation);
    // Each pass publishes only the shadow inputs it actually binds. A later
    // selection pass has none and must preserve the main receiver's evidence.
    if (directionalShadow !== undefined)
      internal.frameState.frameOutputs.directionalShadowView = directionalShadow;
    if (spotShadow !== undefined) internal.frameState.frameOutputs.spotShadowView = spotShadow;
    const hasValidated = internal.validatedOrdered.length > 0 || gpu !== undefined;
    const preparedSkylight = prepareScenePassSkylight(
      internal,
      resources,
      options.environment,
      request.passKind === 'forward',
      colorTargets.length,
      hasValidated,
    );
    const targets = {
      sky: preparedSkylight?.skylightResources,
      transmissionBackdrop: transmissionBackdrop ?? undefined,
      planarReflection:
        internal.planarReflectionAllowed === false ? undefined : internal.planarReflectionView,
      forwardScreenSurface: ssao,
      hiZ:
        options.ssrSource === undefined
          ? undefined
          : resolvedView(resources, options.ssrSource.hiZ),
      ssrColor:
        options.ssrSource === undefined
          ? undefined
          : resolvedView(resources, options.ssrSource.color),
      directionalShadow,
      spotShadow,
      cloudShadow,
      atmosphere: atmosphereVolumeViews(
        resources,
        options.environment?.atmosphere,
        options.atmosphereReads,
      ),
      projector: internal.spotLightProjector?.view ?? internal.volumetricFog?.projectorView,
      projectorSampler:
        internal.spotLightProjector?.sampler ?? internal.volumetricFog?.projectorSampler,
    };
    const groups = buildPerFrameBindGroups(
      internal.runtime as RenderSystemInternals,
      internal.frameState,
      internal.pipelineState,
      hasValidated,
      internal.bindGroupCounts,
      targets,
      true,
      internal.standardLighting,
    );
    // GPU-driven indirect draws are encoded by `encodeMainPass` after it
    // has populated the frame-global material bind-group receipt. Encoding
    // here would race that producer and either observe an empty receipt or
    // issue the same indirect draw twice. Keep this wrapper responsible for
    // resolving graph-owned attachments; the main-pass owner orders the
    // material producer before the GPU consumer.
    const gpuDrivenSelection = internal.gpuDrivenSelection;
    // Native Scene Pass work already owns a detached context. Enrich that
    // context once instead of copying the entire frame twice more per Pass.
    const passContext = internal;
    passContext.ordinaryDepthViewTargets = targets;
    passContext.gpuDrivenSelection = gpu === undefined ? undefined : gpuDrivenSelection;
    passContext.transparentColorFormat = formats[0] as GPUTextureFormat;
    if (options.passKind !== 'deferred' && formats[1] === 'rgba16float')
      passContext.reflectionFallbackColorFormat = 'rgba16float';
    passContext.msaaActive = sampleCount === 4;
    passContext.viewBindGroup = groups.viewBindGroup;
    if (options.rasterProjection === 'unjittered')
      passContext.viewBindGroupDynamicOffset = POST_PROCESS_VIEW_UNIFORM_OFFSET;
    passContext.meshBindGroup = groups.meshBindGroup;
    passContext.clusterViewReady = groups.clusterViewReady;
    passContext.hdrpClusterMembershipBindGroup = groups.hdrpClusterMembershipBindGroup;
    encodeMainPass(
      passContext,
      pass,
      request.selector,
      recordOptions(
        frame,
        resources,
        transmissionBackdrop,
        surfaceRawDepth,
        surfaceNearestLayer,
        surfaceNearestDepth,
        surfaceFoamSimulation,
        preparedSkylight,
        gpu,
        nativeBackdrop,
      ),
    );
  };
  const writer = options.writer ?? graph;
  if (physical !== undefined) return physical.add(writer, accesses, enabled, encode, request);
  return writer.addRasterPass(
    options.name,
    {
      accesses,
      executeIf:
        options.executeIf === undefined &&
        options.forwardDisplayDepth !== 'prepass' &&
        request.currentTransparencyPass === undefined &&
        !(request.late && options.gpuDriven?.currentCameraWork !== undefined)
          ? undefined
          : enabled,
      colorAttachments: colorTargets.map((target, index) => ({
        view: target.view,
        ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        ...(index === 0 && options.resolve !== undefined
          ? { resolveTarget: options.resolve.view }
          : {}),
        loadOp:
          (typeof options.colorLoadOp === 'string'
            ? options.colorLoadOp
            : options.colorLoadOp?.[index]) ?? 'clear',
        storeOp: options.colorStoreOp ?? 'store',
        clearValue:
          firstColorWriter && index === 0
            ? typedFrameClearColor
            : {
                r: options.colorClearValues?.[index]?.[0] ?? options.clearColor?.[0] ?? 0,
                g: options.colorClearValues?.[index]?.[1] ?? options.clearColor?.[1] ?? 0,
                b: options.colorClearValues?.[index]?.[2] ?? options.clearColor?.[2] ?? 0,
                a: options.colorClearValues?.[index]?.[3] ?? options.clearColor?.[3] ?? 1,
              },
      })),
      depthStencilAttachment: {
        view: options.depth.view,
        depthClearValue: 0,
        depthLoadOp:
          options.forwardDisplayDepth === 'color'
            ? loadForwardDepth
            : (options.depthLoadOp ?? 'clear'),
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp:
          options.forwardDisplayDepth === 'color'
            ? loadForwardDepth
            : (options.depthLoadOp ?? 'clear'),
        stencilStoreOp: 'store',
      },
      encodeDirect: encode,
    },
    'transfer',
  );
}

export function addTypedFrameObservationPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return addObservationCapturePass(graph, target, 'linear-hdr');
}

/** Publish the same-frame fallback MRT as a detached, copy-readable source. */
export function addReflectionFallbackObservationPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addCopyPass(
    'reflection-fallback-observation',
    {
      accesses: [{ resource: target.view, usage: 'copy-src' }],
      encodeDirect: (_graphencoder, frame, resources) => {
        const internal = frame as _InternalRenderPipelineContext;
        const texture = resources.texture(target.texture);
        if (!texture.ok) throw texture.error;
        internal.frameState.reflectionFallbackObservationSource = {
          texture: texture.value,
          descriptor: {
            texture: texture.value,
            format: target.format,
            size: { width: frame.targetW, height: frame.targetH },
            usage:
              GPU_TEXTURE_USAGE_COPY_SRC |
              GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
              GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            sample: target.sampleCount,
          },
          frameId: internal.frameState.frameNumber,
          pipelineId: 'forgeax::standard',
          backendId: internal.runtime.device.caps.backendKind,
        };
      },
    },
    'transfer',
  );
}

export interface TypedBloomTargets {
  readonly scene: RenderPipelineTarget;
  readonly sources: readonly RenderPipelineTarget[];
  /** Omit when native Grade consumes the accumulated image. */
  readonly composited?: RenderPipelineTarget;
  readonly horizontal: readonly RenderPipelineTarget[];
  readonly vertical: readonly RenderPipelineTarget[];
}

/** The semantic Bloom pass owner; graph inspection consumes these same identities. */
export const TYPED_BLOOM_PASS_NAMES = {
  horizontal: 'bloom-horizontal',
  vertical: 'bloom-vertical',
  composite: 'bloom-composite',
} as const;

export function typedBloomLevelPassName(kind: 'horizontal' | 'vertical', level: number): string {
  return `${TYPED_BLOOM_PASS_NAMES[kind]}-${level}`;
}

export function addTypedBloomPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedBloomTargets,
): Result<RenderPipelineTarget, RenderGraphError> {
  function add(
    name: string,
    stage: BloomStage,
    reads: readonly RenderPipelineTarget[],
    write: RenderPipelineTarget,
    level = 0,
  ): Result<void, RenderGraphError> {
    const inputs = reads.map((target) => target.view);
    const draw = new BloomDraw(
      name,
      stage,
      inputs,
      level,
      targets.sources.length,
      write.format === 'rg11b10ufloat',
    );
    return graph.addRasterPass(
      name,
      {
        accesses: [
          ...inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
          { resource: write.view, usage: 'color-attachment' },
        ],
        colorAttachments: [
          {
            view: write.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        encodeDirect: (pass, frame, resources) =>
          draw.encode(frame as _InternalRenderPipelineContext, pass, resources),
      },
      'transfer',
    );
  }

  const invalidLevels = () =>
    err(
      new RenderGraphError({
        code: 'resource-resolution-failed',
        expected: 'a source, horizontal target and accumulated target for each Bloom level',
        hint: 'derive the targets from the same downsample chain',
        detail: { resourceLabel: 'bloom-downsample-chain' },
      }),
    );
  const finest = targets.vertical[0];
  if (
    finest === undefined ||
    targets.sources.length !== targets.horizontal.length ||
    targets.sources.length !== targets.vertical.length
  )
    return invalidLevels();
  for (let level = targets.sources.length - 1; level >= 0; level--) {
    const source = targets.sources[level];
    const horizontal = targets.horizontal[level];
    const vertical = targets.vertical[level];
    const coarser = targets.vertical[level + 1];
    if (!source || !horizontal || !vertical) return invalidLevels();
    const h = add(
      typedBloomLevelPassName('horizontal', level),
      'horizontal',
      [source],
      horizontal,
      level,
    );
    if (!h.ok) return h;
    const reads = coarser === undefined ? [horizontal] : [horizontal, coarser];
    const v = add(typedBloomLevelPassName('vertical', level), 'vertical', reads, vertical, level);
    if (!v.ok) return v;
  }
  if (targets.composited !== undefined) {
    const composed = add(
      TYPED_BLOOM_PASS_NAMES.composite,
      'composite',
      [targets.scene, finest],
      targets.composited,
    );
    if (!composed.ok) return composed;
  }
  return ok(finest);
}

export interface TypedSsaoTargets {
  /** Absent for a depth-only prepass: AO reconstructs normals from depth. */
  readonly normal?: RenderPipelineTarget | undefined;
  readonly depth: RenderPipelineTarget;
  readonly raw: RenderPipelineTarget;
  readonly blurred: RenderPipelineTarget;
  /** Owner-only acceptance selection; game-facing camera configuration stays algorithm-only. */
  readonly execution?: 'fragment' | 'compute' | undefined;
  /** Selects the exact normal and coverage decoder for a Deferred attachment. */
  readonly gbufferNormalLayout?: DeferredAoNormalLayout | undefined;
}

export function addTypedSsaoPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedSsaoTargets,
): Result<void, RenderGraphError> {
  const depth = depthSampleView(graph, targets.depth, 'typed-ssao-depth-only-view');
  if (!depth.ok) return depth;
  if (targets.normal === undefined) return addTypedSsaoDepthPasses(graph, targets, depth.value);
  return addTypedSsaoNormalPasses(graph, { ...targets, normal: targets.normal }, depth.value);
}

/** Depth-only prepass AO: calc and blur read depth alone (UE normal reconstruction). */
function addTypedSsaoDepthPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedSsaoTargets,
  depth: GraphTextureView,
): Result<void, RenderGraphError> {
  const stage = (
    name: 'ssao-calc' | 'ssao-blur',
    output: RenderPipelineTarget,
    raw?: RenderPipelineTarget,
  ): Result<void, RenderGraphError> =>
    graph.addRasterPass(name, {
      accesses: [
        ...(raw === undefined ? [] : [{ resource: raw.view, usage: 'sampled-read' as const }]),
        { resource: depth, usage: 'sampled-read' },
        { resource: output.view, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: output.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
      encodeDirect: (pass, frame, resources) =>
        recordSsaoDepthPass(
          frame as _InternalRenderPipelineContext,
          raw === undefined ? 'calc' : 'blur',
          pass,
          {
            output: resolvedView(resources, output.view),
            depth: resolvedView(resources, depth),
            raw: raw === undefined ? undefined : resolvedView(resources, raw.view),
          },
        ),
    });
  const calc = stage('ssao-calc', targets.raw);
  if (!calc.ok) return calc;
  return stage('ssao-blur', targets.blurred, targets.raw);
}

function addTypedSsaoNormalPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedSsaoTargets & { readonly normal: RenderPipelineTarget },
  depthView: GraphTextureView,
): Result<void, RenderGraphError> {
  const depth = { value: depthView };
  const gbufferLayout =
    targets.gbufferNormalLayout ??
    (targets.normal.format === 'rg32uint' ? 'standard-gbuffer/2' : undefined);
  const calc =
    targets.execution === 'compute'
      ? graph.addComputePass(
          'gtao-calc-compute',
          {
            accesses: [
              { resource: targets.normal.view, usage: 'sampled-read' },
              { resource: depth.value, usage: 'sampled-read' },
              { resource: targets.raw.view, usage: 'storage-write' },
            ],
            encodeDirect: (pass, frame, resources) => {
              const extent = resources.textureViewExtent(targets.raw.view);
              if (!extent.ok) throw extent.error;
              recordGtaoComputePass(frame as _InternalRenderPipelineContext, pass, {
                gbufferV2: gbufferLayout === 'standard-gbuffer/2',
                output: resolvedView(resources, targets.raw.view),
                normal: resolvedView(resources, targets.normal.view),
                depth: resolvedView(resources, depth.value),
                ...extent.value,
              });
            },
          },
          'transfer',
        )
      : graph.addRasterPass('ssao-calc', {
          accesses: [
            { resource: targets.normal.view, usage: 'sampled-read' },
            { resource: depth.value, usage: 'sampled-read' },
            { resource: targets.raw.view, usage: 'color-attachment' },
          ],
          colorAttachments: [
            {
              view: targets.raw.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 1, g: 1, b: 1, a: 1 },
            },
          ],
          encodeDirect: (pass, frame, resources) => {
            const normal = resolvedView(resources, targets.normal.view);
            const depthView = resolvedView(resources, depth.value);
            recordSsaoCalcPass(
              frame as _InternalRenderPipelineContext,
              undefined,
              undefined,
              undefined,
              undefined,
              pass,
              {
                gbufferLayout,
                output: resolvedView(resources, targets.raw.view),
                normal,
                depth: depthView,
                depthCacheKey: depthView,
              },
            );
          },
        });
  if (!calc.ok) return calc;

  return graph.addRasterPass('ssao-blur', {
    accesses: [
      { resource: targets.raw.view, usage: 'sampled-read' },
      { resource: targets.normal.view, usage: 'sampled-read' },
      { resource: depth.value, usage: 'sampled-read' },
      { resource: targets.blurred.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: targets.blurred.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const normal = resolvedView(resources, targets.normal.view);
      const depthView = resolvedView(resources, depth.value);
      recordSsaoBlurPass(
        frame as _InternalRenderPipelineContext,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        pass,
        {
          gbufferLayout,
          output: resolvedView(resources, targets.blurred.view),
          raw: resolvedView(resources, targets.raw.view),
          normal,
          depth: depthView,
          depthCacheKey: depthView,
        },
      );
    },
  });
}

interface TypedFullscreenPassInputs {
  readonly name: string;
  readonly clearColor?: readonly [number, number, number, number];
  readonly colorLoadOp?: GPULoadOp;
  readonly shader: string;
  /** Optional fragment entry point override for composed fullscreen shaders. */
  readonly fragmentEntryPoint?: string | undefined;
  readonly input: RenderPipelineTarget;
  readonly outputOnly?: boolean | undefined;
  readonly stencil?: {
    readonly target: RenderPipelineTarget;
    readonly mode: NonNullable<PostProcessShaderEntry['stencilMask']>;
  };
  readonly depth?: RenderPipelineTarget | undefined;
  readonly additionalReads?: readonly {
    readonly key: string;
    readonly target: RenderPipelineTarget;
  }[];
  /** Optional per-pass copy of the params UBO payload. */
  readonly paramsTransform?:
    | ((
        params: Uint8Array | undefined,
        frame: RenderPipelineFrame,
        resources: GraphResourceResolver,
      ) => Uint8Array | undefined)
    | undefined;
}

export type TypedFullscreenPassOptions = TypedFullscreenPassInputs &
  (
    | {
        /** Color attachments in fragment location order. */
        readonly outputs: readonly [RenderPipelineTarget, ...RenderPipelineTarget[]];
        readonly depthOutput?: RenderPipelineTarget | undefined;
      }
    | {
        readonly outputs: readonly [];
        /** A depth-only producer must declare its hardware-depth destination. */
        readonly depthOutput: RenderPipelineTarget;
      }
  );

/** Producer reactivity lattice; the declared extent sizes TAA's row copy. */
export interface TemporalSecondaryReactivity {
  readonly view: GraphTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: 'rgba8unorm' | 'r32float';
}

const TAA_REACTIVITY_ROWS_ENTRY = 'fs_secondary_reactivity_rows';
const reactivityRowsEntries = new WeakMap<PostProcessShaderEntry, PostProcessShaderEntry>();
const reactivityRowsLayouts = new WeakMap<object, BindGroupLayout>();

/**
 * Reduce the producer's 7x7 reactivity footprint along rows. When the physical
 * producer and declared copy extents agree, the resolve reads one column of
 * this copy per pixel instead of 49 producer texels. An 8-bit producer keeps
 * its exact 8-bit values.
 */
function addTemporalSecondaryReactivityRows(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: TemporalSecondaryReactivity,
): Result<GraphTextureView, RenderGraphError> {
  const format = source.format === 'rgba8unorm' ? 'r8unorm' : 'r32float';
  const texture = graph.createTexture('taa-secondary-reactivity-rows', {
    format,
    size: { width: source.width, height: source.height },
  });
  if (!texture.ok) return texture;
  const rows = graph.view(texture.value, {
    label: 'taa-secondary-reactivity-rows.view',
    dimension: '2d',
  });
  if (!rows.ok) return rows;
  let binding: { layout: BindGroupLayout; source: TextureView; group: BindGroup } | undefined;
  const added = graph.addRasterPass('taa-secondary-reactivity-rows', {
    accesses: [
      { resource: source.view, usage: 'sampled-read' },
      { resource: rows.value, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: rows.value,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        frame.runtime.device,
        recordContext(frame.runtime as import('./record/render-context').RenderSystemRuntime)
          .deviceScope,
        frame.targetW,
        frame.targetH,
        false,
        frame.camera,
      );
      let layout = reactivityRowsLayouts.get(state);
      if (layout === undefined) {
        const created = frame.runtime.device.createBindGroupLayout({
          label: 'taa-secondary-reactivity-rows-bind-group',
          entries: [
            {
              binding: 10,
              visibility: 2,
              texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
            },
          ],
        });
        if (!created.ok) {
          throwTemporalEncodeFailure('TAA reactivity rows layout creation succeeds', created.error);
        }
        state.childScope._adopt('binding', created.value, () => undefined);
        reactivityRowsLayouts.set(state, created.value);
        layout = created.value;
      }
      const producer = resolvedView(resources, source.view);
      if (binding?.layout !== layout || binding.source !== producer) {
        const group = frame.runtime.device.createBindGroup({
          label: 'taa-secondary-reactivity-rows-bind-group',
          layout,
          entries: [{ binding: 10, resource: { kind: 'textureView', value: producer } }],
        });
        if (!group.ok) {
          throwTemporalEncodeFailure(
            'TAA reactivity rows bind group creation succeeds',
            group.error,
          );
        }
        binding = { layout, source: producer, group: group.value };
      }
      const resolve = frame.runtime.lookupPostProcess?.('forgeax.taa-resolve');
      let entry = resolve === undefined ? undefined : reactivityRowsEntries.get(resolve);
      if (resolve !== undefined && entry === undefined) {
        entry = postProcessFragmentEntry(resolve, TAA_REACTIVITY_ROWS_ENTRY);
        reactivityRowsEntries.set(resolve, entry);
      }
      const pipeline =
        entry === undefined
          ? undefined
          : frame.runtime.getPostProcessPipeline?.('forgeax.taa-resolve', layout, [format], entry);
      if (pipeline === null || pipeline === undefined) {
        throwTemporalEncodeFailure('TAA reactivity rows pipeline is ready before frame encoding');
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, binding.group);
      pass.draw(3, 1, 0, 0);
    },
  });
  if (!added.ok) return added;
  return ok(rows.value);
}

/** UE `r.TSR.ShadingRejection.Flickering` is 1 in the High/Epic/Cinematic AA scalability groups. */
const DEFAULT_TAA_FLICKERING = true;
const lastSampleTimes = new WeakMap<object, number>();

/**
 * Per-frame uniform terms of the UE TSR flickering analysis
 * (TemporalSuperResolution.cpp ~1929-1942, 3012-3014, 2528-2529).
 */
export function flickerParams(
  enabled: boolean,
  sampleTimeSeconds: number | undefined,
  owner: object,
  width: number,
): { enabled: boolean; invThreshold: number; invMaxParallax: number } {
  const previous = lastSampleTimes.get(owner);
  if (sampleTimeSeconds !== undefined) lastSampleTimes.set(owner, sampleTimeSeconds);
  const dt =
    previous !== undefined && sampleTimeSeconds !== undefined && sampleTimeSeconds > previous
      ? sampleTimeSeconds - previous
      : 0;
  return { enabled, ...flickerTerms(dt, width) };
}

/** Packs and uploads the TAA resolve params block (jitter, history, flicker terms). */
function writeTemporalResolveParams(
  frame: _InternalRenderPipelineContext,
  state: ReturnType<typeof getTemporalGpuState>,
  params: NonNullable<ReturnType<typeof getTemporalParamsBuffer>>,
  hasSecondaryReactivity: boolean,
  hasCoverage: boolean,
): void {
  const payload = new ArrayBuffer(TEMPORAL_PARAMS_BYTES);
  new Float32Array(payload).set([
    frame.camera.temporal?.currentJitterUv?.[0] ?? 0,
    frame.camera.temporal?.currentJitterUv?.[1] ?? 0,
  ]);
  const words = new Uint32Array(payload);
  words[2] = state.valid && (frame.camera.temporal?.historyValid ?? true) ? 1 : 0;
  words[3] = frame.camera.temporal?.temporalFrameIndex ?? 0;
  words[4] = Number(hasSecondaryReactivity);
  words[5] = Number(hasCoverage);
  words[6] = Number(hasSecondaryReactivity);
  const flicker = flickerParams(
    frame.camera.taaFlickering ?? DEFAULT_TAA_FLICKERING,
    frame.camera.temporal?.sampleTimeSeconds,
    state,
    frame.targetW,
  );
  words[7] = flicker.enabled ? 1 : 0;
  new Float32Array(payload, 32, 2).set([flicker.invThreshold, flicker.invMaxParallax]);
  const written = frame.runtime.device.queue.writeBuffer(params, 0, new Uint8Array(payload));
  if (!written.ok) throwTemporalEncodeFailure('TAA resolve params upload succeeds', written.error);
}

export interface TypedTemporalResolveTargets {
  readonly scene: RenderPipelineTarget;
  /** Output-domain coverage produced by the Standard raster witness. */
  readonly coverage?: RenderPipelineTarget | undefined;
  /** Paired output-domain depth used to keep the producer observable. */
  readonly coverageDepth?: RenderPipelineTarget | undefined;
  /** Optional producer-owned R-channel reactivity in current screen space. */
  readonly secondaryReactivity?: TemporalSecondaryReactivity | undefined;
  readonly currentTemporal: RenderPipelineTarget;
  readonly sceneVelocity?: SceneVelocityInputs;
  readonly depth: RenderPipelineTarget;
  readonly historyColor: RenderPipelineTarget;
  readonly historyTemporal: RenderPipelineTarget;
  readonly historyStability: RenderPipelineTarget;
  readonly writeColor: RenderPipelineTarget;
  readonly writeTemporal: RenderPipelineTarget;
  readonly writeStability: RenderPipelineTarget;
}

const sceneVelocityTaaEntry = deferredPostProcessEntry({}, () => TAA_SCENE_VELOCITY_WGSL);

/** TAA resolve also carries the UE TSR flickering analysis history (rgba8unorm). */
export interface TypedTaaResolveTargets extends TypedTemporalResolveTargets {
  readonly historyFlicker: RenderPipelineTarget;
  readonly writeFlicker: RenderPipelineTarget;
}

export function addTypedTemporalResolvePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTaaResolveTargets,
): Result<void, RenderGraphError> {
  // This graph has two alternating history inputs. Retain only those exact
  // physical bindings; a changed state, view or resource replaces the oldest.
  const bindings: { sources: readonly unknown[]; group: BindGroup }[] = [];
  let secondaryReactivity: GraphTextureView | undefined;
  if (targets.secondaryReactivity !== undefined) {
    const rows = addTemporalSecondaryReactivityRows(graph, targets.secondaryReactivity);
    if (!rows.ok) return rows;
    secondaryReactivity = rows.value;
  }
  const { sceneVelocity } = targets;
  const entry = sceneVelocity === undefined ? undefined : sceneVelocityTaaEntry;
  const formats = [
    targets.writeColor.format,
    targets.writeTemporal.format,
    targets.writeStability.format,
    targets.writeFlicker.format,
  ] as GPUTextureFormat[];
  const temporalState = (frame: RenderPipelineFrame) =>
    getTemporalGpuState(
      (frame as _InternalRenderPipelineContext).frameState,
      frame.runtime.device,
      recordContext(frame.runtime as import('./record/render-context').RenderSystemRuntime)
        .deviceScope,
      frame.targetW,
      frame.targetH,
      false,
      frame.camera,
    );
  registerScenePipelinePreparation(
    graph,
    (frame) => {
      const lookup = frame.runtime.getPostProcessPipeline;
      if (
        lookup !== undefined &&
        lookup(
          'forgeax.taa-resolve',
          getTemporalBindGroupResources(
            temporalState(frame as RenderPipelineFrame),
            sceneVelocity !== undefined,
          ).layout,
          formats,
          entry,
        ) === null
      ) {
        markPipelinePreparationPending(frame.frameState, {
          code: 'scene-pipeline-preparation',
          pass: 'taa-resolve',
        });
      }
      return false;
    },
    'utility',
  );
  const added = graph.addRasterPass('taa-resolve', {
    accesses: [
      { resource: targets.scene.view, usage: 'sampled-read' },
      { resource: targets.currentTemporal.view, usage: 'sampled-read' },
      ...(sceneVelocity === undefined
        ? []
        : [
            { resource: sceneVelocity.depth, usage: 'sampled-read' as const },
            { resource: sceneVelocity.view, usage: 'uniform-read' as const },
          ]),
      ...(targets.coverage === undefined
        ? []
        : [{ resource: targets.coverage.view, usage: 'sampled-read' as const }]),
      ...(targets.coverageDepth === undefined
        ? []
        : [{ resource: targets.coverageDepth.view, usage: 'sampled-read' as const }]),
      { resource: targets.historyColor.view, usage: 'sampled-read' },
      { resource: targets.historyTemporal.view, usage: 'sampled-read' },
      { resource: targets.historyStability.view, usage: 'sampled-read' },
      { resource: targets.historyFlicker.view, usage: 'sampled-read' },
      ...(targets.secondaryReactivity === undefined
        ? []
        : [{ resource: targets.secondaryReactivity.view, usage: 'sampled-read' as const }]),
      ...(secondaryReactivity === undefined
        ? []
        : [{ resource: secondaryReactivity, usage: 'sampled-read' as const }]),
      { resource: targets.writeColor.view, usage: 'color-attachment' },
      { resource: targets.writeTemporal.view, usage: 'color-attachment' },
      { resource: targets.writeStability.view, usage: 'color-attachment' },
      { resource: targets.writeFlicker.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: targets.writeColor.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
      {
        view: targets.writeTemporal.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
      {
        view: targets.writeStability.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
      {
        view: targets.writeFlicker.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = temporalState(frame);
      const built = getTemporalBindGroupResources(state, sceneVelocity !== undefined);
      const current = resolvedView(resources, targets.scene.view);
      const currentTemporal = resolvedView(resources, targets.currentTemporal.view);
      const historyColor = resolvedView(resources, targets.historyColor.view);
      const historyTemporal = resolvedView(resources, targets.historyTemporal.view);
      const historyStability = resolvedView(resources, targets.historyStability.view);
      const historyFlicker = resolvedView(resources, targets.historyFlicker.view);
      const temporalPlaceholder = sceneVelocity === undefined ? currentTemporal : historyTemporal;
      const depth =
        sceneVelocity === undefined ? undefined : resolvedView(resources, sceneVelocity.depth);
      const view =
        sceneVelocity === undefined ? undefined : resources.buffer(sceneVelocity.view).unwrap();
      const secondarySource =
        targets.secondaryReactivity === undefined
          ? temporalPlaceholder
          : resolvedView(resources, targets.secondaryReactivity.view);
      const params = getTemporalParamsBuffer(state);
      if (params === undefined || built.sampler === null || built.temporalSampler === null) {
        throwTemporalEncodeFailure('TAA resolve has an admitted params buffer and sampler');
      }
      writeTemporalResolveParams(
        internal,
        state,
        params,
        secondaryReactivity !== undefined,
        targets.coverage !== undefined,
      );
      const secondary =
        secondaryReactivity === undefined
          ? temporalPlaceholder
          : resolvedView(resources, secondaryReactivity);
      const coverage =
        targets.coverage === undefined
          ? temporalPlaceholder
          : resolvedView(resources, targets.coverage.view);
      const sources = [
        state,
        frame.runtime.device,
        built.layout,
        built.sampler,
        built.temporalSampler,
        params,
        current,
        currentTemporal,
        historyColor,
        historyTemporal,
        historyStability,
        historyFlicker,
        secondary,
        secondarySource,
        coverage,
        depth,
        view,
      ];
      let binding = bindings.find((candidate) =>
        candidate.sources.every((source, index) => source === sources[index]),
      );
      if (binding === undefined) {
        const bindGroup = frame.runtime.device.createBindGroup({
          label: 'taa-resolve-bind-group',
          layout: built.layout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: current } },
            { binding: 1, resource: { kind: 'sampler', value: built.sampler } },
            { binding: 2, resource: { kind: 'textureView', value: historyColor } },
            { binding: 3, resource: { kind: 'sampler', value: built.sampler } },
            { binding: 4, resource: { kind: 'textureView', value: historyTemporal } },
            { binding: 5, resource: { kind: 'sampler', value: built.temporalSampler } },
            { binding: 6, resource: { kind: 'textureView', value: currentTemporal } },
            { binding: 7, resource: { kind: 'sampler', value: built.temporalSampler } },
            { binding: 8, resource: { kind: 'buffer', value: { buffer: params } } },
            { binding: 9, resource: { kind: 'textureView', value: historyStability } },
            { binding: 13, resource: { kind: 'textureView', value: historyFlicker } },
            {
              binding: 10,
              resource: {
                kind: 'textureView',
                value: secondary,
              },
            },
            {
              binding: 11,
              resource: {
                kind: 'textureView',
                value: coverage,
              },
            },
            {
              binding: 12,
              resource: {
                kind: 'textureView',
                value: secondarySource,
              },
            },
            ...(view === undefined || depth === undefined
              ? []
              : [
                  { binding: 14, resource: { kind: 'textureView', value: depth } },
                  {
                    binding: 15,
                    resource: { kind: 'buffer', value: { buffer: view, size: VIEW_UNIFORM_BYTES } },
                  },
                ]),
          ] as never,
        });
        if (!bindGroup.ok) {
          throwTemporalEncodeFailure('TAA resolve bind group creation succeeds', bindGroup.error);
        }
        binding = { sources, group: bindGroup.value };
        if (bindings.length === 2) bindings.shift();
        bindings.push(binding);
      }
      const pipeline = frame.runtime.getPostProcessPipeline?.(
        'forgeax.taa-resolve',
        built.layout,
        formats,
        entry,
      );
      if (pipeline === null || pipeline === undefined) {
        throwTemporalEncodeFailure('TAA resolve pipeline is ready before frame encoding');
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, binding.group);
      pass.draw(3, 1, 0, 0);
      stageTemporalGpuWrite(internal.frameState, state);
    },
  });
  return added;
}

function fullscreenDepthAttachment(
  options: TypedFullscreenPassOptions,
): RasterDepthStencilAttachment<RenderPipelineFrame> | undefined {
  const target = options.stencil?.target ?? options.depthOutput;
  if (target === undefined) return undefined;
  if (options.stencil?.mode === 'test')
    return { view: target.view, depthReadOnly: true, stencilReadOnly: true };
  return {
    view: target.view,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
    depthClearValue: 0,
    ...(target.format === 'depth24plus-stencil8' || target.format === 'depth32float-stencil8'
      ? { stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 }
      : {}),
  };
}

export function addTypedFullscreenPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedFullscreenPassOptions,
): Result<void, RenderGraphError> {
  const depth =
    options.depth === undefined
      ? undefined
      : depthSampleView(graph, options.depth, `${options.name}.depth-only-view`);
  if (depth !== undefined && !depth.ok) return depth;
  const output = options.outputs[0] ?? (options.depthOutput as RenderPipelineTarget);
  const named = new Map<string, GraphTextureView>([
    ['input', options.input.view],
    ['output', output.view],
    ['ldrColor', options.input.view],
    ['scene-color', options.input.view],
  ]);
  if (options.depth !== undefined) named.set('scene-depth', options.depth.view);
  for (const read of options.additionalReads ?? []) named.set(read.key, read.target.view);
  const inputs: FullscreenPassInputs = {
    name: options.name,
    shader: options.shader,
    input: named.get('input') ?? options.input.view,
    depth: depth?.value,
    named,
    outputFormats: options.outputs.map((target) => target.format as GPUTextureFormat),
    fragmentEntryPoint: options.fragmentEntryPoint,
    msaaDepth: options.depth === undefined ? undefined : options.depth.sampleCount === 4,
  };
  const depthStencilAttachment = fullscreenDepthAttachment(options);
  return graph.addRasterPass(options.name, {
    accesses: [
      { resource: options.input.view, usage: 'sampled-read' },
      ...options.outputs.map((target) => ({
        resource: target.view,
        usage: 'color-attachment' as const,
      })),
      ...(depthStencilAttachment === undefined
        ? []
        : [
            {
              resource: depthStencilAttachment.view,
              usage:
                depthStencilAttachment.depthReadOnly === true
                  ? ('depth-stencil-read' as const)
                  : ('depth-stencil-write' as const),
            },
          ]),
      ...(depth === undefined ? [] : [{ resource: depth.value, usage: 'sampled-read' as const }]),
      ...(options.additionalReads?.map((read) => ({
        resource: read.target.view,
        usage: 'sampled-read' as const,
      })) ?? []),
    ],
    colorAttachments: options.outputs.map((target) => ({
      view: target.view,
      loadOp: options.colorLoadOp ?? 'clear',
      storeOp: 'store',
      clearValue: {
        r: options.clearColor?.[0] ?? 0,
        g: options.clearColor?.[1] ?? 0,
        b: options.clearColor?.[2] ?? 0,
        a: options.clearColor?.[3] ?? 1,
      },
    })),
    depthStencilAttachment,
    encodeDirect: (pass, frame, resources) => {
      if (options.outputOnly && frame.runtime.lookupPostProcess?.(options.shader) === undefined) {
        return;
      }
      encodeFullscreenPass(
        frame,
        pass,
        inputs,
        resources,
        options.paramsTransform?.(frame.postProcessParams.get(inputs.shader), frame, resources),
      );
    },
  });
}

export function addTypedCompositePostEffects(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  effects: readonly string[],
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  let currentInput = input;
  for (const [index, shader] of effects.entries()) {
    const effectOutput =
      index === effects.length - 1
        ? ok(output)
        : createRenderPipelineTarget(graph, `post-effect-output-${index}`, {
            format: output.format as GPUTextureFormat,
            size: 'surface',
            domain: 'display-encoded',
          });
    if (!effectOutput.ok) return effectOutput;
    const effect = addTypedFullscreenPass(graph, {
      name: `post-effect-${index}`,
      shader,
      input: currentInput,
      outputs: [effectOutput.value],
      depth,
    });
    if (!effect.ok) return effect;
    currentInput = effectOutput.value;
  }
  return ok(undefined);
}

export function addTypedOutputTransformPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  options: {
    readonly outputOnly?: boolean;
    readonly dither?: OutputDither;
    readonly glare?: RenderPipelineTarget | undefined;
    readonly smaaWeights?: RenderPipelineTarget | undefined;
    readonly name?: string | undefined;
    readonly fragmentEntryPoint?: string | undefined;
    /**
     * The build context's requested receipt-bound domains. The pass captures
     * each one it exposes: linear-LDR input on the encode-only split, and
     * final-sRGB output on every entry that display-encodes.
     */
    readonly observationCaptureDomains?:
      | readonly import('./render-contract').FrameObservationDomain[]
      | undefined;
  } = {},
): Result<void, RenderGraphError> {
  const outputOnly = options.outputOnly ?? false;
  const requested = options.observationCaptureDomains ?? [];
  if (options.fragmentEntryPoint === 'fs_encode_only' && requested.includes('linear-ldr')) {
    const ldrCapture = addObservationCapturePass(graph, input, 'linear-ldr');
    if (!ldrCapture.ok) return ldrCapture;
  }
  const { glare, smaaWeights } = options;
  const fragmentEntryPoint =
    smaaWeights !== undefined
      ? 'fs_smaa_encode'
      : glare === undefined
        ? options.fragmentEntryPoint
        : options.fragmentEntryPoint === 'fs_tone_only'
          ? 'fs_tone_glare'
          : 'fs_glare';
  const uniform = new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize);
  const values = new DataView(uniform.buffer);
  const transformed = addTypedFullscreenPass(graph, {
    name: options.name ?? (outputOnly ? 'present' : 'output-transform'),
    shader:
      smaaWeights !== undefined
        ? STANDARD_OUTPUT_SMAA_FEATURE_ID
        : glare === undefined
          ? STANDARD_OUTPUT_TRANSFORM_FEATURE_ID
          : STANDARD_OUTPUT_GLARE_FEATURE_ID,
    additionalReads:
      smaaWeights !== undefined
        ? [{ key: 'smaa-weights', target: smaaWeights }]
        : glare === undefined
          ? []
          : [{ key: 'glare', target: glare }],
    input,
    outputs: [output],
    outputOnly,
    paramsTransform: (selected, frame, resources): Uint8Array | undefined => {
      const params = selected ?? frame.postProcessParams.get(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
      if (params === undefined || params.byteLength !== TONEMAP_PARAMS_LAYOUT.byteSize) {
        return params;
      }
      const extent = resources.textureViewExtent(output.view);
      if (!extent.ok) throw extent.error;
      uniform.set(params);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputWidthOffset, extent.value.width, true);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputHeightOffset, extent.value.height, true);
      if (options.dither !== undefined) {
        values.setFloat32(
          TONEMAP_PARAMS_LAYOUT.ditherOffset,
          frameOutputDither(options.dither, frame) ? 1 : 0,
          true,
        );
      }
      return uniform;
    },
    fragmentEntryPoint,
  });
  if (!transformed.ok) return transformed;
  if (options.fragmentEntryPoint !== 'fs_tone_only' && requested.includes('final-display')) {
    const finalCapture = addObservationCapturePass(graph, output, 'final-display');
    if (!finalCapture.ok) return finalCapture;
  }
  return ok(undefined);
}

/** Resolve the typed fluid ports through the current pass resource authority. */
function applySurfaceFluidBindings(
  result: { surfaceFluidSimulation?: MainPassOptions['surfaceFluidSimulation'] },
  input: TypedScenePassOptions['surfaceFluidSimulation'],
  resources: GraphResourceResolver,
): void {
  if (input === undefined) return;
  result.surfaceFluidSimulation = {
    fields: resolvedView(resources, input.fields),
    descriptors: resources.buffer(input.descriptors).unwrap(),
  };
}
