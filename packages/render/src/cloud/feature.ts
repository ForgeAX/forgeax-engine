import {
  CLOUD_DENSITY_COMPUTE_WGSL,
  CLOUD_HISTORY_FULLSCREEN_WGSL,
  CLOUD_RESOLVE_FULLSCREEN_WGSL,
  CLOUD_TRANSPORT_ANALYTIC_FULLSCREEN_WGSL,
  CLOUD_TRANSPORT_FULLSCREEN_WGSL,
  CLOUD_VIEW_FULLSCREEN_WGSL,
} from '@forgeax/engine-shader';

export {
  CLOUD_DENSITY_COMPUTE_WGSL,
  CLOUD_HISTORY_FULLSCREEN_WGSL,
  CLOUD_RESOLVE_FULLSCREEN_WGSL,
  CLOUD_TRANSPORT_ANALYTIC_FULLSCREEN_WGSL,
  CLOUD_TRANSPORT_FULLSCREEN_WGSL,
  CLOUD_VIEW_FULLSCREEN_WGSL,
};

import { ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeaturePlanView,
  RenderFeatureWorkPlan,
} from '../features/plan';
import type {
  RenderFeature,
  RenderFeatureExtractContext,
  RenderFeatureExtractView,
  RenderFeatureSubmission,
} from '../features/types';
import { buildCloudDensityCache, type CloudDensityCache } from './density';
import {
  type CloudLayerInspection,
  cloudCapabilitiesFromRhi,
  inspectCloudLayer,
} from './inspection';
import {
  CLOUD_QUALITY_PROFILES,
  cloudLayerFormationKey,
  cloudShadowResolutionForQuality,
  cloudViewDistanceForQuality,
  type ValidatedCloudLayer,
} from './parameters';
import { inspectCloudLayerResources } from './resources';
import { type CloudShadowProjection, createCloudShadowProjection } from './shadow';
import {
  CloudHistoryStore,
  type CloudTemporalFrame,
  type CloudTemporalSignature,
  createCloudHistory,
} from './temporal';

export const CLOUD_LAYER_FEATURE_IDENTITY = 'forgeax.cloud-layer';

const COMPUTE_STAGE = 0x4;
const CLOUD_WORKGROUP_SIZE = 64;
// 24 vec4/u32 lanes: authored field, sun, integration mode and the
// renderer-owned stable light-space shadow projection. The same POD is used by
// the display and shadow entry points so they cannot drift in their density or
// cache addressing contract.
// The final lane carries temporal validity/reset/blend. Keep the payload
// explicitly 16-byte aligned so the public schema, prepared UBO and WGSL stay
// one contract.
export const CLOUD_VIEW_PARAMS_BYTES = 176;

/** R8 cache bytes are packed into little-endian u32 storage elements. */
function packCloudDensityCache(cache: CloudDensityCache): Uint32Array {
  const packed = new Uint32Array(Math.max(1, Math.ceil(cache.formationData.byteLength / 4)));
  for (let index = 0; index < cache.formationData.byteLength; index += 1) {
    const wordIndex = index >>> 2;
    packed[wordIndex] =
      (packed[wordIndex] ?? 0) | ((cache.formationData[index] ?? 0) << ((index & 3) * 8));
  }
  return packed;
}

export interface CloudLayerViewFrame {
  readonly params: ValidatedCloudLayer | undefined;
  readonly cache: CloudDensityCache | undefined;
  readonly sourceKey: string | undefined;
  readonly timeSeconds: number;
  readonly sunDirection: readonly [number, number, number] | undefined;
  readonly sunRadiance: readonly [number, number, number] | undefined;
  readonly shadowProjection: CloudShadowProjection | undefined;
  readonly temporal:
    | {
        readonly signature: CloudTemporalSignature;
        readonly cameraCut: boolean;
        readonly recovery: boolean;
      }
    | undefined;
  readonly generation: number;
  readonly inspection: CloudLayerInspection;
}

export interface CloudLayerFeatureFrame {
  readonly views: Readonly<Record<string, CloudLayerViewFrame>>;
  /** Producer updates this detached projection after receiver planning and submission. */
  inspection: Readonly<Record<string, CloudLayerInspection>>;
}

type CloudLayerPlannedView = Omit<CloudLayerViewFrame, 'temporal'> & {
  readonly temporal: CloudTemporalFrame | undefined;
};

export interface CloudLayerFeatureOptions {
  /** Disable the renderer-owned CloudLayer projection while retaining the component. */
  readonly enabled?: boolean;
}

function makeCloudViewParams(
  frame: CloudLayerPlannedView,
  cache: CloudDensityCache,
  mode: 0 | 1 | 2 = 0,
): Uint8Array {
  const params = new ArrayBuffer(CLOUD_VIEW_PARAMS_BYTES);
  const floats = new Float32Array(params);
  const integers = new Uint32Array(params);
  const profile = CLOUD_QUALITY_PROFILES[frame.params?.quality ?? 'medium'];
  const authored = frame.params;
  floats[0] = authored?.baseHeight ?? 0;
  floats[1] = authored?.thickness ?? 1;
  floats[2] = authored?.scale ?? 1;
  floats[3] = authored?.density ?? 0;
  floats[4] = authored?.coverage ?? 1;
  floats[5] = frame.timeSeconds;
  floats[6] =
    mode === 1
      ? (authored?.shadowRange ?? 0)
      : cloudViewDistanceForQuality(authored?.quality ?? 'medium');
  floats[7] = authored?.seed ?? 0;
  floats[8] = authored?.wind[0] ?? 0;
  floats[9] = authored?.wind[1] ?? 0;
  floats[10] = authored?.wind[2] ?? 0;
  floats[12] = frame.sunDirection?.[0] ?? 0;
  floats[13] = frame.sunDirection?.[1] ?? -1;
  floats[14] = frame.sunDirection?.[2] ?? 0;
  floats[15] = 0.2;
  floats[16] = frame.sunRadiance?.[0] ?? 0;
  floats[17] = frame.sunRadiance?.[1] ?? 0;
  floats[18] = frame.sunRadiance?.[2] ?? 0;
  integers[20] = cache.resolution;
  integers[21] = Math.max(1, Math.min(64, Math.floor(profile.viewSteps)));
  integers[22] = Math.max(1, Math.min(64, Math.floor(profile.shadowSteps)));
  integers[23] = mode;
  const projection = frame.shadowProjection;
  if (projection !== undefined) {
    floats[24] = projection.origin[0];
    floats[25] = projection.origin[1];
    floats[26] = projection.origin[2];
    floats[28] = projection.right[0];
    floats[29] = projection.right[1];
    floats[30] = projection.right[2];
    floats[32] = projection.up[0];
    floats[33] = projection.up[1];
    floats[34] = projection.up[2];
    floats[36] = projection.range;
    floats[37] = projection.lowSun ? 0 : 1;
    floats[38] = projection.lowSun ? 1 : 0;
    floats[39] = projection.texelSize;
  }
  const temporal = frame.temporal;
  floats[40] = temporal !== undefined && temporal.reset === false ? 1 : 0;
  floats[41] = temporal?.reset === true ? 1 : 0;
  floats[42] = temporal === undefined ? 0 : profile.historyWeight;
  // The history entry is the last successfully submitted signature. Carry its
  // timestamp so the shader can advect the representative cloud point by the
  // exact elapsed time during reprojection.
  floats[43] = temporal?.history?.temporal.timeSeconds ?? frame.timeSeconds;
  return new Uint8Array(params);
}

function planCloudDensity(
  frame: CloudLayerPlannedView,
  packedCache: Uint32Array,
  context: RenderFeaturePlanView &
    Pick<RenderFeaturePlanContext, 'caps' | 'getFeatureShaderSource'>,
): RenderFeatureWorkPlan {
  const shaderSource = (identifier: string, standalone: string): string => {
    if (context.getFeatureShaderSource === undefined) return standalone;
    const source = context.getFeatureShaderSource(identifier);
    if (source === undefined)
      throw new Error(`Missing cooked cloud program ${identifier}; rebuild the shader manifest`);
    return source;
  };
  const densityPrefix = `cloud-density-${frame.generation}`;
  const densityProgram = `${densityPrefix}.program`;
  const densityBindings = `${densityPrefix}.bindings`;
  const densityCache = `${densityPrefix}.cache`;
  const densityOutput = `${densityPrefix}.output`;
  const densityParams = `${densityPrefix}.params`;
  const cacheCount = packedCache.length;
  const params = new Uint32Array([cacheCount]);
  const inputTarget = context.targets.find((target) => target.name === 'motion-input');
  const outputTarget = context.targets.find((target) => target.name === 'motion-output');
  const historyRadiancePrevious = context.targets.find(
    (target) => target.name === 'cloud-history-radiance-previous',
  );
  const historyTransmittancePrevious = context.targets.find(
    (target) => target.name === 'cloud-history-transmittance-previous',
  );
  const historyDepthPrevious = context.targets.find(
    (target) => target.name === 'cloud-history-depth-previous',
  );
  const historyRadianceCurrent = context.targets.find(
    (target) => target.name === 'cloud-history-radiance-current',
  );
  const historyTransmittanceCurrent = context.targets.find(
    (target) => target.name === 'cloud-history-transmittance-current',
  );
  const historyDepthCurrent = context.targets.find(
    (target) => target.name === 'cloud-history-depth-current',
  );
  const hasHistoryTargets =
    historyRadiancePrevious !== undefined &&
    historyTransmittancePrevious !== undefined &&
    historyDepthPrevious !== undefined &&
    historyRadianceCurrent !== undefined &&
    historyTransmittanceCurrent !== undefined &&
    historyDepthCurrent !== undefined;
  const shadowTarget = context.targets.find((target) => target.name === 'cloud-shadow');
  const canShadow =
    shadowTarget !== undefined &&
    shadowTarget.sampleCount === 1 &&
    frame.shadowProjection !== undefined &&
    hasHistoryTargets;
  const canCompose =
    inputTarget !== undefined &&
    outputTarget !== undefined &&
    inputTarget.sampleCount === 1 &&
    outputTarget.sampleCount === 1 &&
    hasHistoryTargets;
  const transportReads = ['motion-input', { key: 'depth', sampleType: 'depth' as const }] as const;
  const transportCacheReads = [
    'motion-input',
    'cloud-shadow',
    { key: 'depth', sampleType: 'depth' as const },
  ] as const;
  const historyReads = [
    'motion-input',
    'cloud-history-radiance-previous',
    'cloud-history-transmittance-previous',
    'cloud-history-depth-previous',
    { key: 'depth', sampleType: 'depth' as const },
  ] as const;
  const historyAdditionalTextures = [
    'cloud-history-radiance-previous',
    'cloud-history-transmittance-previous',
    'cloud-history-depth-previous',
  ] as const;
  const viewParams = makeCloudViewParams(frame, frame.cache as CloudDensityCache);
  const shadowParams = canShadow
    ? makeCloudViewParams(frame, frame.cache as CloudDensityCache, 1)
    : undefined;
  const transportUsesShadowCache = canCompose && canShadow;
  return {
    resources: [
      {
        kind: 'compute-program',
        name: densityProgram,
        program: {
          wgsl: CLOUD_DENSITY_COMPUTE_WGSL,
          entryPoints: ['cloud_density_cache'],
          bindings: [
            {
              label: 'forgeax.cloud-layer.cache',
              entries: [
                { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
                { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
              ],
            },
          ],
        },
      },
      {
        kind: 'buffer',
        name: densityCache,
        size: packedCache.byteLength,
        usage: ['storage', 'copy-src'],
        data: packedCache,
      },
      {
        kind: 'buffer',
        name: densityOutput,
        size: packedCache.byteLength,
        usage: ['storage', 'copy-src'],
      },
      {
        kind: 'buffer',
        name: densityParams,
        size: params.byteLength,
        usage: ['uniform'],
        data: params,
      },
      {
        kind: 'compute-bindings',
        name: densityBindings,
        program: densityProgram,
        entries: [
          { binding: 0, resource: densityCache },
          { binding: 1, resource: densityOutput },
          { binding: 2, resource: densityParams },
        ],
      },
      {
        kind: 'fullscreen-program',
        name: 'cloud-layer-view',
        source: CLOUD_VIEW_FULLSCREEN_WGSL,
        usesView: true,
        storageBindings: [8],
        reads: historyReads,
        params: {
          byteSize: viewParams.byteLength,
          defaultValue: viewParams,
        },
      },
      ...(shadowParams === undefined
        ? []
        : [
            {
              kind: 'fullscreen-program' as const,
              name: 'cloud-layer-shadow',
              source: CLOUD_VIEW_FULLSCREEN_WGSL,
              usesView: true,
              storageBindings: [8],
              reads: historyReads,
              params: {
                byteSize: shadowParams.byteLength,
                defaultValue: shadowParams,
              },
            },
          ]),
      ...(canCompose
        ? [
            {
              kind: 'fullscreen-program' as const,
              name: 'cloud-layer-transport',
              source: shaderSource(
                transportUsesShadowCache
                  ? 'forgeax::cloud-atmosphere-transport'
                  : 'forgeax::cloud-atmosphere-transport-analytic',
                transportUsesShadowCache
                  ? CLOUD_TRANSPORT_FULLSCREEN_WGSL
                  : CLOUD_TRANSPORT_ANALYTIC_FULLSCREEN_WGSL,
              ),
              fragmentEntryPoint: 'fs_transport',
              usesView: true,
              storageBindings: [8],
              reads: transportUsesShadowCache ? transportCacheReads : transportReads,
              params: {
                byteSize: viewParams.byteLength,
                defaultValue: viewParams,
              },
            },
            {
              kind: 'fullscreen-program' as const,
              name: 'cloud-layer-resolve',
              source: shaderSource(
                'forgeax::cloud-atmosphere-resolve',
                CLOUD_RESOLVE_FULLSCREEN_WGSL,
              ),
              usesView: true,
              reads: [
                'motion-input',
                'cloud-history-radiance-current',
                'cloud-history-transmittance-current',
                'cloud-history-depth-current',
                'cloud-history-radiance-previous',
                'cloud-history-transmittance-previous',
                'cloud-history-depth-previous',
                { key: 'depth', sampleType: 'depth' as const },
              ],
              params: {
                byteSize: viewParams.byteLength,
                defaultValue: viewParams,
              },
            },
          ]
        : []),
      ...(canCompose
        ? [
            {
              kind: 'graphics-program' as const,
              name: 'cloud-layer-transport-pipeline',
              program: {
                shader: 'cloud-layer-transport',
                vertexLayout: 'none',
                colorFormats: [
                  historyRadianceCurrent.format,
                  historyTransmittanceCurrent.format,
                  historyDepthCurrent.format,
                ],
                sampleCount: 1 as const,
                renderState: {
                  depthWriteEnabled: false,
                  depthCompare: 'always' as const,
                },
              },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'cloud-layer-transport-view-bindings',
              program: 'cloud-layer-transport-pipeline',
              values: { group: 0, view: true },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'cloud-layer-transport-bindings',
              program: 'cloud-layer-transport-pipeline',
              values: {
                group: 1,
                fullscreen: true,
                shader: 'cloud-layer-transport',
                input: 'motion-input',
                depth: 'depth',
                additionalTextures: transportUsesShadowCache ? ['cloud-shadow'] : [],
                storageBuffers: [densityOutput],
              },
              logicalTargets: { input: 'motion-input' },
            },
            {
              kind: 'graphics-program' as const,
              name: 'cloud-layer-resolve-pipeline',
              program: {
                shader: 'cloud-layer-resolve',
                vertexLayout: 'none',
                colorFormats: [outputTarget.format],
                sampleCount: 1 as const,
                renderState: {
                  depthWriteEnabled: false,
                  depthCompare: 'always' as const,
                },
              },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'cloud-layer-resolve-view-bindings',
              program: 'cloud-layer-resolve-pipeline',
              values: { group: 0, view: true },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'cloud-layer-resolve-bindings',
              program: 'cloud-layer-resolve-pipeline',
              values: {
                group: 1,
                fullscreen: true,
                shader: 'cloud-layer-resolve',
                input: 'motion-input',
                depth: 'depth',
                additionalTextures: [
                  'cloud-history-radiance-current',
                  'cloud-history-transmittance-current',
                  'cloud-history-depth-current',
                  'cloud-history-radiance-previous',
                  'cloud-history-transmittance-previous',
                  'cloud-history-depth-previous',
                ],
              },
            },
          ]
        : []),
      ...(canShadow
        ? [
            {
              kind: 'graphics-program' as const,
              name: 'cloud-layer-shadow-pipeline',
              program: {
                shader: 'cloud-layer-shadow',
                vertexLayout: 'none',
                colorFormats: [shadowTarget.format],
                sampleCount: 1 as const,
                renderState: {
                  depthWriteEnabled: false,
                  depthCompare: 'always' as const,
                  blend: {
                    color: {
                      srcFactor: 'one' as const,
                      dstFactor: 'zero' as const,
                      operation: 'add' as const,
                    },
                    alpha: {
                      srcFactor: 'one' as const,
                      dstFactor: 'zero' as const,
                      operation: 'add' as const,
                    },
                  },
                },
              },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'cloud-layer-shadow-view-bindings',
              program: 'cloud-layer-shadow-pipeline',
              values: { group: 0, view: true },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'cloud-layer-shadow-bindings',
              program: 'cloud-layer-shadow-pipeline',
              values: {
                group: 1,
                fullscreen: true,
                shader: 'cloud-layer-shadow',
                input: false,
                depth: 'depth',
                // The shadow branch's WGSL keeps the shared depth binding
                // shape, but its light-space path never samples scene depth.
                // Bind the renderer-owned far-depth fallback instead of
                // introducing a read-before-main graph dependency.
                depthFallback: true,
                additionalTextures: historyAdditionalTextures,
                storageBuffers: [densityOutput],
              },
            },
          ]
        : []),
    ],
    passes:
      context.caps.compute && context.caps.storageBuffer
        ? [
            {
              kind: 'compute' as const,
              name: `${densityPrefix}.compute`,
              program: densityProgram,
              bindings: densityBindings,
              dispatches: [
                {
                  kind: 'direct' as const,
                  entryPoint: 'cloud_density_cache',
                  workgroups: [Math.max(1, Math.ceil(cacheCount / CLOUD_WORKGROUP_SIZE))],
                },
              ],
            },
            ...(canShadow
              ? [
                  {
                    kind: 'raster' as const,
                    name: 'cloud-layer-shadow',
                    colorAttachments: [
                      {
                        target: 'cloud-shadow',
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                      },
                    ],
                    sampledTargets: [
                      'cloud-history-radiance-previous',
                      'cloud-history-transmittance-previous',
                      'cloud-history-depth-previous',
                    ],
                    draws: [
                      {
                        program: 'cloud-layer-shadow-pipeline',
                        bindings: [
                          'cloud-layer-shadow-view-bindings',
                          'cloud-layer-shadow-bindings',
                        ],
                        vertexData: [],
                        vertexLayout: 'none' as const,
                        draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                      },
                    ],
                  },
                ]
              : []),
            ...(canCompose
              ? [
                  {
                    kind: 'raster' as const,
                    name: 'cloud-layer-transport',
                    colorAttachments: [
                      {
                        target: 'cloud-history-radiance-current',
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                      },
                      {
                        target: 'cloud-history-transmittance-current',
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                      },
                      {
                        target: 'cloud-history-depth-current',
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                      },
                    ],
                    sampledTargets: [
                      'motion-input',
                      'depth',
                      ...(transportUsesShadowCache ? ['cloud-shadow'] : []),
                    ],
                    draws: [
                      {
                        program: 'cloud-layer-transport-pipeline',
                        bindings: [
                          'cloud-layer-transport-view-bindings',
                          'cloud-layer-transport-bindings',
                        ],
                        vertexData: [],
                        vertexLayout: 'none' as const,
                        draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                      },
                    ],
                  },
                  {
                    kind: 'raster' as const,
                    name: 'cloud-layer-resolve',
                    colorAttachments: [
                      {
                        target: 'motion-output',
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                      },
                    ],
                    sampledTargets: [
                      'motion-input',
                      'depth',
                      'cloud-history-radiance-current',
                      'cloud-history-transmittance-current',
                      'cloud-history-depth-current',
                      'cloud-history-radiance-previous',
                      'cloud-history-transmittance-previous',
                      'cloud-history-depth-previous',
                    ],
                    draws: [
                      {
                        program: 'cloud-layer-resolve-pipeline',
                        bindings: [
                          'cloud-layer-resolve-view-bindings',
                          'cloud-layer-resolve-bindings',
                        ],
                        vertexData: [],
                        vertexLayout: 'none' as const,
                        draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                      },
                    ],
                  },
                ]
              : []),
          ]
        : [],
  };
}

/**
 * Renderer-installed cloud producer. Authoring is read once from World at
 * extraction; resource preparation, graph ordering and retirement stay with
 * RenderFeatureHost.
 */
export function createCloudLayerFeature(
  options: CloudLayerFeatureOptions = {},
): RenderFeature<CloudLayerFeatureFrame> {
  let generation = 0;
  const caches = new Map<string, { cache: CloudDensityCache; generation: number }>();
  const histories = new CloudHistoryStore(Infinity);
  const acceptedInspections = new Map<string, CloudLayerInspection>();
  const extractView = (
    context: RenderFeatureExtractContext & RenderFeatureExtractView,
  ): Result<CloudLayerViewFrame, RenderError> => {
    if (options.enabled === false) {
      return ok({
        params: undefined,
        cache: undefined,
        sourceKey: undefined,
        timeSeconds: 0,
        sunDirection: undefined,
        sunRadiance: undefined,
        shadowProjection: undefined,
        temporal: undefined,
        generation,
        inspection: inspectCloudLayer({ authored: false }),
      });
    }
    if (context.worlds.length === 0) {
      return ok({
        params: undefined,
        cache: undefined,
        sourceKey: undefined,
        timeSeconds: 0,
        sunDirection: undefined,
        sunRadiance: undefined,
        shadowProjection: undefined,
        temporal: undefined,
        generation,
        inspection: inspectCloudLayer({ authored: false }),
      });
    }
    // The normal RenderSystem extract owns World reads and selected-sun
    // resolution. Direct feature probes must provide the same frame facts;
    // this keeps the feature from growing a detached authoring callback or
    // a second per-feature ECS registry.
    const cloud = context.frame?.cloudLayer;
    const capability =
      context.caps === undefined ? undefined : cloudCapabilitiesFromRhi(context.caps);
    if (cloud === undefined) {
      return ok({
        params: undefined,
        cache: undefined,
        sourceKey: undefined,
        timeSeconds: 0,
        sunDirection: undefined,
        sunRadiance: undefined,
        shadowProjection: undefined,
        temporal: undefined,
        generation,
        inspection: inspectCloudLayer({
          authored: false,
          ...(capability === undefined ? {} : { capability }),
        }),
      });
    }
    const formationKey = cloudLayerFormationKey(cloud.params);
    let cacheEntry = caches.get(formationKey);
    if (cacheEntry === undefined) {
      cacheEntry = { cache: buildCloudDensityCache(cloud.params), generation: ++generation };
      caches.set(formationKey, cacheEntry);
    }
    const cached = cacheEntry.cache;
    const cacheGeneration = cacheEntry.generation;
    const view = context.frame?.view;
    const shadowProjection =
      view === undefined || cloud.sunDirection === undefined
        ? undefined
        : createCloudShadowProjection({
            center: view.shadowAnchor ?? view.cameraPosition,
            sunDirection: cloud.sunDirection,
            range: cloud.params.shadowRange,
            resolution: cloudShadowResolutionForQuality(cloud.params.quality),
          });
    const temporalSignature: CloudTemporalSignature | undefined =
      view === undefined
        ? undefined
        : {
            sourceKey: cloud.sourceKey,
            viewId: context.identity,
            authoringGeneration: cacheGeneration,
            cloudShadowRevision: shadowProjection?.revision ?? 0,
            cameraRevision: view.cameraRevision,
            deviceGeneration: view.deviceGeneration,
            width: view.width,
            height: view.height,
            timeSeconds: cloud.worldTimeSeconds,
            quality: cloud.params.quality,
            ...(view.sceneDepthVersion === undefined
              ? {}
              : { sceneDepthVersion: view.sceneDepthVersion }),
          };
    const temporal =
      temporalSignature === undefined
        ? undefined
        : {
            signature: temporalSignature,
            cameraCut: view?.cameraCut === true,
            recovery: view?.recovery === true,
          };
    const resourceFacts = inspectCloudLayerResources({
      generation: cacheGeneration,
      cache: cached,
      ...(shadowProjection === undefined ? {} : { shadow: shadowProjection }),
    });
    return ok({
      params: cloud.params,
      cache: cached,
      sourceKey: cloud.sourceKey,
      timeSeconds: cloud.worldTimeSeconds,
      sunDirection: cloud.sunDirection,
      sunRadiance: cloud.sunRadiance,
      shadowProjection,
      temporal,
      generation: cacheGeneration,
      inspection: inspectCloudLayer({
        authored: true,
        sourceKey: cloud.sourceKey,
        generation: cacheGeneration,
        resourceFacts,
        ...(shadowProjection === undefined ? {} : { shadowRevision: shadowProjection.revision }),
        ...(capability === undefined ? {} : { capability }),
        budget: {
          quality: cloud.params.quality,
          reason:
            'physical GPU timing and residency receipts are unavailable until a prepared adapter submits them',
        },
      }),
    });
  };
  return Object.freeze({
    identity: CLOUD_LAYER_FEATURE_IDENTITY,
    placement: 'scene' as const,
    requiredCapabilities: ['compute', 'storageBuffer', 'rgba16floatRenderable'] as const,
    shaderModuleMode: 'immediate' as const,
    extract: (context: RenderFeatureExtractContext) => {
      const frames: Record<string, CloudLayerViewFrame> = Object.create(null);
      for (const view of context.views) {
        if (!view.render) continue;
        const extracted = extractView({ ...context, ...view });
        if (!extracted.ok) return extracted;
        frames[view.identity] = extracted.value;
      }
      const formations = new Set(
        context.views.flatMap((view) =>
          view.frame?.cloudLayer === undefined
            ? []
            : [cloudLayerFormationKey(view.frame.cloudLayer.params)],
        ),
      );
      for (const key of caches.keys()) if (!formations.has(key)) caches.delete(key);
      return ok({
        views: frames,
        inspection: Object.freeze(
          Object.fromEntries(
            Object.entries(frames).map(([identity, frame]) => [identity, frame.inspection]),
          ),
        ),
      });
    },
    onFrameSubmitted: (frames: CloudLayerFeatureFrame, receipt: RenderFeatureSubmission) => {
      const inspection = { ...frames.inspection };
      for (const work of receipt.works) {
        if (work.scope === 'frame') continue;
        const frame = frames.views[work.scope.view];
        if (frame?.params === undefined) {
          histories.reset(work.scope.view);
          const off = inspectCloudLayer({ authored: false });
          acceptedInspections.set(work.scope.view, off);
          inspection[work.scope.view] = off;
          continue;
        }
        if (
          !work.passes.some((pass) => pass.name === 'cloud-layer-transport') ||
          frame.temporal === undefined
        )
          continue;
        histories.commit(
          frame.temporal.signature,
          createCloudHistory(frame.temporal.signature, frame.generation, true),
        );
        const candidate = frames.inspection[work.scope.view];
        if (candidate !== undefined) {
          const accepted = Object.freeze({
            ...candidate,
            resourceStage: 'accepted' as const,
            candidateGeneration: undefined,
          });
          acceptedInspections.set(work.scope.view, accepted);
          inspection[work.scope.view] = accepted;
        }
      }
      frames.inspection = Object.freeze(inspection);
    },
    plan: (
      frames: CloudLayerFeatureFrame,
      context: RenderFeaturePlanContext,
    ): Result<RenderFeaturePlan, RenderError> => {
      const roster = new Set(context.views.map((view) => view.identity));
      histories.retain(roster);
      for (const identity of acceptedInspections.keys())
        if (!roster.has(identity)) acceptedInspections.delete(identity);
      const inspection: Record<string, CloudLayerInspection> =
        Object.fromEntries(acceptedInspections);
      const work: RenderFeaturePlan['work'][number][] = [];
      const densityResources: RenderFeatureWorkPlan['resources'][number][] = [];
      const densityPasses: RenderFeatureWorkPlan['passes'][number][] = [];
      const densityGenerations = new Set<number>();
      for (const view of context.views) {
        const frame = frames.views[view.identity];
        if (!view.render) continue;
        if (frame?.cache === undefined || frame.params === undefined) {
          inspection[view.identity] = frame?.inspection ?? inspectCloudLayer({ authored: false });
          work.push({ scope: { view: view.identity }, resources: [], passes: [] });
          continue;
        }
        const decision =
          frame.temporal === undefined
            ? undefined
            : histories.begin(frame.temporal.signature, frame.temporal);
        const temporal: CloudTemporalFrame | undefined =
          frame.temporal === undefined || decision === undefined
            ? undefined
            : {
                signature: frame.temporal.signature,
                history:
                  decision.history ??
                  createCloudHistory(frame.temporal.signature, frame.generation, false),
                reset: decision.reset,
                reasons: decision.reasons,
              };
        const accepted = acceptedInspections.get(view.identity);
        const lastTemporalReset = temporal?.reasons.at(-1) ?? accepted?.lastTemporalReset;
        inspection[view.identity] = inspectCloudLayer({
          authored: true,
          ...(frame.sourceKey === undefined ? {} : { sourceKey: frame.sourceKey }),
          generation: frame.generation,
          candidateGeneration: frame.generation,
          capability: cloudCapabilitiesFromRhi(context.caps),
          temporalResets: (accepted?.temporalResets ?? 0) + (temporal?.reset === true ? 1 : 0),
          ...(lastTemporalReset === undefined ? {} : { lastTemporalReset }),
          ...(frame.shadowProjection === undefined
            ? {}
            : { shadowRevision: frame.shadowProjection.revision }),
          resourceFacts: inspectCloudLayerResources({
            generation: frame.generation,
            cache: frame.cache,
            ...(frame.shadowProjection === undefined ? {} : { shadow: frame.shadowProjection }),
            ...(temporal?.history === undefined ? {} : { history: temporal.history }),
          }),
          budget: frame.inspection.budget,
        });
        const planned = planCloudDensity(
          { ...frame, temporal },
          packCloudDensityCache(frame.cache),
          {
            ...view,
            caps: context.caps,
            getFeatureShaderSource: context.getFeatureShaderSource,
          },
        );
        const isDensityResource = (resource: RenderFeatureWorkPlan['resources'][number]) =>
          resource.kind === 'buffer' ||
          resource.kind === 'compute-program' ||
          resource.kind === 'compute-bindings';
        // One shared density producer feeds every view that uses this formation.
        if (!densityGenerations.has(frame.generation)) {
          densityGenerations.add(frame.generation);
          densityResources.push(...planned.resources.filter(isDensityResource));
          densityPasses.push(...planned.passes.filter((pass) => pass.kind === 'compute'));
        }
        work.push({
          scope: { view: view.identity },
          resources: planned.resources.filter((resource) => !isDensityResource(resource)),
          passes: planned.passes.filter((pass) => pass.kind !== 'compute'),
        });
      }
      if (densityResources.length > 0)
        work.unshift({ scope: 'frame', resources: densityResources, passes: densityPasses });
      frames.inspection = Object.freeze(inspection);
      return ok({ work });
    },
  });
}
