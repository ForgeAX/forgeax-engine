import type { MaterialResource } from './material-resource';
// @forgeax/engine-render - typed render-pipeline topology contract.
//
// `RenderPipeline` is the typed topology contribution used by the Standard host.
// The host owns the single active pipeline identity and its lifecycle; producers
// contribute graph declarations through this interface instead of publishing a
// second renderer authority.
//
// Naming note (requirements line 155): `RenderPipeline` here is the forgeax engine
// concept name. The RHI GPU `RenderPipeline` handle (`@forgeax/engine-rhi`) is a
// separate, internal opaque-handle type distinguished by module path (AGENTS.md RHI
// form rules - "opaque handles distinguished by module path"); it is not exposed to
// AI users. Files importing both alias the RHI one locally.
//
// Pipelines declare topology once through a typed builder. The renderer compiles,
// executes, retires, finishes, and submits the resulting graph.

import type {
  ColorValueDomain,
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  Buffer,
  RenderBundleEncoderDescriptor,
  RhiCaps,
  RhiError,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { Tonemap } from './components/camera';
import type { DepthOfFieldSide } from './components/depth-of-field';
import type { DirectionalShadowFilterLabel } from './components/directional-shadow-filter';
import type { RenderError } from './errors/render';
import type { RenderFeatureTargetKind } from './features/targets';
import type { RenderFeaturePlacement } from './features/types';
import type { ShadowViewIdentity, ShadowViewProjection } from './gpu-driven/shadow-views';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from './gpu-texture-usage';
import type { RenderExtent } from './pipeline/render-extent';
import type { StandardTopologyInputValue } from './pipeline/standard-lighting/topology';
import { STANDARD_POST_STAGE_NAMES, type StandardProfile } from './pipeline/standard-profile';
import type { SurfaceProfile } from './record/render-context';
import type { FrameObservationDomain, RenderPipelineContext } from './render-contract';
import type { ShadowDepthLayers } from './shadow-depth-layers';
import type { SsrSpatialAdmission } from './ssr/admission';
import type { TransmissionDemand } from './transmission/projection';
import type { VolumetricFogLightKind } from './volume/capability';

export type { RenderPipelineContext } from './render-contract';

export type RenderColorDomain = 'linearHdr' | 'linearLdr' | 'displayEncoded';

/** Backend admission inputs used by the existing Render candidate owner. */
export interface DirectionalShadowBackendAdmissionInput {
  readonly backendKind: 'webgpu' | 'wgpu-webgl2' | 'null';
  readonly requested: 'off' | DirectionalShadowFilterLabel;
  readonly candidate: 'accepted' | 'failed';
  readonly lastKnownGood?: DirectionalShadowFilterLabel | undefined;
}

/** Bounded, truthful Directional effective-profile projection. */
export interface DirectionalShadowBackendAdmission {
  readonly requested: 'off' | DirectionalShadowFilterLabel;
  readonly effective: 'off' | DirectionalShadowFilterLabel | 'rhi-null-structural';
  readonly status: 'accepted' | 'fallback' | 'rejected';
  readonly fallbackReason?: 'webgl2-unsupported' | 'rhi-null-structural' | 'candidate-failed';
  readonly lastKnownGood: boolean;
  readonly pixelEvidence: 'available' | 'not-available';
}

/**
 * Resolve a Directional profile only after the selected production candidate
 * has been admitted. WebGL2 and RhiNull are the sole declared fallbacks;
 * capable candidate failure retains a compatible LKG and never silently maps
 * a failed PCSS request to PCF.
 */
export function resolveDirectionalShadowBackendAdmission(
  input: DirectionalShadowBackendAdmissionInput,
): DirectionalShadowBackendAdmission {
  if (input.requested === 'off') {
    return {
      requested: 'off',
      effective: 'off',
      status: 'accepted',
      lastKnownGood: false,
      pixelEvidence: 'not-available',
    };
  }
  if (input.backendKind === 'null') {
    return {
      requested: input.requested,
      effective: 'rhi-null-structural',
      status: 'fallback',
      fallbackReason: 'rhi-null-structural',
      lastKnownGood: false,
      pixelEvidence: 'not-available',
    };
  }
  if (input.backendKind === 'wgpu-webgl2') {
    const effective =
      input.requested === 'pcssMedium'
        ? 'pcf3'
        : input.requested === 'pcssHigh'
          ? 'pcf5'
          : input.requested;
    return {
      requested: input.requested,
      effective,
      status: effective === input.requested ? 'accepted' : 'fallback',
      ...(effective === input.requested ? {} : { fallbackReason: 'webgl2-unsupported' as const }),
      lastKnownGood: false,
      pixelEvidence: 'available',
    };
  }
  if (input.candidate === 'accepted') {
    return {
      requested: input.requested,
      effective: input.requested,
      status: 'accepted',
      lastKnownGood: false,
      pixelEvidence: 'available',
    };
  }
  if (input.lastKnownGood !== undefined) {
    return {
      requested: input.requested,
      effective: input.lastKnownGood,
      status: 'rejected',
      fallbackReason: 'candidate-failed',
      lastKnownGood: true,
      pixelEvidence: 'available',
    };
  }
  return {
    requested: input.requested,
    effective: input.requested,
    status: 'rejected',
    fallbackReason: 'candidate-failed',
    lastKnownGood: false,
    pixelEvidence: 'available',
  };
}

export interface ToneOutputContract {
  readonly input: RenderColorDomain;
  readonly toneMapped: boolean;
  readonly mapped: 'linearLdr';
  readonly finalCapture: 'displayEncoded';
  readonly exposureStage: 'linearHdr' | 'none';
}

export type RenderPostStageName = (typeof STANDARD_POST_STAGE_NAMES)[number];
export type RenderPostDomainStage = readonly [
  RenderPostStageName,
  ColorValueDomain,
  ColorValueDomain,
];

/**
 * Single post-stage domain contract shared by the Standard lighting lanes.
 * The selected scene domain for transparent geometry is explicit; every later
 * stage follows the same linear blend, output-transform, anti-alias, post-effect, and present sequence.
 */
export function resolvePostColorDomainContract(
  sceneDomain: 'linear-ldr' | 'linear-hdr',
): readonly RenderPostDomainStage[] {
  const scene: ColorValueDomain = sceneDomain;
  const [transparentBlend, bloom, outputTransform, fxaa, postEffect, present] =
    STANDARD_POST_STAGE_NAMES;
  return [
    [transparentBlend, scene, scene],
    [bloom, 'linear-hdr', 'linear-hdr'],
    [outputTransform, scene, 'display-encoded'],
    [fxaa, 'display-encoded', 'display-encoded'],
    [postEffect, 'display-encoded', 'display-encoded'],
    [present, 'display-encoded', 'display-encoded'],
  ];
}

/**
 * Describe the built-in output stages without moving color-domain policy into
 * a mode name. Tone-enabled cameras render HDR, apply exposure and the
 * selected curve in the fullscreen pass, then reach the encoded surface.
 */
export function resolveToneOutputContract(tonemap: Tonemap): ToneOutputContract {
  if (tonemap === 'none') {
    return {
      input: 'linearLdr',
      toneMapped: false,
      mapped: 'linearLdr',
      finalCapture: 'displayEncoded',
      exposureStage: 'none',
    };
  }
  return {
    input: 'linearHdr',
    toneMapped: true,
    mapped: 'linearLdr',
    finalCapture: 'displayEncoded',
    exposureStage: 'linearHdr',
  };
}

/** Stable facts that may change graph topology and therefore its compiled identity. */
export interface RenderPipelineTopology {
  /** Derived from the active fullscreen declarations, never authored twice in pipeline config. */
  readonly preTemporalEffects?: readonly string[];
  readonly subsurface?: { readonly quality: 'low' | 'high' };
  readonly projectedDecals?: import('./decals/graph').ProjectedDecalTopology;
  readonly pipelineId: string;
  readonly standardProfile?: StandardProfile | undefined;
  readonly config: import('@forgeax/engine-types').RenderPipelineAsset['config'];
  /**
   * The record stage had no Camera and injected the synthetic clear-only
   * snapshot.  Keep that fact explicit so a normal no-tone Camera still uses
   * the float Output Transform while the empty-scene contract can write its
   * clear directly to the surface.
   */
  readonly clearOnly?: boolean | undefined;
  /** Selected atmosphere requires the graph-owned sky producer and background. */
  readonly atmosphere?: boolean | undefined;
  /** Finite-depth distance / exponential-height fog; no volume history. */
  readonly analyticFog?: boolean | undefined;
  /** Whether Standard main draws carry the producer-owned fallback MRT. */
  readonly reflectionFallback?: { readonly enabled: boolean } | undefined;
  readonly surface: {
    readonly width: number;
    readonly height: number;
    readonly storageFormat: import('@forgeax/engine-rhi').TextureFormat;
    readonly viewFormat: import('@forgeax/engine-rhi').TextureFormat;
    readonly profile?: SurfaceProfile | undefined;
  };
  /** Renderer-owned immutable dimensions for Standard graph consumers. */
  readonly extent?: RenderExtent;
  readonly camera: Pick<
    RenderPipelineContext['camera'],
    'tonemap' | 'antialias' | 'bloom' | 'bloomIntensity'
  > & {
    /** Shape-only DoF admission; optical values remain per-frame UBO data. */
    readonly depthOfField?:
      | {
          readonly blurSide: DepthOfFieldSide;
          readonly useNear: boolean;
          readonly useFar: boolean;
        }
      | undefined;
    /** Shape-only barrel admission; numeric mapping stays per-frame data. */
    readonly barrelDistortion?: boolean | undefined;
    readonly lensEffects?: boolean | undefined;
    readonly lensFlare?: boolean | undefined;
    readonly outline?: boolean | undefined;
  };
  /** Frame-stable Standard output policy; no raw RHI handles enter topology. */
  readonly output?: {
    readonly autoExposure: boolean;
    /** Camera-owned Bradford white balance is part of the same output pass. */
    readonly whiteBalance?: boolean;
    readonly temperature?: number;
    readonly tint?: number;
    readonly colorLut: boolean;
    readonly colorLutStrength: number;
    readonly lutSourceKey?: string;
    readonly lutSize?: number;
  };
  /** Detached spatial SSR admission; graph resources remain renderer-owned. */
  readonly ssr?: SsrSpatialAdmission | undefined;
  readonly temporal?: {
    readonly taa: boolean;
    readonly motionBlur: boolean;
  };
  readonly shadow: {
    readonly directional:
      | 'disabled'
      | {
          readonly mapSize: number;
          readonly cascadeCount: 1 | 2 | 3 | 4;
          /**
           * `false` omits the GPU-driven static cascade layer, its passes and
           * its copy; each cascade rasters every caster. Absent keeps it.
           */
          readonly staticLayer?: false;
          readonly terrainReceivers?: readonly import('./terrain/shadow-family').TerrainShadowReceiver[];
        };
    readonly variance?: { readonly directional: boolean; readonly spots: readonly number[] };
    readonly spotMapSize: number;
    readonly pointCount: number;
    readonly pointFaceSize: number;
    readonly spotCount: number;
  };
  /**
   * Authored volume topology facts.  Identity/generation/digest are runtime
   * residency facts and deliberately do not participate in graph topology.
   */
  readonly volumetricFog?: {
    readonly enabled: boolean;
    readonly additional?: readonly {
      readonly format: TextureFormat;
      readonly extent: { readonly width: number; readonly height: number; readonly depth: number };
    }[];
    readonly lightKind?: VolumetricFogLightKind | undefined;
    readonly lightEntity?: number | undefined;
    readonly pointLightEntity?: number | undefined;
    readonly spotLightEntity?: number | undefined;
    readonly projector?:
      | {
          readonly guid: string;
          readonly generation: number;
          readonly revision: number;
        }
      | undefined;
    readonly format?: TextureFormat | undefined;
    readonly extent?:
      | {
          readonly width: number;
          readonly height: number;
          readonly depth: number;
        }
      | undefined;
    /** Renderer-owned froxel grid derived from the compiled surface extent. */
    readonly froxelExtent?:
      | {
          readonly width: number;
          readonly height: number;
          readonly depth: number;
        }
      | undefined;
    /** Renderer-owned 2D resolve/history extent derived from the same profile. */
    readonly resolvedExtent?:
      | {
          readonly width: number;
          readonly height: number;
          readonly depth: number;
        }
      | undefined;
  };
  readonly lane: {
    readonly compute: boolean;
    readonly storageBuffer: boolean;
    readonly multisample: boolean;
    readonly maxColorAttachments: number;
    readonly primitiveIndex?: boolean;
    readonly maxColorAttachmentBytesPerSample?: number;
  };
  readonly featureTopologySignature: string;
  readonly gpuDrivenTopologySignature: string;
  /** Stable Cluster transport/layout facts; excludes per-frame light payloads. */
  readonly standardLightingTopologySignature?: string | undefined;
  /** Internal graph fact; renderer callers do not configure transmission demand. */
  readonly transmissionDemand?: TransmissionDemand | undefined;
  /** Whether the extracted frame contains a single-layer medium Surface. */
  readonly singleLayerMedium?: boolean | undefined;
  /**
   * Resolved weighted blended OIT shape. Present only when the view resolves
   * to `weighted-blended` and at least one transparent draw is eligible;
   * `residual` records the sorted pass for the ineligible draws.
   */
  readonly transparency?:
    | { readonly weightedBlended: true; readonly residual: boolean }
    | undefined;
}

/** Resolve the built-in final-output dither policy from the pipeline asset. */
export function resolveOutputDither(
  config: import('@forgeax/engine-types').RenderPipelineAsset['config'],
): boolean {
  return config?.outputDither ?? true;
}

export interface RenderPipelineFrame extends RenderPipelineContext, RenderGraphFrame {
  readonly probePlacement?: import('./raytracing/renderer-probe-placement').PreparedProbePlacement;
}

export interface RenderPipelineTarget {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly domain?: ColorValueDomain | undefined;
  readonly resolveTarget?: GraphTextureView | undefined;
}

export function createRenderPipelineTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
  viewDescriptor: GraphTextureViewDescriptor = {},
): Result<RenderPipelineTarget, RenderGraphError> {
  const texture = graph.createTexture(label, descriptor);
  if (!texture.ok) return texture;
  const view = graph.view(texture.value, { label: `${label}.view`, ...viewDescriptor });
  if (!view.ok) return view;
  return ok({
    texture: texture.value,
    view: view.value,
    format: viewDescriptor.format ?? descriptor.format,
    sampleCount: descriptor.sampleCount === 4 ? 4 : 1,
    ...(descriptor.domain === undefined ? {} : { domain: descriptor.domain }),
  });
}

export function importRenderPipelineSurface(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<
  { readonly display?: RenderPipelineTarget; readonly storage: RenderPipelineTarget },
  RenderGraphError
> {
  const texture = graph.importTexture(
    'surface',
    {
      format: topology.surface.storageFormat,
      size: 'surface',
      // The imported surface is the final encoded endpoint.  Keeping this
      // semantic fact on the graph resource lets detached inspection project
      // from the compiled graph instead of re-inferring it from format names.
      domain: 'display-encoded',
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        (topology.surface.profile?.kind === 'raw-only' ? 0 : GPU_TEXTURE_USAGE_COPY_SRC),
      viewFormats: [
        ...(topology.surface.profile?.viewFormats ??
          (topology.surface.storageFormat === topology.surface.viewFormat
            ? []
            : [topology.surface.viewFormat])),
      ],
    },
    (frame) => frame.currentTexture,
  );
  if (!texture.ok) return texture;
  const display =
    topology.surface.profile?.hasDisplayEndpoint === false
      ? undefined
      : graph.importView(
          texture.value,
          { label: 'surface.display', format: topology.surface.viewFormat },
          (frame) => frame.view,
        );
  if (display !== undefined && !display.ok) return display;
  const storage = graph.importView(
    texture.value,
    { label: 'surface.storage', format: topology.surface.storageFormat },
    (frame) => {
      if (topology.surface.storageFormat === topology.surface.viewFormat) return frame.view;
      const resolved = frame.runtime.device.createTextureView(frame.currentTexture, {
        format: topology.surface.storageFormat,
      });
      if (!resolved.ok) throw resolved.error;
      return resolved.value;
    },
  );
  if (!storage.ok) return storage;
  return ok({
    ...(display === undefined
      ? {}
      : {
          display: {
            texture: texture.value,
            view: display.value,
            format: topology.surface.viewFormat,
            sampleCount: 1 as const,
            domain: 'display-encoded' as const,
          },
        }),
    storage: {
      texture: texture.value,
      view: storage.value,
      format: topology.surface.storageFormat,
      sampleCount: 1,
      domain: 'display-encoded',
    },
  });
}

export interface RenderPipelineFeatureTarget {
  /** Optional semantic alias when a pipeline exposes multiple color roles. */
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderPipelineGpuDrivenProjection {
  readonly accesses: readonly GraphAccess[];
  /** @internal Register actual graph pass facts without drawing or changing visibility. */
  readonly registerPipelinePreparation?: (
    formats: readonly TextureFormat[],
    filter?: RenderPipelineGpuDrivenFilter,
    fragmentEntryPoint?: string,
    coverageOnly?: boolean,
  ) => void;
  /** @internal Poll the registered real PSOs before any graph pass is encoded. */
  readonly preparePipelines?: (
    entries?: readonly import('./record/frame-snapshot').ValidatedRenderable[],
    artifacts?: ReadonlyMap<string, import('@forgeax/engine-shader').MaterialShaderArtifact>,
    onPending?: (reason: import('./render-contract').FramePresentationPendingReason) => void,
    materials?: import('./scene/material-dispatch').MaterialFrame,
  ) => boolean;
  /** Live CPU eligibility, before material/view culling; false proves no indirect work. */
  hasWork(filter?: RenderPipelineGpuDrivenFilter, fragmentEntryPoint?: string): boolean;
  encode(
    viewBindGroup: BindGroup,
    pass: RhiRenderPassEncoder,
    resources: GraphResourceResolver,
    frameResources: GpuDrivenStandardPbrFrameResources,
    filter?: RenderPipelineGpuDrivenFilter,
    fragmentEntryPoint?: string,
    /** Select the `fs_temporal` binary coverage variant for an r8unorm target. */
    coverageOnly?: boolean,
    /**
     * `late` draws only the candidates the HZB phase found newly visible.
     * Every other pass draws the full visible set.
     */
    phase?: GpuDrivenDrawPhase,
  ): void;
  /**
   * Present when the projection reserved two-phase occlusion. The caller adds
   * the late HZB cull after the early geometry produced `pyramid`, then
   * encodes a `late` phase pass. Draws after it see the full visible set.
   */
  readonly addLateOcclusion?: (
    pyramid: GraphTextureView,
  ) => Result<readonly string[], RenderGraphError>;
}

/** Which subset of the GPU-driven visible set an indirect encode draws. */
export type GpuDrivenDrawPhase = 'all' | 'late';

/** Material family selected by a typed scene pass for GPU-driven encoding. */
export type RenderPipelineGpuDrivenFilter =
  | 'opaque'
  | 'deferred-opaque'
  | 'forward-only-opaque'
  | 'single-layer-medium';

/** Graph-paired inputs available to a single-layer medium Surface pass. */
export interface RenderPipelineSurfaceMediumPair {
  /** The resolved opaque scene color produced by the shared Standard owner. */
  readonly opaqueColor: GraphTextureView;
  /** Raw depth copy is backend-dependent and remains explicit when unavailable. */
  readonly rawDepth:
    | { readonly status: 'available'; readonly view: GraphTextureView }
    | {
        readonly status: 'unavailable';
        readonly reason: 'depth-copy-unavailable';
      };
}
/** Producer-owned Standard PBR resources resolved during graph execution. */
export interface GpuDrivenStandardPbrFrameResources {
  /** Current display-camera rejection for a batch containing exactly one candidate. */
  cameraVisible?: (source: import('./render-system-extract').RenderableSnapshot) => boolean;
  /** Resource generation of the actual scene-index/indirect producer. */
  readonly resourceGeneration?: number;
  /** Called only for a batch actually being recorded; prepares its exact physical binding. */
  prepareMaterialBinding(
    slot: number,
  ): { readonly group: BindGroup; readonly byteOffset: number } | undefined;
  /** Frame-global material slots keyed by shared binding and its physical resource class. */
  readonly materialSlotIndicesByBinding: Map<MaterialResource, Map<string, number>>;
  /** The current pass selects material membership and attachment formats. */
  selectedMaterialSlots?: ReadonlySet<number>;
  colorFormats?: readonly TextureFormat[];
  bundleDescriptor?: RenderBundleEncoderDescriptor;
  /** Exact producer-owned numeric Material table consumed by scene-index PBR. */
  readonly sceneMaterialBuffer: Buffer;
  /** Renderer-owned generic Surface page and frame/range metadata. */
  readonly surfaceDynamicInput?: {
    readonly page: Buffer;
    readonly frame: Buffer;
    readonly sharedFrame: Buffer;
    readonly pageBytes: number;
    readonly frameBytes: number;
    readonly sharedFrameBytes: number;
  };
  /**
   * Resolve the complete direct Surface slot-3 closure for one retained draw.
   * The producer validates the stable draw identity and instance count before
   * publishing a bind group; record never derives a frame-row address.
   */
  readonly surfaceDirectInstances?: (input: {
    readonly worldId: number;
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceCount: number;
    readonly firstInstanceOrdinal?: number;
    readonly instanceBuffer: Buffer;
    readonly probeBuffer?: Buffer;
    readonly probeOffset?: number;
  }) => Result<
    {
      readonly bindGroup: BindGroup;
      readonly dynamicOffsets: readonly number[];
      readonly frameBase: number;
      /** Public Surface member identities covered by the recorded command. */
      readonly memberIds: readonly string[];
    },
    RhiError
  >;
  /** Frame-local sink fed only by actual Surface draw commands. */
  readonly surfaceSubmissionObservation?: import('./surface/submission-observation').SurfaceSubmissionCandidate;
  /** Existing Standard clustered group(2), supplied by the main-pass owner. */
  clusterBindGroup?: BindGroup | undefined;
  /** Rebind the same cluster resources around one batch-local mesh row page. */
  clusterBindGroupForMesh?:
    | ((meshBuffer: Buffer, bindingBytes: number) => BindGroup | undefined)
    | undefined;
  /** Rebind clustered lighting around the scene-index Mesh/Palette/Morph page. */
  clusterBindGroupForSkin?:
    | ((
        meshBuffer: Buffer,
        meshBindingBytes: number,
        task: import('./record/skin-tasks').SkinTaskBinding,
      ) => BindGroup | undefined)
    | undefined;
}

export interface RenderPipelineBuildContext<FrameCtx extends RenderPipelineFrame> {
  readonly graph: RenderGraphBuilder<FrameCtx>;
  /** Prepared Renderer transport; this callback only declares work in the same graph. */
  readonly contributeProbePlacement?: (
    targets: import('./raytracing/probe-placement-graph').ProbePlacementTargets,
  ) => Result<void, RenderPipelineBuildError>;
  readonly contributeDiffuseGi?: (
    targets: import('./raytracing/diffuse-graph').RayDiffuseTargets,
  ) => Result<void, RenderPipelineBuildError>;
  /** Per-frame camera values consumed by optical fullscreen features. */
  readonly camera?: {
    readonly depthOfField?:
      | import('./features/depth-of-field/depth-of-field-params').DepthOfFieldParams
      | undefined;
  };
  /** Optional Standard-only output-domain coverage producer input. */
  readonly targetCoverage?: import('./temporal/target-coverage-attachment').TargetCoverageAttachment;
  /** Explicit receipt-bound color domains requested for this frame. */
  readonly observationCaptureDomains?: readonly FrameObservationDomain[] | undefined;
  /**
   * The single prepared Standard lighting projection for this frame.  The
   * Forward and Deferred adapters consume this value; they never inspect raw
   * light snapshots, cluster config, or capability facts themselves.
   */
  readonly standardLighting?: StandardTopologyInputValue;
  /**
   * Renderer-owned capability facts needed for admission decisions. The
   * Standard temporal producer must use the live device probe rather than
   * inferring rgba16float support from the selected surface format.
   */
  readonly capabilities?: Pick<RhiCaps, 'rgba16floatRenderable'>;
  /** Renderer-derived cloud shadow size shared by graph allocation and projection. */
  readonly cloudShadowResolution?: number;
  /** Prepared typed graph resources owned by RenderSystem/RenderFrameState. */
  readonly standardOutput?: {
    readonly autoExposure?: {
      readonly histogram: GraphBuffer;
      readonly state: GraphBuffer;
      readonly candidate: GraphBuffer;
      /** Authored camera/time parameters consumed by the GPU adapt stage. */
      readonly parameters: GraphBuffer;
    };
    readonly colorLut?: import('./pipeline/standard-output/lut-gpu').StandardLutGraphProjection;
  };
  /**
   * Renderer-owned TAA history targets. The graph sees only imported typed
   * targets; opaque RHI handles remain inside RenderFrameState.
   */
  readonly taaHistory?: {
    readonly currentColor: RenderPipelineTarget;
    readonly previousColor: RenderPipelineTarget;
    readonly currentTemporal: RenderPipelineTarget;
    readonly previousTemporal: RenderPipelineTarget;
    readonly currentStability: RenderPipelineTarget;
    readonly previousStability: RenderPipelineTarget;
  };
  /**
   * Renderer-owned CloudLayer transport history.  Each pair is backed by the
   * same submit-fenced temporal owner as TAA, while the three attachments keep
   * radiance, transmittance and representative depth in separate typed lanes.
   */
  readonly cloudHistory?: {
    readonly currentRadiance: RenderPipelineTarget;
    readonly previousRadiance: RenderPipelineTarget;
    readonly currentTransmittance: RenderPipelineTarget;
    readonly previousTransmittance: RenderPipelineTarget;
    readonly currentDepth: RenderPipelineTarget;
    readonly previousDepth: RenderPipelineTarget;
  };
  /** Renderer-owned SSR temporal history targets for the admitted spatial chain. */
  readonly ssrHistory?: {
    readonly previous: RenderPipelineTarget;
    readonly output: RenderPipelineTarget;
    readonly previousSurface: RenderPipelineTarget;
    readonly outputSurface: RenderPipelineTarget;
    readonly params: GraphBuffer;
  };
  /** Renderer-owned, prewarmed encoder for one graph mip level. */
  readonly encodeTransmissionMip?: (input: {
    readonly pass: RhiRenderPassEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
    readonly source: GraphTextureView;
    readonly destination: GraphTextureView;
    readonly format: TextureFormat;
    readonly level: number;
  }) => void;
  projectGpuDriven(target: {
    readonly format: TextureFormat;
    readonly sampleCount: 1 | 4;
    readonly additionalColorFormats?: readonly TextureFormat[];
    /** Reserve the two-phase HZB occlusion path; see `addLateOcclusion`. */
    readonly lateOcclusion?: boolean;
  }): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError>;
  /**
   * `cameraPyramid` offers the main camera's HZB to the view's caster cull;
   * the frame graph drops it whenever another consumer samples the shadows.
   */
  projectGpuDrivenShadow?(
    identity: ShadowViewIdentity,
    cameraPyramid?: GraphTextureView,
  ): Result<ShadowViewProjection | undefined, RenderGraphError>;
  /** Renderer-owned static shadow layers the graph imports instead of allocating. */
  readonly gpuDrivenShadowDepthLayers?: ShadowDepthLayers;
  readonly shadowDepthLayers?: ShadowDepthLayers;
  contributeFeatures(input: {
    readonly targets: readonly RenderPipelineFeatureTarget[];
    readonly semanticTargets?: readonly RenderPipelineTarget[] | undefined;
    readonly namedTargets?: Readonly<Record<string, RenderPipelineTarget>> | undefined;
    readonly standardSurfaceAccesses?: readonly GraphAccess[] | undefined;
    readonly placement?: RenderFeaturePlacement | undefined;
    /** Project only these identities at this ordered stage. */
    readonly include?: readonly string[] | undefined;
    /** Keep these identities for a later ordered stage. */
    readonly exclude?: readonly string[] | undefined;
    readonly passNames?: readonly string[] | undefined;
    readonly atmosphere?: import('./environment/luts').GraphAtmosphere | undefined;
  }): Result<void, RenderPipelineBuildError>;
  /** Prepare feature-owned shadow draws and their early compute producers once. */
  contributeShadowFeatures?(): Result<
    import('./features/render-graph-raster').RenderFeatureShadowDraws<FrameCtx> | undefined,
    RenderPipelineBuildError
  >;
  /** Add capture producers before scene consumers; return the optional planar sampled view. */
  contributeCubeCaptures?(
    environmentCube?: import('./environment/ibl').GraphEnvironment,
  ): Result<GraphTextureView | undefined, RenderPipelineBuildError>;
  /** Whether a producer-owned feature is installed for this graph build. */
  hasFeature?(identity: string): boolean;
  /** Whether a producer-owned feature has executable work at this graph build. */
  hasFeatureWork?(identity: string, placement?: RenderFeaturePlacement): boolean;
  /** Whether a producer-owned feature has a resolved raster pass this frame. */
  hasFeatureRasterWork?(identity: string, placement?: RenderFeaturePlacement): boolean;
}

/** Project the six CloudLayer history attachments into feature target aliases. */
export function renderPipelineCloudHistoryTargets(input: {
  readonly currentRadiance: RenderPipelineTarget;
  readonly previousRadiance: RenderPipelineTarget;
  readonly currentTransmittance: RenderPipelineTarget;
  readonly previousTransmittance: RenderPipelineTarget;
  readonly currentDepth: RenderPipelineTarget;
  readonly previousDepth: RenderPipelineTarget;
}): readonly RenderPipelineFeatureTarget[] {
  const entries: readonly (readonly [string, RenderPipelineTarget])[] = [
    ['cloud-history-radiance-previous', input.previousRadiance],
    ['cloud-history-radiance-current', input.currentRadiance],
    ['cloud-history-transmittance-previous', input.previousTransmittance],
    ['cloud-history-transmittance-current', input.currentTransmittance],
    ['cloud-history-depth-previous', input.previousDepth],
    ['cloud-history-depth-current', input.currentDepth],
  ];
  return entries.map(([name, target]) => ({ name, kind: 'scene-color' as const, ...target }));
}

export type RenderPipelineBuildError = RenderGraphError | RenderError | RhiError;

/**
 * Registrable, installable, hot-swappable render topology.
 *
 * `build` declares resources and passes only. The renderer owns compilation,
 * last-known-good replacement, execution, retirement, and the single frame submit.
 * Feature contributions enter through `contributeFeatures`, so compute-produced
 * buffers and later raster reads remain inside the same typed dependency graph.
 */
export interface RenderPipeline<FrameCtx extends RenderPipelineFrame = RenderPipelineFrame> {
  build(
    context: RenderPipelineBuildContext<FrameCtx>,
    topology: RenderPipelineTopology,
  ): Result<void, RenderPipelineBuildError>;
}
