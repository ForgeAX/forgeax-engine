import {
  type GraphAccess,
  type GraphResourceResolver,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
  type ResolveContext,
} from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupLayout,
  RhiError,
  type TextureView,
} from '@forgeax/engine-rhi';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { err, ok, type PassKind, type PassSelector, type Result } from '@forgeax/engine-types';
import { atmosphereTextures } from './environment/luts';
import type { PostProcessShaderEntry } from './fullscreen-post-process-pass';
import { prepareHiddenGpuDrivenPipelines } from './gpu-driven/material-artifacts';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';
import { renderExtentSize } from './pipeline/render-extent';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import type { ValidatedRenderable } from './record/frame-snapshot';
import {
  encodeMainPass,
  hasMainPassPipelinePreparation,
  prepareMainPassPipelines,
} from './record/main-pass';
import { encodeFrameObservationCapture } from './record/observation-capture';
import { sceneRenderBundleCache } from './record/render-bundle-cache';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from './record/render-context';
import { registerScenePass, scenePassContext } from './record/scene-pass-work';
import { registerScenePipelinePreparation } from './record/scene-pipeline-preparation';
import {
  encodeSkyboxPass,
  recordBloomBlurPass,
  recordBloomCompositePass,
} from './record/skybox-post-pass';
import { selectForwardFragmentEntry } from './record/standard-opaque-entry';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from './render-contract';
import {
  encodeFullscreenPass,
  recordSsaoBlurPass,
  recordSsaoCalcPass,
} from './render-graph-primitives';
import type {
  GpuDrivenDrawPhase,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineSurfaceMediumPair,
} from './render-pipeline';
import { createRenderPipelineTarget, type RenderPipelineTarget } from './render-pipeline';
import { markPipelinePreparationPending } from './render-system-presentation';
import {
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuWrite,
} from './temporal/gpu';

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
  return graph.addCopyPass(`${domain}-observation`, {
    accesses: [{ resource: target.view, usage: 'copy-src' }],
    encode: ({ encoder, frame, resources }) => {
      const texture = resources.texture(target.texture);
      if (!texture.ok) throw texture.error;
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
            size: { width: frame.targetW, height: frame.targetH },
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
          const size =
            frame.extent === undefined
              ? { width: frame.targetW, height: frame.targetH }
              : renderExtentSize(frame.extent, 'internal');
          frame.runtime.encodeFramebufferSnapshots?.(encoder, {
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
        width: frame.targetW,
        height: frame.targetH,
        frameNumber: internal.frameState.frameNumber,
        graphGeneration: internal.frameState.graphGeneration,
      });
    },
  });
}

function legacyResolver(
  resources: GraphResourceResolver,
  targets: Readonly<Record<string, RenderPipelineTarget>>,
): ResolveContext {
  return {
    resolve: (name) => {
      const target = targets[name];
      return target === undefined ? undefined : resolvedView(resources, target.view);
    },
  };
}

export function addTypedSkyboxPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addRasterPass('skybox', {
    accesses: [{ resource: color.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: color.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: typedFrameClearColor,
      },
    ],
    encode: ({ pass, frame }) => encodeSkyboxPass(frame as _InternalRenderPipelineContext, pass),
  });
}

export interface TypedScenePassOptions {
  readonly executeIf?: ((frame: RenderPipelineFrame) => boolean) | undefined;
  readonly selectEntities?: (frame: RenderPipelineFrame) => {
    readonly worldId: number;
    readonly entities: readonly number[];
  };
  readonly environment?: import('./environment/ibl').GraphEnvironment | undefined;
  readonly name: string;
  readonly color: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly resolve?: RenderPipelineTarget | undefined;
  readonly sampled?: readonly RenderPipelineTarget[] | undefined;
  readonly directionalShadow?: RenderPipelineTarget | undefined;
  readonly spotShadow?: RenderPipelineTarget | undefined;
  readonly shadowMoments?: RenderPipelineTarget | undefined;
  /** Stable world-space cloud shadow map sampled by direct-solar receivers. */
  readonly cloudShadow?: RenderPipelineTarget | undefined;
  readonly ssao?: RenderPipelineTarget | undefined;
  readonly selector: PassSelector;
  readonly passKind?: PassKind | undefined;
  readonly colorTargets?: readonly RenderPipelineTarget[] | undefined;
  readonly clearColor?: readonly [number, number, number, number] | undefined;
  readonly colorClearValues?: readonly (readonly [number, number, number, number])[];
  readonly colorLoadOp?: GPULoadOp | readonly GPULoadOp[] | undefined;
  readonly depthLoadOp?: GPULoadOp | undefined;
  /** Preserve nearest transparent fragment depth for downstream medium clipping. */
  readonly transparentDepthWrite?: boolean | undefined;
  readonly coverageOnly?: boolean | undefined;
  readonly recordMode?:
    | 'opaque'
    | 'transmission'
    | 'transparent'
    | 'translucent-before-transmission'
    | 'translucent'
    | 'oit-accumulate'
    | 'oit-residual'
    | 'single-layer-medium-nearest-layer'
    | 'single-layer-medium-color'
    | undefined;
  /** Graph-paired Surface inputs. The raw depth status is intentionally typed. */
  readonly surfacePair?: RenderPipelineSurfaceMediumPair | undefined;
  /** Nearest-layer color produced by the preceding medium pass. */
  readonly surfaceNearestLayer?: GraphTextureView | undefined;
  /** Nearest-layer depth produced by the preceding medium pass. */
  readonly surfaceNearestDepth?: GraphTextureView | undefined;
  /** Declares the pass's GPU material lane even before its first live projection. */
  readonly gpuDrivenFilter?: RenderPipelineGpuDrivenFilter | undefined;
  /** Exclude material/pass pairs consumed by an earlier graph lane. */
  readonly excludeSelector?: PassSelector | undefined;
  readonly transmissionBackdrop?: GraphTextureView | undefined;
  readonly extraAccesses?: readonly GraphAccess[] | undefined;
  readonly gpuDriven?: RenderPipelineGpuDrivenProjection | undefined;
  /** `late` draws only HZB-revealed GPU items and skips CPU geometry. */
  readonly gpuDrivenPhase?: GpuDrivenDrawPhase | undefined;
}

export function addTypedScenePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedScenePassOptions,
): Result<void, RenderGraphError> {
  const request = registerScenePass(graph, {
    selector: options.selector,
    excludeSelector: options.excludeSelector,
    recordMode: options.recordMode,
    passKind: options.passKind ?? 'forward',
    gpu: options.gpuDriven !== undefined,
    gpuFilter: options.gpuDrivenFilter,
    late: options.gpuDrivenPhase === 'late',
    capture: false,
  });
  const colorTargets = options.colorTargets ?? [options.color];
  const fragmentEntryPoint =
    options.passKind === 'temporal'
      ? 'fs_temporal'
      : options.passKind === 'deferred'
        ? 'fs_gbuffer'
        : options.recordMode === 'single-layer-medium-nearest-layer'
          ? 'fs_nearest_layer'
          : options.recordMode === 'single-layer-medium-color'
            ? 'fs_color'
            : undefined;
  const formats = colorTargets.map((target) => target.format);
  const sampleCount = colorTargets[0]?.sampleCount ?? options.depth.sampleCount;
  registerScenePipelinePreparation(graph, (context, artifacts) => {
    const selection = options.selectEntities?.(context);
    const entries =
      options.selectEntities === undefined
        ? context.pipelinePreparationEntries
        : context.pipelinePreparationEntries?.filter(
            (entry) =>
              selection !== undefined &&
              selection.worldId === entry.source.worldId &&
              selection.entities.includes(entry.source.entityKey),
          );
    const preparedContext = { ...context, pipelinePreparationEntries: entries ?? [] };
    if (
      !hasMainPassPipelinePreparation(
        preparedContext,
        options.selector,
        options.recordMode,
        options.excludeSelector,
      )
    )
      return false;
    const gpuDraws = new Map<ValidatedRenderable, Set<number>>();
    const factory = context.runtime.prepareMaterialShaderPipelineEntry;
    if (
      (options.gpuDriven !== undefined ||
        (options.gpuDrivenFilter !== undefined &&
          context.gpuDrivenGeometryLane === 'automatic' &&
          context.pipelineState.gpuDrivenInstancesBindGroupLayout != null)) &&
      factory !== undefined &&
      !prepareHiddenGpuDrivenPipelines({
        entries: entries ?? [],
        materials: context.materialFrame,
        resolve: (shader, request) =>
          context.runtime.getMaterialShaderArtifact?.(shader, {
            ...(typeof request === 'boolean' ? { vertexColorAvailable: request } : request),
            clustered:
              context.standardLighting?.kind === 'clustered' &&
              (context.standardLighting.prepared.local.length > 0 ||
                context.frameState.installedPipelineConfig?.ssao?.enabled === true),
            probeBlend:
              (context.frameState.probeBlendRecordProjection?.projection.records.length ?? 0) > 0,
            reflectionFallback: context.frameState.reflectionFallbackDemand === true,
          }),
        artifacts,
        factory,
        formats,
        sampleCount,
        shaderUvSetCount: context.pipelineState.standardPbrShaderUvSetCount,
        filter: options.gpuDrivenFilter,
        fragmentEntry: selectForwardFragmentEntry({
          passKind: options.passKind ?? 'forward',
          fragmentEntry: fragmentEntryPoint,
          oitAccumulate: options.recordMode === 'oit-accumulate',
          viewOffset: 0,
          atmosphereCapture: false,
        }),
        coverageOnly: options.coverageOnly ?? false,
        visibleSurface: context.visibleSurface !== undefined,
        // Prewarm the common no-clipping Standard variant; GPU-driven raster
        // prepares a clipping view's own variant from its camera.
        onSelected: (entry, index) => {
          let draws = gpuDraws.get(entry);
          if (draws === undefined) {
            draws = new Set();
            gpuDraws.set(entry, draws);
          }
          draws.add(index);
        },
        onPending: (reason) => markPipelinePreparationPending(context.frameState, reason),
      })
    )
      markPipelinePreparationPending(context.frameState, { code: 'scene-pipeline-preparation' });
    prepareMainPassPipelines(
      preparedContext,
      options.selector,
      {
        ...(options.passKind === undefined ? {} : { passKind: options.passKind }),
        ...(options.recordMode === undefined ? {} : { recordMode: options.recordMode }),
        ...(options.excludeSelector === undefined
          ? {}
          : { excludeSelector: options.excludeSelector }),
        ...(options.coverageOnly === undefined ? {} : { coverageOnly: options.coverageOnly }),
        ...(fragmentEntryPoint === undefined ? {} : { fragmentEntryPoint }),
        ...(options.transparentDepthWrite === undefined
          ? {}
          : { transparentDepthWrite: options.transparentDepthWrite }),
      },
      sampleCount,
      formats,
      (entry, index) => gpuDraws.get(entry)?.has(index) === true,
    );
    return true;
  });
  options.gpuDriven?.registerPipelinePreparation?.(
    colorTargets.map((target) => target.format),
    options.gpuDrivenFilter,
    selectForwardFragmentEntry({
      passKind: options.passKind ?? 'forward',
      fragmentEntry: fragmentEntryPoint,
      oitAccumulate: options.recordMode === 'oit-accumulate',
      viewOffset: 0,
      atmosphereCapture: false,
    }),
    options.coverageOnly,
  );
  const bundleDescriptor = {
    colorFormats: colorTargets.map((target) => target.format as GPUTextureFormat),
    depthStencilFormat: options.depth.format as GPUTextureFormat,
    sampleCount: colorTargets[0]?.sampleCount ?? options.depth.sampleCount,
  };
  const accesses: GraphAccess[] = [
    ...colorTargets.map((target) => ({
      resource: target.view,
      usage: 'color-attachment' as const,
    })),
    { resource: options.depth.view, usage: 'depth-stencil-write' },
    ...(options.sampled ?? []).map((target) => ({
      resource: target.view,
      usage: 'sampled-read' as const,
    })),
    ...(options.cloudShadow === undefined
      ? []
      : [{ resource: options.cloudShadow.view, usage: 'sampled-read' as const }]),
    ...(options.transmissionBackdrop === undefined
      ? []
      : [{ resource: options.transmissionBackdrop, usage: 'sampled-read' as const }]),
    ...(options.surfacePair?.rawDepth.status === 'available'
      ? [{ resource: options.surfacePair.rawDepth.view, usage: 'sampled-read' as const }]
      : []),
    ...(options.recordMode === 'single-layer-medium-color' &&
    options.surfaceNearestLayer !== undefined
      ? [{ resource: options.surfaceNearestLayer, usage: 'sampled-read' as const }]
      : []),
    ...(options.recordMode === 'single-layer-medium-color' &&
    options.surfaceNearestDepth !== undefined
      ? [{ resource: options.surfaceNearestDepth, usage: 'sampled-read' as const }]
      : []),
    ...(options.environment === undefined
      ? []
      : [
          options.environment.irradiance,
          options.environment.prefilter,
          ...(options.environment.atmosphere === undefined
            ? []
            : atmosphereTextures(options.environment.atmosphere)),
        ].map((resource) => ({
          resource,
          usage: 'sampled-read' as const,
        }))),
    ...(options.extraAccesses ?? []),
    ...(options.gpuDriven?.accesses ?? []),
  ];
  for (const target of colorTargets) {
    if (target.resolveTarget !== undefined)
      accesses.push({ resource: target.resolveTarget, usage: 'color-attachment' });
  }
  if (options.resolve !== undefined) {
    accesses.push({ resource: options.resolve.view, usage: 'color-attachment' });
  }
  return graph.addRasterPass(options.name, {
    accesses,
    executeIf:
      options.executeIf === undefined
        ? undefined
        : (frame) =>
            options.executeIf?.(
              scenePassContext(frame as _InternalRenderPipelineContext, request),
            ) ?? true,
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
      storeOp: 'store',
      clearValue: {
        r: options.colorClearValues?.[index]?.[0] ?? options.clearColor?.[0] ?? 0,
        g: options.colorClearValues?.[index]?.[1] ?? options.clearColor?.[1] ?? 0,
        b: options.colorClearValues?.[index]?.[2] ?? options.clearColor?.[2] ?? 0,
        a: options.colorClearValues?.[index]?.[3] ?? options.clearColor?.[3] ?? 1,
      },
    })),
    depthStencilAttachment: {
      view: options.depth.view,
      depthClearValue: 0,
      depthLoadOp: options.depthLoadOp ?? 'clear',
      depthStoreOp: 'store',
      stencilClearValue: 0,
      stencilLoadOp: options.depthLoadOp ?? 'clear',
      stencilStoreOp: 'store',
    },
    encode: ({ pass, frame, resources }) => {
      const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
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
        options.transmissionBackdrop === undefined
          ? null
          : resolvedView(resources, options.transmissionBackdrop);
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
      // Each pass publishes only the shadow inputs it actually binds. A later
      // selection pass has none and must preserve the main receiver's evidence.
      if (directionalShadow !== undefined)
        internal.frameState.frameOutputs.directionalShadowView = directionalShadow;
      if (spotShadow !== undefined) internal.frameState.frameOutputs.spotShadowView = spotShadow;
      const groups = buildPerFrameBindGroups(
        internal.runtime as RenderSystemInternals,
        internal.frameState,
        internal.pipelineState,
        internal.validatedOrdered.length > 0 || options.gpuDriven !== undefined,
        internal.bindGroupCounts,
        {
          directionalShadow,
          spotShadow,
          shadowMoments:
            options.shadowMoments === undefined
              ? undefined
              : resolvedView(resources, options.shadowMoments.view),
          cloudShadow,
          atmosphere:
            options.environment?.atmosphere === undefined
              ? undefined
              : {
                  distantSkyLight: resolvedView(
                    resources,
                    options.environment.atmosphere.distantSkyLight,
                  ),
                  transmittance: resolvedView(
                    resources,
                    options.environment.atmosphere.transmittance,
                  ),
                  multipleScattering: resolvedView(
                    resources,
                    options.environment.atmosphere.multipleScattering,
                  ),
                  aerialPerspective: resolvedView(
                    resources,
                    options.environment.atmosphere.aerialPerspective,
                  ),
                  aerialTransmittance: resolvedView(
                    resources,
                    options.environment.atmosphere.aerialTransmittance,
                  ),
                },
          projector: internal.spotLightProjector?.view ?? internal.volumetricFog?.projectorView,
          projectorSampler:
            internal.spotLightProjector?.sampler ?? internal.volumetricFog?.projectorSampler,
        },
        true,
        internal.standardLighting,
      );
      // GPU-driven indirect draws are encoded by `encodeMainPass` after it
      // has populated the frame-global material bind-group receipt. Encoding
      // here would race that producer and either observe an empty receipt or
      // issue the same indirect draw twice. Keep this wrapper responsible for
      // resolving graph-owned attachments; the main-pass owner orders the
      // material producer before the GPU consumer.
      const { gpuDrivenSelection, ...directContext } = internal;
      const passContext: _InternalRenderPipelineContext = {
        ...directContext,
        ...(options.gpuDriven === undefined || gpuDrivenSelection === undefined
          ? {}
          : { gpuDrivenSelection }),
        ...(options.environment === undefined
          ? {}
          : {
              environmentIbl: {
                irradiance: resolvedView(resources, options.environment.irradiance),
                prefilter: resolvedView(resources, options.environment.prefilter),
              },
            }),
        transparentColorFormat: colorTargets[0]?.format as GPUTextureFormat,
        ...(options.passKind !== 'deferred' && colorTargets[1]?.format === 'rgba16float'
          ? { reflectionFallbackColorFormat: 'rgba16float' as const }
          : {}),
        msaaActive: colorTargets[0]?.sampleCount === 4,
        viewBindGroup: groups.viewBindGroup,
        meshBindGroup: groups.meshBindGroup,
        hdrpClusterBindGroup: groups.hdrpClusterBindGroup,
        hdrpClusterMembershipBindGroup: groups.hdrpClusterMembershipBindGroup,
        ...(ssao === undefined ? {} : { hdrpSsaoBlurredView: ssao }),
      };
      sceneRenderBundleCache(internal.frameState, options.name, bundleDescriptor).encode(
        internal.runtime.device,
        pass,
        (bundledPass) => {
          encodeMainPass(passContext, bundledPass, request.selector, {
            bundleDescriptor,
            ...(options.selectEntities === undefined
              ? {}
              : { selection: options.selectEntities(frame) }),
            colorFormats: colorTargets.map((target) => target.format as GPUTextureFormat),
            passKind: request.passKind,
            ...(request.recordMode === undefined ? {} : { recordMode: request.recordMode }),
            ...(options.transparentDepthWrite === undefined
              ? {}
              : { transparentDepthWrite: options.transparentDepthWrite }),
            ...(options.coverageOnly === undefined ? {} : { coverageOnly: options.coverageOnly }),
            ...(request.excludeSelector === undefined
              ? {}
              : { excludeSelector: request.excludeSelector }),
            ...(options.transmissionBackdrop === undefined
              ? {}
              : { transmissionBackdropView: transmissionBackdrop }),
            ...(surfaceRawDepth === null ? {} : { surfaceRawDepthView: surfaceRawDepth }),
            ...(surfaceNearestLayer === null
              ? {}
              : { surfaceNearestLayerView: surfaceNearestLayer }),
            ...(surfaceNearestDepth === null
              ? {}
              : { surfaceNearestDepthView: surfaceNearestDepth }),
            ...(fragmentEntryPoint === undefined ? {} : { fragmentEntryPoint }),
            ...(options.gpuDriven === undefined
              ? {}
              : {
                  gpuDriven: {
                    projection: options.gpuDriven,
                    resources,
                    ...(options.gpuDrivenPhase === undefined
                      ? {}
                      : { phase: options.gpuDrivenPhase }),
                  },
                }),
            ...(options.gpuDrivenFilter === undefined
              ? {}
              : { gpuDrivenFilter: options.gpuDrivenFilter }),
          });
        },
        internal.frameState.renderBundleCounters,
      );
    },
  });
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
  return graph.addCopyPass('reflection-fallback-observation', {
    accesses: [{ resource: target.view, usage: 'copy-src' }],
    encode: ({ frame, resources }) => {
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
  });
}

export interface TypedBloomTargets {
  readonly scene: RenderPipelineTarget;
  readonly composited: RenderPipelineTarget;
  readonly horizontal: readonly RenderPipelineTarget[];
  readonly vertical: readonly RenderPipelineTarget[];
  readonly levelDimensions: readonly { readonly width: number; readonly height: number }[];
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
): Result<void, RenderGraphError> {
  const named: Record<string, RenderPipelineTarget> = {
    hdrColor: targets.scene,
    hdrComposited: targets.composited,
  };
  targets.horizontal.forEach((target, level) => {
    named[`bloomHorizontal${level}`] = target;
  });
  targets.vertical.forEach((target, level) => {
    named[`bloomVertical${level}`] = target;
  });

  const add = (
    name: string,
    reads: readonly RenderPipelineTarget[],
    write: RenderPipelineTarget,
    encode: (
      frame: _InternalRenderPipelineContext,
      resolve: ResolveContext,
      pass: import('@forgeax/engine-rhi').RhiRenderPassEncoder,
      level?: number,
      size?: { readonly width: number; readonly height: number },
    ) => void,
    level?: number,
  ): Result<void, RenderGraphError> => {
    const descriptor = {
      name,
      reads,
      write,
      encode,
      level,
    };
    const added = graph.addRasterPass(descriptor.name, {
      accesses: [
        ...descriptor.reads.map((target) => ({
          resource: target.view,
          usage: 'sampled-read' as const,
        })),
        { resource: descriptor.write.view, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: descriptor.write.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      encode: ({ pass, frame, resources }) =>
        descriptor.encode(
          frame as _InternalRenderPipelineContext,
          legacyResolver(resources, named),
          pass,
          descriptor.level,
          descriptor.level === undefined ? undefined : targets.levelDimensions[descriptor.level],
        ),
    });
    return added.ok ? ok(undefined) : added;
  };

  for (const [level, horizontal] of targets.horizontal.entries()) {
    const source = level === 0 ? targets.scene : targets.vertical[level - 1];
    const vertical = targets.vertical[level];
    if (source === undefined || vertical === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-resolution-failed',
          expected: 'five adjacent Gaussian Bloom levels',
          hint: 'derive horizontal and vertical targets from the same level list',
          detail: { resourceLabel: `bloom-level-${level}` },
        }),
      );
    }
    const h = add(
      typedBloomLevelPassName('horizontal', level),
      [source],
      horizontal,
      (frame, resolve, pass) =>
        recordBloomBlurPass(
          frame,
          'horizontal',
          resolve,
          pass,
          level,
          targets.levelDimensions[level],
        ),
      level,
    );
    if (!h.ok) return h;
    const v = add(
      typedBloomLevelPassName('vertical', level),
      [horizontal],
      vertical,
      (frame, resolve, pass) => recordBloomBlurPass(frame, 'vertical', resolve, pass, level),
      level,
    );
    if (!v.ok) return v;
  }
  return add(
    TYPED_BLOOM_PASS_NAMES.composite,
    [targets.scene, ...targets.vertical],
    targets.composited,
    (frame, resolve, pass) => recordBloomCompositePass(frame, resolve, pass),
  );
}

export interface TypedSsaoTargets {
  readonly normal: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly raw: RenderPipelineTarget;
  readonly blurred: RenderPipelineTarget;
}

export function addTypedSsaoPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedSsaoTargets,
): Result<void, RenderGraphError> {
  const depth = depthSampleView(graph, targets.depth, 'typed-ssao-depth-only-view');
  if (!depth.ok) return depth;
  const calc = graph.addRasterPass('ssao-calc', {
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
    encode: ({ pass, frame, resources }) => {
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
    encode: ({ pass, frame, resources }) => {
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

export interface TypedFullscreenPassOptions {
  readonly name: string;
  readonly clearColor?: readonly [number, number, number, number];
  readonly shader: string;
  /** Optional fragment entry point override for composed fullscreen shaders. */
  readonly fragmentEntryPoint?: string | undefined;
  readonly input: RenderPipelineTarget;
  /** Color attachments in fragment location order. */
  readonly outputs: readonly [RenderPipelineTarget, ...RenderPipelineTarget[]];
  readonly outputOnly?: boolean | undefined;
  readonly rawSwapchainOutput?: boolean | undefined;
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
    encode: ({ pass, frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        frame.runtime.device,
        (frame.runtime as import('./record/render-context').RenderSystemRuntime).deviceScope,
        frame.targetW,
        frame.targetH,
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
        entry = { ...resolve, fragmentEntryPoint: TAA_REACTIVITY_ROWS_ENTRY };
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

export interface TypedTemporalResolveTargets {
  readonly scene: RenderPipelineTarget;
  /** Output-domain coverage produced by the Standard raster witness. */
  readonly coverage?: RenderPipelineTarget | undefined;
  /** Paired output-domain depth used to keep the producer observable. */
  readonly coverageDepth?: RenderPipelineTarget | undefined;
  /** Optional producer-owned R-channel reactivity in current screen space. */
  readonly secondaryReactivity?: TemporalSecondaryReactivity | undefined;
  readonly currentTemporal: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly historyColor: RenderPipelineTarget;
  readonly historyTemporal: RenderPipelineTarget;
  readonly historyStability: RenderPipelineTarget;
  readonly writeColor: RenderPipelineTarget;
  readonly writeTemporal: RenderPipelineTarget;
  readonly writeStability: RenderPipelineTarget;
}

export function addTypedTemporalResolvePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTemporalResolveTargets,
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
  const added = graph.addRasterPass('taa-resolve', {
    accesses: [
      { resource: targets.scene.view, usage: 'sampled-read' },
      { resource: targets.currentTemporal.view, usage: 'sampled-read' },
      ...(targets.coverage === undefined
        ? []
        : [{ resource: targets.coverage.view, usage: 'sampled-read' as const }]),
      ...(targets.coverageDepth === undefined
        ? []
        : [{ resource: targets.coverageDepth.view, usage: 'sampled-read' as const }]),
      { resource: targets.historyColor.view, usage: 'sampled-read' },
      { resource: targets.historyTemporal.view, usage: 'sampled-read' },
      { resource: targets.historyStability.view, usage: 'sampled-read' },
      ...(targets.secondaryReactivity === undefined
        ? []
        : [{ resource: targets.secondaryReactivity.view, usage: 'sampled-read' as const }]),
      ...(secondaryReactivity === undefined
        ? []
        : [{ resource: secondaryReactivity, usage: 'sampled-read' as const }]),
      { resource: targets.writeColor.view, usage: 'color-attachment' },
      { resource: targets.writeTemporal.view, usage: 'color-attachment' },
      { resource: targets.writeStability.view, usage: 'color-attachment' },
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
    ],
    encode: ({ pass, frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        frame.runtime.device,
        (frame.runtime as import('./record/render-context').RenderSystemRuntime).deviceScope,
        frame.targetW,
        frame.targetH,
      );
      const built = getTemporalBindGroupResources(state);
      const current = resolvedView(resources, targets.scene.view);
      const currentTemporal = resolvedView(resources, targets.currentTemporal.view);
      const historyColor = resolvedView(resources, targets.historyColor.view);
      const historyTemporal = resolvedView(resources, targets.historyTemporal.view);
      const historyStability = resolvedView(resources, targets.historyStability.view);
      const secondarySource =
        targets.secondaryReactivity === undefined
          ? currentTemporal
          : resolvedView(resources, targets.secondaryReactivity.view);
      const params = getTemporalParamsBuffer(state);
      if (params === undefined || built.sampler === null || built.temporalSampler === null) {
        throwTemporalEncodeFailure('TAA resolve has an admitted params buffer and sampler');
      }
      const payload = new ArrayBuffer(32);
      new Float32Array(payload).set([
        frame.camera.temporal?.currentJitterUv?.[0] ?? 0,
        frame.camera.temporal?.currentJitterUv?.[1] ?? 0,
      ]);
      const words = new Uint32Array(payload);
      words[2] = state.valid && (frame.camera.temporal?.historyValid ?? true) ? 1 : 0;
      words[3] = frame.camera.temporal?.temporalFrameIndex ?? 0;
      words[4] = Number(secondaryReactivity !== undefined);
      words[5] = Number(targets.coverage !== undefined);
      words[6] = Number(secondaryReactivity !== undefined);
      const written = frame.runtime.device.queue.writeBuffer(params, 0, new Uint8Array(payload));
      if (!written.ok)
        throwTemporalEncodeFailure('TAA resolve params upload succeeds', written.error);
      const secondary =
        secondaryReactivity === undefined
          ? currentTemporal
          : resolvedView(resources, secondaryReactivity);
      const coverage =
        targets.coverage === undefined
          ? currentTemporal
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
        secondary,
        secondarySource,
        coverage,
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
          ] as never,
        });
        if (!bindGroup.ok) {
          throwTemporalEncodeFailure('TAA resolve bind group creation succeeds', bindGroup.error);
        }
        binding = { sources, group: bindGroup.value };
        if (bindings.length === 2) bindings.shift();
        bindings.push(binding);
      }
      const pipeline = frame.runtime.getPostProcessPipeline?.('forgeax.taa-resolve', built.layout, [
        targets.writeColor.format,
        targets.writeTemporal.format,
        targets.writeStability.format,
      ] as GPUTextureFormat[]);
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

export function addTypedFullscreenPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedFullscreenPassOptions,
): Result<void, RenderGraphError> {
  const depth =
    options.depth === undefined
      ? undefined
      : depthSampleView(graph, options.depth, `${options.name}.depth-only-view`);
  if (depth !== undefined && !depth.ok) return depth;
  const output = options.outputs[0];
  const outputFormats = options.outputs.map((target) => target.format as GPUTextureFormat);
  return graph.addRasterPass(options.name, {
    accesses: [
      { resource: options.input.view, usage: 'sampled-read' },
      ...options.outputs.map((target) => ({
        resource: target.view,
        usage: 'color-attachment' as const,
      })),
      ...(depth === undefined ? [] : [{ resource: depth.value, usage: 'sampled-read' as const }]),
      ...(options.additionalReads?.map((read) => ({
        resource: read.target.view,
        usage: 'sampled-read' as const,
      })) ?? []),
    ],
    colorAttachments: options.outputs.map((target) => ({
      view: target.view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: {
        r: options.clearColor?.[0] ?? 0,
        g: options.clearColor?.[1] ?? 0,
        b: options.clearColor?.[2] ?? 0,
        a: options.clearColor?.[3] ?? 1,
      },
    })),
    encode: ({ pass, frame, resources }) => {
      if (options.outputOnly && frame.runtime.lookupPostProcess?.(options.shader) === undefined) {
        return;
      }
      encodeFullscreenPass(frame, pass, {
        name: options.name,
        shader: options.shader,
        color: 'output',
        reads: ['input'],
        resolve: legacyResolver(resources, {
          input: options.input,
          output,
          ldrColor: options.input,
          'scene-color': options.input,
          ...(options.depth === undefined ? {} : { 'scene-depth': options.depth }),
          ...(options.additionalReads === undefined
            ? {}
            : Object.fromEntries(options.additionalReads.map((read) => [read.key, read.target]))),
        }),
        outputFormats,
        ...(depth === undefined ? {} : { depthView: resolvedView(resources, depth.value) }),
        ...(options.rawSwapchainOutput === undefined
          ? {}
          : { rawSwapchainOutput: options.rawSwapchainOutput }),
        ...(options.paramsTransform === undefined
          ? {}
          : {
              paramsOverride: options.paramsTransform(
                frame.postProcessParams.get(options.shader),
                frame,
                resources,
              ),
            }),
        ...(options.fragmentEntryPoint === undefined
          ? {}
          : { fragmentEntryPoint: options.fragmentEntryPoint }),
        ...(options.depth === undefined ? {} : { msaaActive: options.depth.sampleCount === 4 }),
      });
    },
  });
}

export function addTypedCompositePostEffects(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  effects: readonly string[],
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  size: { readonly width: number; readonly height: number },
): Result<void, RenderGraphError> {
  let currentInput = input;
  for (let index = 0; index < effects.length; index += 1) {
    const shader = effects[index];
    if (shader === undefined) continue;
    const effectInput = currentInput;
    // The scratch is a texture copy of the effect input, so it takes the input
    // format; a raw-only surface feeds an rgba16float input into an 8-bit output.
    const scratch = createRenderPipelineTarget(graph, `post-effect-scratch-${index}`, {
      format: effectInput.format as GPUTextureFormat,
      size: 'surface',
    });
    if (!scratch.ok) return scratch;
    const effectOutput =
      index === effects.length - 1
        ? ok(output)
        : createRenderPipelineTarget(graph, `post-effect-output-${index}`, {
            format: output.format as GPUTextureFormat,
            size: 'surface',
          });
    if (!effectOutput.ok) return effectOutput;
    const copied = graph.addCopyPass(`post-effect-copy-${index}`, {
      accesses: [
        { resource: effectInput.view, usage: 'copy-src' },
        { resource: scratch.value.view, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        const source = resources.texture(effectInput.texture);
        if (!source.ok) throw source.error;
        const destination = resources.texture(scratch.value.texture);
        if (!destination.ok) throw destination.error;
        encoder.copyTextureToTexture(
          { texture: source.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { texture: destination.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { width: size.width, height: size.height, depthOrArrayLayers: 1 },
        );
      },
    });
    if (!copied.ok) return copied;
    const effect = addTypedFullscreenPass(graph, {
      name: `post-effect-${index}`,
      shader,
      input: scratch.value,
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
    readonly dither?: boolean;
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
  const transformed = addTypedFullscreenPass(graph, {
    name: options.name ?? (outputOnly ? 'present' : 'output-transform'),
    shader: STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
    input,
    outputs: [output],
    outputOnly,
    rawSwapchainOutput: outputOnly,
    paramsTransform: (params, _frame, resources): Uint8Array | undefined => {
      if (params === undefined || params.byteLength !== TONEMAP_PARAMS_LAYOUT.byteSize) {
        return params;
      }
      const extent = resources.textureViewExtent(output.view);
      if (!extent.ok) throw extent.error;
      const transformed = params.slice();
      const values = new DataView(
        transformed.buffer,
        transformed.byteOffset,
        transformed.byteLength,
      );
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputWidthOffset, extent.value.width, true);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputHeightOffset, extent.value.height, true);
      if (options.dither !== undefined) {
        values.setFloat32(TONEMAP_PARAMS_LAYOUT.ditherOffset, options.dither ? 1 : 0, true);
      }
      return transformed;
    },
    ...(options.fragmentEntryPoint === undefined
      ? {}
      : { fragmentEntryPoint: options.fragmentEntryPoint }),
  });
  if (!transformed.ok) return transformed;
  if (options.fragmentEntryPoint !== 'fs_tone_only' && requested.includes('final-display')) {
    const finalCapture = addObservationCapturePass(graph, output, 'final-display');
    if (!finalCapture.ok) return finalCapture;
  }
  return ok(undefined);
}
