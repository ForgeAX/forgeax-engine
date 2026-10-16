import {
  type GraphAccess,
  type GraphResourceResolver,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
  type ResolveContext,
} from '@forgeax/engine-render-graph';
import { RhiError, type TextureView } from '@forgeax/engine-rhi';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { err, ok, type PassKind, type PassSelector, type Result } from '@forgeax/engine-types';
import { atmosphereTextures } from './environment/luts';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';
import { renderExtentSize } from './pipeline/render-extent';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import { encodeMainPass } from './record/main-pass';
import { encodeFrameObservationCapture } from './record/observation-capture';
import { sceneRenderBundleCache } from './record/render-bundle-cache';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
} from './record/render-context';
import {
  encodeSkyboxPass,
  recordBloomCompositePass,
  recordBloomDownsamplePass,
  recordBloomUpsamplePass,
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

function resolvedDepthView(
  frame: RenderPipelineFrame,
  resources: GraphResourceResolver,
  target: RenderPipelineTarget,
): TextureView {
  const texture = resources.texture(target.texture);
  if (!texture.ok) throw texture.error;
  const view = frame.runtime.device.createTextureView(texture.value, {
    label: 'typed-ssao-depth-only-view',
    // Multisampled WebGPU textures still use a `2d` view dimension; the
    // sample count is carried by the source texture and WGSL type.
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!view.ok) throw view.error;
  return view.value;
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
  /** Restrict GPU-driven projection to the material family owned by this pass. */
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
  const colorTargets = options.colorTargets ?? [options.color];
  options.gpuDriven?.registerPipelinePreparation?.(
    colorTargets.map((target) => target.format),
    options.gpuDrivenFilter,
    selectForwardFragmentEntry({
      passKind: options.passKind ?? 'forward',
      fragmentEntry:
        options.passKind === 'temporal'
          ? 'fs_temporal'
          : options.passKind === 'deferred'
            ? 'fs_gbuffer'
            : options.recordMode === 'single-layer-medium-nearest-layer'
              ? 'fs_nearest_layer'
              : options.recordMode === 'single-layer-medium-color'
                ? 'fs_color'
                : undefined,
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
    executeIf: options.executeIf,
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
      const colorViews = colorTargets.map((target) => resolvedView(resources, target.view));
      const depthView = resolvedView(resources, options.depth.view);
      const resolveView =
        options.resolve === undefined ? null : resolvedView(resources, options.resolve.view);
      const internal = frame as _InternalRenderPipelineContext;
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
        internal.validated.length > 0 || options.gpuDriven !== undefined,
        internal.bindGroupCounts,
        {
          directionalShadow,
          spotShadow,
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
      // GPU-driven indirect draws are encoded by `recordMainPass` after it
      // has populated the frame-global material bind-group receipt. Encoding
      // here would race that producer and either observe an empty receipt or
      // issue the same indirect draw twice. Keep this wrapper responsible for
      // resolving graph-owned attachments; the main-pass owner orders the
      // material producer before the GPU consumer.
      const { gpuDrivenDrawReceipts, ...directContext } = internal;
      const passContext: _InternalRenderPipelineContext = {
        ...directContext,
        ...(options.gpuDriven === undefined || gpuDrivenDrawReceipts === undefined
          ? {}
          : { gpuDrivenDrawReceipts }),
        ...(options.environment === undefined
          ? {}
          : {
              environmentIbl: {
                irradiance: resolvedView(resources, options.environment.irradiance),
                prefilter: resolvedView(resources, options.environment.prefilter),
              },
            }),
        geometryColorView: colorViews[0] ?? null,
        geometryDepthView: depthView,
        geometryColorResolveView: resolveView,
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
          encodeMainPass(passContext, bundledPass, options.selector, {
            bundleDescriptor,
            ...(options.selectEntities === undefined
              ? {}
              : { selection: options.selectEntities(frame) }),
            colorViews,
            colorFormats: colorTargets.map((target) => target.format as GPUTextureFormat),
            depthView,
            passKind: options.passKind ?? 'forward',
            ...(options.clearColor === undefined ? {} : { clearColor: options.clearColor }),
            ...(options.recordMode === undefined ? {} : { recordMode: options.recordMode }),
            ...(options.transparentDepthWrite === undefined
              ? {}
              : { transparentDepthWrite: options.transparentDepthWrite }),
            ...(options.coverageOnly === undefined ? {} : { coverageOnly: options.coverageOnly }),
            ...(options.excludeSelector === undefined
              ? {}
              : { excludeSelector: options.excludeSelector }),
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
            ...(options.passKind === 'temporal'
              ? { fragmentEntryPoint: 'fs_temporal' }
              : options.passKind === 'deferred'
                ? { fragmentEntryPoint: 'fs_gbuffer' }
                : options.recordMode === 'single-layer-medium-nearest-layer'
                  ? { fragmentEntryPoint: 'fs_nearest_layer' }
                  : options.recordMode === 'single-layer-medium-color'
                    ? { fragmentEntryPoint: 'fs_color' }
                    : {}),
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
      // encodeMainPass receives a pass-local context so attachment and
      // bind-group overrides stay isolated. Its material UBO payload cache is
      // frame-owned, however: return it to the original context so the next
      // Standard scene pass can reuse the same validated slot projection.
      // This remains frame-local and keeps the existing writeBuffer, texture
      // readiness, UV-scale, and missing-texture diagnostic behavior intact.
      if (passContext.materialUboPayloadCache !== undefined) {
        internal.materialUboPayloadCache = passContext.materialUboPayloadCache;
      }
    },
  });
}

export function addTypedFrameObservationPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  pipelineId: 'forgeax::standard',
): Result<void, RenderGraphError> {
  void pipelineId;
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
  readonly downsample: readonly RenderPipelineTarget[];
  readonly upsample: readonly RenderPipelineTarget[];
  readonly levelDimensions: readonly { readonly width: number; readonly height: number }[];
}

/** The semantic Bloom pass owner; graph inspection consumes these same identities. */
export const TYPED_BLOOM_PASS_NAMES = {
  downsample: 'bloom-downsample',
  upsample: 'bloom-upsample',
  composite: 'bloom-composite',
} as const;

export function typedBloomLevelPassName(kind: 'downsample' | 'upsample', level: number): string {
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
  targets.downsample.forEach((target, level) => {
    named[`bloomDownsample${level}`] = target;
  });
  targets.upsample.forEach((target, level) => {
    named[`bloomUpsample${level}`] = target;
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

  for (const [level, write] of targets.downsample.entries()) {
    const source = level === 0 ? targets.scene : targets.downsample[level - 1];
    if (source === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-resolution-failed',
          expected: 'Bloom downsample levels form one adjacent pyramid',
          hint: 'rebuild the Standard Bloom target declaration from one level list',
          detail: { resourceLabel: `bloom-level-${level}` },
        }),
      );
    }
    const added = add(
      typedBloomLevelPassName('downsample', level),
      [source],
      write,
      (frame, resolve, pass, passLevel) =>
        recordBloomDownsamplePass(
          frame,
          resolve,
          pass,
          passLevel ?? level,
          targets.levelDimensions[passLevel ?? level],
        ),
      level,
    );
    if (!added.ok) return added;
  }
  for (let level = targets.upsample.length - 1; level >= 0; level -= 1) {
    const current = targets.downsample[level];
    const coarse =
      level === targets.downsample.length - 2
        ? targets.downsample[level + 1]
        : targets.upsample[level + 1];
    const write = targets.upsample[level];
    if (current === undefined || coarse === undefined || write === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-resolution-failed',
          expected: 'Bloom downsample and upsample levels form one adjacent pyramid',
          hint: 'rebuild the Standard Bloom target declaration from one level list',
          detail: { resourceLabel: `bloom-level-${level}` },
        }),
      );
    }
    const added = add(
      typedBloomLevelPassName('upsample', level),
      [current, coarse],
      write,
      (frame, resolve, pass, passLevel) =>
        recordBloomUpsamplePass(frame, resolve, pass, passLevel ?? level),
      level,
    );
    if (!added.ok) return added;
  }
  const finest = targets.upsample[0] ?? targets.downsample[0];
  if (finest === undefined) {
    return err(
      new RenderGraphError({
        code: 'resource-resolution-failed',
        expected: 'Bloom has at least one downsample level',
        hint: 'derive Bloom levels from a positive output extent',
        detail: { resourceLabel: 'bloom-downsample-0' },
      }),
    );
  }
  return add(
    TYPED_BLOOM_PASS_NAMES.composite,
    [targets.scene, finest],
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
  const calc = graph.addRasterPass('ssao-calc', {
    accesses: [
      { resource: targets.normal.view, usage: 'sampled-read' },
      { resource: targets.depth.view, usage: 'sampled-read' },
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
      const depthCacheKey = resolvedView(resources, targets.depth.view);
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
          depth: resolvedDepthView(frame, resources, targets.depth),
          depthCacheKey,
        },
      );
    },
  });
  if (!calc.ok) return calc;

  return graph.addRasterPass('ssao-blur', {
    accesses: [
      { resource: targets.raw.view, usage: 'sampled-read' },
      { resource: targets.normal.view, usage: 'sampled-read' },
      { resource: targets.depth.view, usage: 'sampled-read' },
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
      const depthCacheKey = resolvedView(resources, targets.depth.view);
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
          depth: resolvedDepthView(frame, resources, targets.depth),
          depthCacheKey,
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

export interface TypedTemporalResolveTargets {
  readonly scene: RenderPipelineTarget;
  /** Output-domain coverage produced by the Standard raster witness. */
  readonly coverage?: RenderPipelineTarget | undefined;
  /** Paired output-domain depth used to keep the producer observable. */
  readonly coverageDepth?: RenderPipelineTarget | undefined;
  /** Optional producer-owned R-channel reactivity in current screen space. */
  readonly secondaryReactivity?: GraphTextureView;
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
        : [{ resource: targets.secondaryReactivity, usage: 'sampled-read' as const }]),
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
      words[4] = Number(targets.secondaryReactivity !== undefined);
      words[5] = Number(targets.coverage !== undefined);
      const written = frame.runtime.device.queue.writeBuffer(params, 0, new Uint8Array(payload));
      if (!written.ok)
        throwTemporalEncodeFailure('TAA resolve params upload succeeds', written.error);
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
              value:
                targets.secondaryReactivity === undefined
                  ? currentTemporal
                  : resolvedView(resources, targets.secondaryReactivity),
            },
          },
          {
            binding: 11,
            resource: {
              kind: 'textureView',
              value:
                targets.coverage === undefined
                  ? currentTemporal
                  : resolvedView(resources, targets.coverage.view),
            },
          },
        ] as never,
      });
      if (!bindGroup.ok) {
        throwTemporalEncodeFailure('TAA resolve bind group creation succeeds', bindGroup.error);
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
      pass.setBindGroup(1, bindGroup.value);
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
  const output = options.outputs[0];
  const outputFormats = options.outputs.map((target) => target.format as GPUTextureFormat);
  return graph.addRasterPass(options.name, {
    accesses: [
      { resource: options.input.view, usage: 'sampled-read' },
      ...options.outputs.map((target) => ({
        resource: target.view,
        usage: 'color-attachment' as const,
      })),
      ...(options.depth === undefined
        ? []
        : [{ resource: options.depth.view, usage: 'sampled-read' as const }]),
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
        ...(options.depth === undefined
          ? {}
          : { depthView: resolvedDepthView(frame, resources, options.depth) }),
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
          { texture: source.value as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { texture: destination.value as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
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
