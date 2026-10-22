import { halfFloat } from '@forgeax/engine-math';
import { textureReadbackLayout } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  type FrameRecording,
  profileFrameRecording,
  recordPreparationBarrier,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { capsuleConeHalfAngle } from '../capsule-shadow/frame';
import { inspectCapsuleShadow } from '../capsule-shadow/inspection';
import { PlanarCaptureState } from '../capture/planar-state';
import { PlanarReflectionInvalidError } from '../components/planar-reflection';
import { settleAtmospherePublish, stageAtmospherePublish } from '../environment/storage';
import { RenderTargetLayerInvalidError } from '../errors/render';
import type { FogFrame } from '../extract/environment';
import { EMPTY_GPU_DRAW_SELECTION } from '../gpu-driven/draw-selection';
import { collectGpuDrivenMaterialArtifacts } from '../gpu-driven/material-artifacts';
import { EMPTY_MATERIAL_BINDINGS } from '../gpu-driven/material-bindings';
import { resolveTransparencyView } from '../oit/view';
import type { RenderResourceScope } from '../publication/resource-scope';
import { renderTime } from '../publication/resource-scope';
import { RendererBakedField } from '../raytracing/renderer-baked-field';
import { RendererRayDiffuse } from '../raytracing/renderer-diffuse';
import { RendererIrradianceField } from '../raytracing/renderer-irradiance-field';
import { RendererProbePlacement } from '../raytracing/renderer-probe-placement';
import { RendererScreenProbe } from '../raytracing/renderer-screen-probe';
import { isNativePlacementMaterial } from '../raytracing/scene-field-projection';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { MaterialFrame } from '../scene/material-dispatch';
import { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { GpuRasterOwnership } from '../scene/render-scene';
import { subsurfaceTopology } from '../subsurface/demand';
import { type SubsurfaceDemand, SubsurfaceSelection } from '../subsurface/selection';
import { SHADOW_CASTER_PASS_SELECTOR } from '../systems/pass-selector';
import { renderTargetLayerCount } from '../targets/contracts';
import { cpuLaneLodRows } from './cpu-lod';
import { directDrawRows } from './direct-draws';
import {
  currentDirectionalShadowPublication,
  prepareDirectionalCascadeCadence,
} from './directional-cascade-cadence';
import {
  prepareDirectionalShadowCache,
  type ShadowMeshInput,
  shadowMeshInputCurrent,
  shadowMeshReadsForQuery,
} from './directional-shadow-cache';
import {
  buildDispatchPlan,
  cleanPerFrameCaches,
  computeFoldBuckets,
  validateRenderables,
} from './fold-buckets';
import { createPassTimingInstrumentation } from './gpu-pass-timing/instrumentation';
import { materialGeometry } from './material-geometry';
import { materialMatchesPass } from './material-pass-selection';
import { flushMeshDrawUploads } from './mesh-ssbo';
import { gpuDrivenMeshesForFrame, querySceneExecution } from './resident-meshes';
import { prepareScenePasses, scenePassRequests } from './scene-pass-work';
import { shadowPlanes, shadowViewPlanesByView } from './shadow-culling';
import { prepareShadowMaterialPipelines } from './shadow-pass';
import { shadowUpdatePolicy } from './shadow-update-policy';
import {
  disposeTargetCaptureLighting,
  prepareTargetCaptureLighting,
} from './target-capture-lighting';
import { PLANAR_REFLECTION_UNIFORM_OFFSET } from './view-ubo';
// @forgeax/engine-runtime - RenderSystem record stage: frame.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { readMaterialContent } from '@forgeax/engine-assets-runtime/internal';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import {
  type CurrentFrameObservationLease,
  createCurrentFrameObservationLease,
} from '@forgeax/engine-render-graph';
import {
  type Buffer,
  err,
  ok,
  type Result,
  type RhiCommandEncoder,
  RhiError,
  type TextureFormat,
} from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { isTimestampQueryAdmitted } from '../assembly/device-feature-admission';
import type { ExtractedCloudLayer } from '../cloud/extract';
import { cloudShadowResolutionForQuality } from '../cloud/parameters';
import { type CloudShadowProjection, createCloudShadowProjection } from '../cloud/shadow';
import { CUBE_CAMERA_FACE_ORDER } from '../components/cube-camera';
import { directionalShadowFilterRadiusTexels } from '../components/directional-shadow-filter';
import type { MeshGpuHandles } from '../device/gpu-residency';
import {
  ObservationUnavailableError,
  type ObservationUnavailableReason,
  RendererOperationError,
} from '../errors/render';
import { BARREL_DISTORTION_POST_PROCESS_ID } from '../features/barrel-distortion';
import {
  DEPTH_OF_FIELD_MSAA_POST_PROCESS_IDS,
  DEPTH_OF_FIELD_POST_PROCESS_IDS,
} from '../features/depth-of-field/depth-of-field-feature';
import {
  packDepthOfFieldParams,
  resolveDepthOfFieldFrameParams,
} from '../features/depth-of-field/depth-of-field-params';
import { LENS_EFFECTS_POST_PROCESS_ID, packLensEffectsParams } from '../features/lens-effects';
import { LENS_FLARE_PROGRAMS, packLensFlareParams } from '../features/lens-flare';
import type {
  GpuDrivenProduction,
  PreparedGpuDrivenFrame,
  ShadowViewRequest,
} from '../gpu-driven/production-raster';
import {
  type ShadowCameraCullDilation,
  type ShadowViewIdentity,
  shadowCameraCullDilation,
  shadowViewIdentityKey,
} from '../gpu-driven/shadow-views';
import { type GpuDrivenLodSubmitIdentity, selectGpuLodLane } from '../gpu-driven/view-gpu';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { OUTPUT_GAMUT_CODE } from '../output-color-space';
import {
  DynamicResolutionController,
  gpuPassFrameMilliseconds,
} from '../pipeline/dynamic-resolution';
import { inspectStandardLighting } from '../pipeline/standard-lighting/inspection';
import { standardLightingTopologySignature } from '../pipeline/standard-lighting/topology';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { inspectPointShadow } from '../point-shadow-inspection';
import type {
  CameraSnapshot,
  SpotLightProjectorFrameContext,
  VolumetricFogFrameContext,
} from '../render-contract';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import type {
  DispatchList,
  ExtractedLights,
  ExtractedVolumetricFog,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import {
  admitSsrSpatial,
  type SsrDependenciesInspection,
  type SsrSpatialAdmission,
} from '../ssr/admission';
import { createSsrHistoryOwner } from '../ssr/history';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import { terrainShadowReceivers } from '../terrain/shadow-family';
import type { TransmissionDemand } from '../transmission/projection';
import { hasVolumetricFogCapability } from '../volume/capability';
import { projectVolumeCompositeBounds } from '../volume/composite-scissor';
import { inspectVolumetricFogResources } from '../volume/resources';
import { resolveVolumeTemporalReset, type VolumeTemporalSignature } from '../volume/temporal';
import {
  buildPerFrameBindGroups,
  prepareFrameLighting,
  resolveSkyboxActive,
  warnZeroLightStandard,
  writeHdrpClusterAndSsaoBuffers,
  writeLightModifierTextures,
  writeShadowParamsBuffer,
} from './frame-lighting';
import {
  type BindGroupCounts,
  type DispatchCounts,
  type FrameObservationSource,
  getTextureIdentity,
  makeZeroCameraFallbackSnapshot,
  type ReflectionFallbackReadbackRequest,
  type RenderFrameState,
  resetFrameRecordingOutputs,
  type ValidatedRenderable,
  validateGraphTargetCaptureReadback,
  worldEntityKey,
} from './frame-snapshot';
import { emitGpuDrivenDrawReceipts, type RenderableDrawReceipt } from './gpu-draw-receipts';
import { ensureProbeBlendRecordBuffer } from './probe-blend-buffer';
import {
  type _InternalRenderPipelineContext,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from './render-context';
import { mapSsrHistoryResetReason, reportSsrHistoryFailure } from './ssr-history-frame';
import {
  emptyVolumetricFogParams,
  prepareVolumetricFogFrame,
  promoteVolumetricFogParams,
  stageVolumetricFogParams,
} from './volume-params';
import { volumetricFogForView } from './volume-view';

export {
  buildDispatchPlan,
  buildMaterialSlotPlan,
  findRenderablePrefixForSlotCapacity,
  materialSlotCountForPrefix,
  validateRenderables,
} from './fold-buckets';
export type { FrameObservationSource } from './frame-snapshot';

export type FrameObservationReadback = (
  lease: CurrentFrameObservationLease,
) => Promise<Result<Uint8Array, Error>>;

export interface FrameObservationOptions {
  readonly semantic: 'linear-hdr';
  readonly readback: FrameObservationReadback;
}

export interface FrameObservationMetadata {
  readonly format: TextureFormat;
  readonly size: { readonly width: number; readonly height: number };
  readonly usage: number;
  readonly sample: number;
  readonly frameId: number;
  readonly lifetime: { readonly frameId: number; readonly state: 'active' | 'retired' };
  readonly pipelineId: 'forgeax::standard';
  readonly backendId: string;
}

export interface FrameObservation {
  readonly bytes: Uint8Array;
  readonly metadata: FrameObservationMetadata;
}

function unavailable(
  reason: ObservationUnavailableReason,
  hint: string,
): Result<never, ObservationUnavailableError> {
  return err(new ObservationUnavailableError(reason, hint));
}

function mapLeaseFailure(code: string, hint: string): Result<never, ObservationUnavailableError> {
  let reason: ObservationUnavailableReason = 'resource';
  if (code === 'observation-stale') reason = 'stale';
  else if (code === 'observation-invalid-format') reason = 'format';
  else if (code === 'observation-missing-copy-src') reason = 'copy-src';
  return unavailable(reason, hint);
}

export async function observeCurrentFrame(
  options: FrameObservationOptions,
  source: FrameObservationSource | undefined,
  currentFrameId: number,
): Promise<Result<FrameObservation, ObservationUnavailableError>> {
  if (options.semantic !== 'linear-hdr') {
    return unavailable('identity', 'request the producer-owned linear-hdr semantic');
  }
  if (source === undefined) {
    return unavailable(
      'no-frame',
      'draw a frame through the Standard producer before requesting observation',
    );
  }
  if (source.pipelineId !== 'forgeax::standard' || source.backendId.length === 0) {
    return unavailable(
      'identity',
      'observe a producer with explicit pipeline and backend identity',
    );
  }

  const leaseResult = createCurrentFrameObservationLease(
    { ...source.descriptor, texture: source.texture, frameId: source.frameId },
    currentFrameId,
  );
  if (!leaseResult.ok) {
    return mapLeaseFailure(leaseResult.error.code, leaseResult.error.hint);
  }

  let bytesResult: Result<Uint8Array, Error>;
  try {
    bytesResult = await options.readback(leaseResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unavailable('readback-failed', `retry the current-frame readback after: ${message}`);
  }
  if (!bytesResult.ok) {
    return unavailable('readback-failed', bytesResult.error.message);
  }

  const activeResult = leaseResult.value.beginReadback();
  if (!activeResult.ok) {
    return mapLeaseFailure(activeResult.error.code, activeResult.error.hint);
  }

  return ok({
    bytes: bytesResult.value,
    metadata: {
      format: leaseResult.value.descriptor.format,
      size: leaseResult.value.descriptor.size,
      usage: leaseResult.value.descriptor.usage,
      sample: source.descriptor.sample,
      frameId: source.frameId,
      lifetime: leaseResult.value.lifetime,
      pipelineId: source.pipelineId,
      backendId: source.backendId,
    },
  });
}

import {
  effectiveMotionBlurSampleCount,
  isMotionBlurIntervalValid,
  MOTION_BLUR_PARAMS_BYTE_SIZE,
  motionBlurExposureScale,
  motionBlurSampleDelta,
  motionBlurTemporalDemand,
} from '../features/motion-blur/motion-blur-params';
import { projectVisibleSurfaces } from '../raytracing/visible-surface';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import { createTemporalView, resolveTemporalReset, type TemporalView } from '../temporal/view';
import { inspectVolumetricFog } from '../volume/inspection';
import {
  packBarrelDistortionParams,
  resolveSubmittedBarrelMapping,
} from './barrel-distortion-frame';
import {
  acquireSwapChainTarget,
  graphExecutionPhase,
  hasShadowViewDemand,
  resolveShadowMapSize,
  resolveSpotShadowMapSize,
} from './frame-targets';
import { GpuTimingCapture } from './gpu-timing';
import {
  computeProjectionMatrix,
  computeViewMatrix,
  driveLazyEquirectProjection,
  selectLazyEquirectHandles,
  warnMultiSkybox,
  warnMultiSkylight,
} from './helpers';
import { createMainPassMaterialSelectionOwner, hasSsrSceneInputs } from './main-pass';
import { computeSplitLdrSprite } from './main-pass-sprite-draws';
import { writeShadowCasterUniforms } from './shadow-pass';
import {
  type CubeCaptureGraphState,
  compileTargetCaptureFrameGraph,
  ensureCompiledFrameGraph,
  getRenderFeatureGraphState,
  type RenderFeatureGraphCandidate,
  recordCompiledFrameGraph,
  settleCompiledFrameGraphCandidate,
} from './typed-frame-graph';
import { writePointsLinesViewUbo, writeViewUbo } from './view-ubo';

export type { RecordProfileRunner };

export interface CubeCaptureFrameInput {
  readonly sceneInputs?: readonly import('./target-capture-graph').CubeCaptureGraphWork[];
  readonly captureOnly?: boolean;
  readonly captureDispatch?: DispatchList;
  readonly subsurfaceDemand?: SubsurfaceDemand;
  readonly scheduledWork: readonly import('../capture/scheduler').CubeCaptureWork[];
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  readonly state: CubeCaptureGraphState;
  readonly reflectionProbes?: import('./render-context').ReflectionProbeRecordState;
}

function prepareCubeCapture(
  internals: RenderSystemInternals,
  input: CubeCaptureFrameInput | undefined,
  displayCamera: CameraSnapshot,
  frameNumber: number,
): readonly import('./typed-frame-graph').CubeCaptureGraphWork[] {
  if (input === undefined) return [];
  if (input.reflectionProbes === undefined) delete input.state.reflectionProbes;
  else input.state.reflectionProbes = input.reflectionProbes.graph;
  const work = input.scheduledWork;
  const physicalWork: import('./typed-frame-graph').CubeCaptureGraphWork[] = [];
  for (const item of work) {
    const physical = internals.getRenderTargetPhysical?.(item.target);
    if (physical === undefined) continue;
    const layer = CUBE_CAMERA_FACE_ORDER.indexOf(item.face);
    if (layer < 0) continue;
    const faceWorld = mat4.create();
    mat4.invert(faceWorld, item.view);
    physicalWork.push({
      target: item.target,
      candidateGeneration: item.candidateGeneration,
      layer,
      physical,
      faceCamera: {
        ...displayCamera,
        clipping: { planes: [] },
        position: vec3.create(item.position[0] ?? 0, item.position[1] ?? 0, item.position[2] ?? 0),
        world: faceWorld,
        fov: Math.PI / 2,
        aspect: 1,
        near: item.near,
        far: item.far,
        projection: 'perspective',
      },
    });
  }
  input.state.planar ??= new PlanarCaptureState();
  const planarCamera = input.auxiliaryCameras.find(
    (camera) => camera.planarReflection !== undefined,
  );
  const planarPhysical =
    planarCamera?.target === undefined
      ? undefined
      : internals.getRenderTargetPhysical?.(planarCamera.target);
  if (
    planarPhysical !== undefined &&
    (planarPhysical.descriptor.shape !== '2d' ||
      !planarPhysical.descriptor.sampled ||
      planarPhysical.descriptor.format.endsWith('-srgb'))
  )
    throw new PlanarReflectionInvalidError('target');
  const planarCapture = input.state.planar.prepare(planarCamera, planarPhysical, frameNumber);
  for (const camera of input.auxiliaryCameras) {
    if (camera.planarReflection !== undefined && planarCapture === undefined) continue;
    if (camera.target === undefined) continue;
    const physical =
      camera.planarReflection === undefined
        ? internals.getRenderTargetPhysical?.(camera.target)
        : planarCapture?.physical;
    if (physical === undefined || physical.descriptor.shape === 'cube') continue;
    const layer = camera.targetLayer ?? 0;
    const layerCount = renderTargetLayerCount(physical.descriptor);
    if (!Number.isInteger(layer) || layer < 0 || layer >= layerCount)
      throw new RenderTargetLayerInvalidError({
        operation: 'write',
        layer,
        shape: physical.descriptor.shape,
        layerCount,
      });
    physicalWork.push({
      target: camera.target,
      layer,
      physical,
      faceCamera: camera,
    });
  }
  physicalWork.push(...(input.sceneInputs ?? []));
  input.state.work = physicalWork;
  if (physicalWork.length === 0) disposeTargetCaptureLighting(input.state);
  return physicalWork;
}

const EMPTY_ENTITY_KEYS: ReadonlySet<number> = new Set<number>();

/** Unknown graphs retain all four padded matrix slots, including recovery/LKG. */
export function directionalShadowPreparationLimit(
  cascadeCount: number | undefined,
  installed: RenderFrameState['compiledFrameGraph'],
  previous: RenderFrameState['compiledFrameGraph'] | undefined,
): number | undefined {
  if (
    !Number.isInteger(cascadeCount) ||
    cascadeCount === undefined ||
    cascadeCount < 1 ||
    cascadeCount > 4
  )
    return undefined;
  const count = installed?.directionalShadowViewCount;
  if (count === undefined || !Number.isInteger(count) || count < 1 || count > 4) return undefined;
  if (previous !== undefined) {
    const old = previous?.directionalShadowViewCount;
    if (old === undefined || !Number.isInteger(old) || old < 1 || old > 4) return undefined;
    return Math.max(cascadeCount, count, old);
  }
  return Math.max(cascadeCount, count);
}

function createReflectionFallbackReadbackRequest(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): ReflectionFallbackReadbackRequest | undefined {
  if (!frameState.reflectionFallbackDemand || frameState.reflectionFallbackReadback !== undefined) {
    return undefined;
  }
  const graph = frameState.compiledFrameGraph?.targets;
  if (graph === undefined) return undefined;
  const descriptor = graph.getColorTargetDescriptor('reflection-fallback-linear-hdr');
  const texture = graph.getColorTargetTexture('reflection-fallback-linear-hdr');
  if (
    descriptor === undefined ||
    texture === undefined ||
    descriptor.format !== 'rgba16float' ||
    descriptor.sample !== 1
  ) {
    return undefined;
  }
  const { bytesPerRow, byteLength } = textureReadbackLayout(
    descriptor.size.width,
    descriptor.size.height,
    { blockWidth: 1, blockHeight: 1, bytesPerBlock: 8 },
  );
  const created = internals.device.createBuffer({
    label: 'reflection-fallback-linear-hdr.readback',
    size: byteLength,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    mappedAtCreation: false,
  });
  if (!created.ok) {
    internals.errorRegistry.fire(created.error);
    return undefined;
  }
  return {
    name: 'reflection-fallback-linear-hdr',
    buffer: created.value,
    bytesPerRow,
    width: descriptor.size.width,
    height: descriptor.size.height,
    expected: {
      format: descriptor.format,
      width: descriptor.size.width,
      height: descriptor.size.height,
      usage: GPU_TEXTURE_USAGE_COPY_SRC,
      graphGeneration: graph.graphGeneration,
      frameId: frameState.frameNumber,
      textureIdentity: getTextureIdentity(texture),
    },
    encoded: false,
  };
}

async function mapReflectionFallbackReadback(
  internals: RenderSystemInternals,
  request: ReflectionFallbackReadbackRequest,
  allowZero: boolean,
): Promise<{
  readonly linearHdr: readonly [number, number, number, number];
  readonly hash: string;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
}> {
  try {
    if (!request.encoded) throw new Error('reflection fallback copy was not encoded');
    const mapped = await request.buffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
    if (!mapped.ok) throw mapped.error;
    const range = mapped.value.getMappedRange();
    if (!range.ok) throw range.error;
    const bytes = new Uint8Array(range.value.slice(0));
    mapped.value.unmap();
    const validation = validateGraphTargetCaptureReadback({
      bytes,
      expectedByteLength: request.bytesPerRow * request.height,
      allowZero,
    });
    if (!validation.ok) throw new Error(validation.code);
    let linearHdr: readonly [number, number, number, number] = [0, 0, 0, 0];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let y = 0; y < request.height; y += 1) {
      for (let x = 0; x < request.width; x += 1) {
        const offset = y * request.bytesPerRow + x * 8;
        // Validation above already rejects non-finite half floats. Scan the
        // raw RGB magnitudes (both signed zero encodings are empty) without
        // allocating/decoding millions of background pixels each frame.
        const red = view.getUint16(offset, true);
        const green = view.getUint16(offset + 2, true);
        const blue = view.getUint16(offset + 4, true);
        if ((red & 0x7fff) !== 0 || (green & 0x7fff) !== 0 || (blue & 0x7fff) !== 0) {
          linearHdr = [
            halfFloat.f16ToF32(red),
            halfFloat.f16ToF32(green),
            halfFloat.f16ToF32(blue),
            halfFloat.f16ToF32(view.getUint16(offset + 6, true)),
          ];
          y = request.height;
          break;
        }
      }
    }
    // A cleared attachment has a non-zero alpha lane, so byte-level
    // validation alone can incorrectly admit an otherwise empty MRT.  When
    // the selected producer is non-neutral, require an actual finite RGB
    // sample before publishing a complete receipt; neutral rows explicitly
    // retain the zero quartet through allowZero=true.
    if (
      !allowZero &&
      !linearHdr.slice(0, 3).some((value) => Number.isFinite(value) && value !== 0)
    ) {
      throw new Error('capture-readback-empty');
    }
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error('Web Crypto SHA-256 is unavailable');
    const digest = await subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    return {
      linearHdr,
      hash: `sha256:${hash}`,
      graphGeneration: request.expected.graphGeneration,
      textureIdentity: request.expected.textureIdentity,
    };
  } finally {
    internals.device.destroyBuffer(request.buffer);
  }
}

const VOLUMETRIC_FOG_PASS_COUNT = 4;

/** Retire parameter buffers only after the submit that stopped using them. */
function retireVolumetricFogParams(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): void {
  const buffers = frameState.volumetricFogParams.buffers;
  frameState.volumetricFogParams = emptyVolumetricFogParams();
  const live = buffers.filter((buffer): buffer is Buffer => buffer !== null);
  if (live.length === 0) return;
  const device = internals.device;
  const release = (): void => {
    for (const buffer of live) {
      const destroyed = device.destroyBuffer(buffer);
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
  };
  try {
    void device.queue.onSubmittedWorkDone().then(release, release);
  } catch {
    release();
  }
}

function volumeRevision(values: readonly number[]): number {
  let hash = 2166136261;
  for (const value of values) {
    const quantized = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0;
    hash = Math.imul(hash ^ quantized, 16777619) >>> 0;
  }
  return hash;
}

/** Resolve the stable world-space projection shared by cloud and lighting. */
function cloudShadowProjectionFor(
  cloudLayer: ExtractedCloudLayer | undefined,
):
  | (CloudShadowProjection & { readonly baseHeight: number; readonly thickness: number })
  | undefined {
  if (cloudLayer?.sunDirection === undefined) return undefined;
  return {
    ...createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: cloudLayer.sunDirection,
      range: cloudLayer.params.shadowRange,
      resolution: cloudShadowResolutionForQuality(cloudLayer.params.quality),
    }),
    baseHeight: cloudLayer.params.baseHeight,
    thickness: cloudLayer.params.thickness,
  };
}

function volumeTemporalSignature(
  fog: ExtractedVolumetricFog,
  prepared: VolumetricFogFrameContext,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
): VolumeTemporalSignature {
  const authored = fog.fog;
  const directional = lights.directional;
  const cameraRevision = volumeRevision([
    ...camera.world,
    camera.fov,
    camera.aspect,
    ...(camera.projectionOffset ?? [0, 0]),
    camera.near,
    camera.far,
    camera.orthoLeft,
    camera.orthoRight,
    camera.orthoBottom,
    camera.orthoTop,
  ]);
  let fogRevision =
    authored === undefined
      ? 0
      : volumeRevision([
          ...authored.bounds.min,
          ...authored.bounds.max,
          ...authored.extinction,
          ...authored.albedo,
          ...authored.emission,
          authored.anisotropy,
          authored.maxDistance,
          authored.sampling === 'density-albedo' ? 2 : authored.sampling === 'density' ? 1 : 0,
          ...Array.from(`${fog.guid}:${fog.digest}`, (char) => char.charCodeAt(0)),
        ]);
  const selectedSpot =
    fog.spotLightEntity === undefined
      ? fog.lightKind === 'spot'
        ? lights.spot.find((spot) => spot.entity === fog.lightEntity)
        : undefined
      : lights.spot.find((spot) => spot.entity === fog.spotLightEntity);
  const selectedPoint =
    fog.pointLightEntity === undefined
      ? fog.lightKind === 'point'
        ? lights.point.find((point) => point.entity === fog.lightEntity)
        : undefined
      : lights.point.find((point) => point.entity === fog.pointLightEntity);
  const selectedDirectional =
    fog.lightKind === 'directional' && directional?.entity === fog.lightEntity
      ? directional
      : undefined;
  let lightRevision =
    selectedSpot === undefined && selectedPoint === undefined && selectedDirectional === undefined
      ? 0
      : volumeRevision(
          selectedSpot === undefined && selectedPoint === undefined
            ? selectedDirectional === undefined
              ? []
              : [
                  ...selectedDirectional.direction,
                  ...selectedDirectional.color,
                  selectedDirectional.intensity,
                  ...(lights.lightViewProj?.flatMap((matrix) => [...matrix]) ?? []),
                ]
            : [
                ...(selectedPoint === undefined
                  ? []
                  : [
                      ...selectedPoint.position,
                      ...selectedPoint.color,
                      selectedPoint.intensity,
                      selectedPoint.invRangeSquared,
                      selectedPoint.decay ?? 2,
                      selectedPoint.shadowAtlasLayer ?? -1,
                      selectedPoint.shadowNear ?? 0,
                      selectedPoint.shadowFar ?? 0,
                    ]),
                ...(selectedSpot === undefined
                  ? []
                  : [
                      ...selectedSpot.position,
                      ...selectedSpot.direction,
                      ...selectedSpot.color,
                      selectedSpot.intensity,
                      selectedSpot.invRangeSquared,
                      selectedSpot.cosInner,
                      selectedSpot.cosOuter,
                      selectedSpot.depthBias ?? 0.005,
                      selectedSpot.normalBias ?? 0.05,
                      selectedSpot.pcfKernelSize ?? 3,
                      selectedSpot.shadowAtlasTile,
                      Number(selectedSpot.projectorHandle ?? 0),
                      selectedSpot.projectorGeneration ?? 0,
                      selectedSpot.projectorRevision ?? 0,
                      ...(selectedSpot.lightViewProj === undefined
                        ? []
                        : [...selectedSpot.lightViewProj]),
                    ]),
              ],
        );
  for (const [index, member] of (fog.additional ?? []).entries()) {
    const signature = volumeTemporalSignature(
      member,
      {
        ...prepared,
        densityGeneration: prepared.additional?.[index]?.densityGeneration ?? 0,
      },
      camera,
      lights,
      width,
      height,
    );
    fogRevision = volumeRevision([fogRevision, signature.fogRevision, signature.densityGeneration]);
    lightRevision = volumeRevision([lightRevision, signature.lightRevision]);
  }
  return {
    cameraRevision,
    fogRevision,
    lightRevision,
    densityGeneration: prepared.densityGeneration,
    width,
    height,
    ...(fog.worldTimeSeconds === undefined ? {} : { worldTimeSeconds: fog.worldTimeSeconds }),
    ...(fog.lightKind === undefined ? {} : { lightKind: fog.lightKind }),
    ...(fog.lightEntity === undefined ? {} : { lightEntity: fog.lightEntity }),
    ...(fog.pointLightEntity === undefined ? {} : { pointLightEntity: fog.pointLightEntity }),
    ...(fog.spotLightEntity === undefined ? {} : { spotLightEntity: fog.spotLightEntity }),
    ...(fog.projector === undefined ? {} : { projector: fog.projector }),
    lightShadowRevision: lightRevision,
  };
}

function resolveVolumetricFogHistoryContext(
  frameState: RenderFrameState,
  graph: import('@forgeax/engine-render-graph').CompiledRenderGraph<
    import('../render-pipeline').RenderPipelineFrame
  >,
  fog: ExtractedVolumetricFog,
  prepared: VolumetricFogFrameContext,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
): { readonly context: VolumetricFogFrameContext; readonly signature: VolumeTemporalSignature } {
  const signature = volumeTemporalSignature(fog, prepared, camera, lights, width, height);
  const acceptedGraph = frameState.volumetricFogHistoryGraph;
  const acceptedSlot = frameState.volumetricFogHistorySlot;
  const previousSignature = frameState.volumetricFogHistorySignature;
  let reset = acceptedGraph !== graph || acceptedSlot === null || previousSignature === null;
  if (!reset && previousSignature !== null) {
    const temporal = frameState.temporalFrame;
    const previousResetReason = temporal?.resetReason;
    const reprojection =
      previousResetReason === 'out-of-screen'
        ? 'out-of-screen'
        : previousResetReason === 'depth-discontinuity'
          ? 'depth-discontinuity'
          : undefined;
    reset = resolveVolumeTemporalReset(previousSignature, signature, {
      taaEnabled: camera.antialias === 'taa',
      ...(reprojection === undefined ? {} : { reprojection }),
    }).reset;
  }
  const historyReadSlot = reset ? null : acceptedSlot;
  const historyWriteSlot = reset || acceptedSlot === null ? 0 : acceptedSlot === 0 ? 1 : 0;
  return {
    context: {
      ...prepared,
      historyReadSlot,
      historyWriteSlot,
      historyValid: historyReadSlot !== null,
    },
    signature,
  };
}

/**
 * Resolve the SpotLight-owned cookie independently of volumetric fog. Surface
 * lighting must keep the authored projector when the fog component is absent;
 * otherwise the view bind group silently falls back to white and changes the
 * direct-light energy on the floor. A fog-selected projector is preferred so
 * the surface and volume lanes consume one identity, with the first authored
 * projector as the deterministic scene fallback.
 */
function prepareSpotLightProjectorFrame(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  lights: ExtractedLights,
  fog: ExtractedVolumetricFog | undefined,
): SpotLightProjectorFrameContext | undefined {
  const preferred =
    fog?.projectorHandle === undefined
      ? undefined
      : lights.spot.find((light) => light.projectorHandle === fog.projectorHandle);
  const source =
    preferred ??
    lights.spot.find(
      (light) =>
        light.projectorHandle !== undefined &&
        light.projectorAsset !== undefined &&
        light.lightViewProj !== undefined,
    );
  if (
    source === undefined ||
    source.projectorHandle === undefined ||
    source.projectorAsset === undefined
  ) {
    return undefined;
  }
  const ownerWorld = worlds[fog?.worldId ?? 0] ?? world;
  const resident = internals.gpuStore.ensureResident(
    source.projectorHandle,
    source.projectorAsset,
    ownerWorld,
  );
  if (!resident.ok || !('texture' in resident.value)) {
    if (!resident.ok) {
      internals.errorRegistry.fire(
        resident.error instanceof RhiError
          ? resident.error
          : new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'SpotLight projector residency to resolve a GPU texture',
              hint: 'repair the authored projector TextureAsset payload and retry the next frame',
              detail: { error: resident.error },
            }),
      );
    }
    return undefined;
  }
  const sampler = internals.device.createSampler({
    label: 'spot-projector-linear-clamp',
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!sampler.ok) {
    internals.errorRegistry.fire(sampler.error);
    return undefined;
  }
  return {
    texture: resident.value.texture.handle,
    view: resident.value.view,
    sampler: sampler.value,
    spotIndex: lights.spot.indexOf(source),
    lightSlotIndex: lights.point.length + lights.spot.indexOf(source),
  };
}

/** Stage the accepted parameter payload into the writable slot for a degraded
 * source frame. This keeps the accepted GPU buffer immutable until submit
 * succeeds while still allowing the LKG graph to update its history flag. */
function stageAcceptedVolumetricFogFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  accepted: VolumetricFogFrameContext | undefined,
): VolumetricFogFrameContext | undefined {
  if (accepted === undefined) return undefined;
  const params = frameState.volumetricFogParams.accepted?.params;
  if (params === undefined) return accepted;
  const paramsBuffer = stageVolumetricFogParams(internals, frameState, params);
  if (paramsBuffer === undefined) return accepted;
  return { ...accepted, paramsBuffer };
}

interface FrameClockSample {
  readonly deltaSeconds: number;
  readonly elapsedSeconds: number | undefined;
  /** Explicit host/replay clock was present but invalid. */
  readonly invalidSampleTime: boolean;
}

/** Read the render sample clock from the camera's composition world once per frame. */
function frameClockSample(
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
  sampleTimeSeconds?: number,
): FrameClockSample {
  const owner = worlds[camera.worldId ?? 0] ?? world;
  const invalidSampleTime = sampleTimeSeconds !== undefined && !Number.isFinite(sampleTimeSeconds);
  try {
    const clock = renderTime(owner);
    return {
      deltaSeconds: Number.isFinite(clock.delta) ? Math.max(0, clock.delta) : 0,
      // Keep the raw host sample even when ECS accepted only a clamped
      // simulation delta. Temporal admission compares this value with the
      // last successfully submitted sample and therefore sees real hitches.
      elapsedSeconds:
        sampleTimeSeconds === undefined
          ? Number.isFinite(clock.elapsed)
            ? clock.elapsed
            : undefined
          : Number.isFinite(sampleTimeSeconds)
            ? sampleTimeSeconds
            : undefined,
      invalidSampleTime,
    };
  } catch {
    // Test and recovery callers may provide a minimal RenderResourceScope-shaped owner. An
    // absent clock is an invalid temporal pair and therefore safely resets.
    return {
      deltaSeconds: 0,
      elapsedSeconds: Number.isFinite(sampleTimeSeconds) ? sampleTimeSeconds : undefined,
      invalidSampleTime,
    };
  }
}

function stageSsrHistoryCandidate(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  width: number,
  height: number,
  admission: SsrSpatialAdmission,
  temporalView: TemporalView,
): boolean {
  const previousAdmission = frameState.ssrSpatialAdmission;
  frameState.ssrSpatialAdmission = admission;
  if (admission.status !== 'admitted') {
    if (frameState.ssrHistoryOwner !== undefined && previousAdmission?.status === 'admitted') {
      const owner = frameState.ssrHistoryOwner;
      owner.reset('disable');
      owner.retireAfterFence(internals.device.queue, (cause) => {
        reportSsrHistoryFailure(internals, 'submit', cause);
      });
      frameState.ssrHistoryOwner = undefined;
    }
    frameState.ssrLastCameraEntity = camera.entityKey;
    frameState.ssrLastHistoryVersion = camera.historyVersion;
    return true;
  }

  let owner = frameState.ssrHistoryOwner;
  if (owner === undefined) {
    const created = createSsrHistoryOwner({
      device: internals.device,
      scope: internals.deviceScope,
      width,
      height,
    });
    if (!created.ok) {
      reportSsrHistoryFailure(internals, 'build', created.error);
      return false;
    }
    owner = created.value;
    frameState.ssrHistoryOwner = owner;
  } else if (owner.resources.width !== width || owner.resources.height !== height) {
    const resized = owner.resize(width, height);
    if (!resized.ok) {
      reportSsrHistoryFailure(internals, 'build', resized.error);
      return false;
    }
    owner.retireAfterFence(internals.device.queue, (cause) => {
      reportSsrHistoryFailure(internals, 'submit', cause);
    });
  }

  let resetReason: import('../ssr/history').SsrHistoryResetReason | undefined;
  if (
    frameState.ssrLastCameraEntity !== undefined &&
    frameState.ssrLastCameraEntity !== camera.entityKey
  ) {
    resetReason = 'camera-cut';
  } else if (
    frameState.ssrLastHistoryVersion !== undefined &&
    frameState.ssrLastHistoryVersion !== camera.historyVersion
  ) {
    resetReason = 'history-version';
  } else {
    resetReason = mapSsrHistoryResetReason(temporalView.resetReason);
  }
  if (resetReason !== undefined) owner.reset(resetReason);

  const started = owner.beginFrame();
  if (!started.ok) {
    reportSsrHistoryFailure(internals, 'build', started.error);
    return false;
  }
  const candidate = started.value;
  const payload =
    frameState.ssrTemporalParamsPayload?.byteLength === 32
      ? frameState.ssrTemporalParamsPayload
      : new Uint8Array(32);
  payload.fill(0);
  const values = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  values.setUint32(0, candidate.historyValid ? 1 : 0, true);
  values.setFloat32(4, 0.9, true);
  values.setFloat32(8, admission.config.thickness, true);
  values.setFloat32(12, 0.5, true);
  // Reuse the shared successful-submit snapshot; SSR owns no jitter sequence
  // or independently advancing previous-camera state.
  const previousJitter = frameState.lastSuccessfulTemporalView?.currentJitterUv;
  values.setFloat32(16, temporalView.currentJitterUv?.[0] ?? 0, true);
  values.setFloat32(20, temporalView.currentJitterUv?.[1] ?? 0, true);
  values.setFloat32(24, previousJitter?.[0] ?? 0, true);
  values.setFloat32(28, previousJitter?.[1] ?? 0, true);
  const written = internals.device.queue.writeBuffer(owner.resources.paramsBuffer, 0, payload);
  if (!written.ok) {
    owner.abortFrame(candidate, 'encode');
    reportSsrHistoryFailure(internals, 'encode', written.error);
    return false;
  }
  frameState.ssrTemporalParamsPayload = payload;
  frameState.ssrLastCameraEntity = camera.entityKey;
  frameState.ssrLastHistoryVersion = camera.historyVersion;
  return true;
}

function updateVolumetricFogInspection(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog | undefined,
  lights: ExtractedLights,
  prepared: VolumetricFogFrameContext | undefined,
  submitted: boolean,
  volumeCapability: boolean,
  volumeSubmissionAttempted: boolean,
): void {
  const resourceFacts =
    frameState.compiledFrameGraph === undefined || frameState.compiledFrameGraph === null
      ? undefined
      : inspectVolumetricFogResources(frameState.compiledFrameGraph.graph.inspect(), {
          parameterBufferCount: frameState.volumetricFogParams.buffers.filter(
            (buffer) => buffer !== null,
          ).length,
        });
  const graphSampleCount = resourceFacts?.sampleCount ?? 0;
  const graphMemoryBytes = resourceFacts?.totalBytes ?? 0;
  const previous = frameState.volumetricFogInspection;
  const accepted = frameState.volumetricFogAccepted;
  const acceptedLkg =
    accepted === undefined
      ? undefined
      : {
          guid: accepted.guid ?? previous.guid,
          generation: accepted.generation ?? previous.generation,
          digest: accepted.digest ?? previous.digest,
          deviceEpoch: previous.deviceEpoch,
          format: previous.format ?? accepted.densityAsset?.format ?? fog?.densityAsset?.format,
          passCount: previous.passCount > 0 ? previous.passCount : VOLUMETRIC_FOG_PASS_COUNT,
          sampleCount: previous.sampleCount > 0 ? previous.sampleCount : graphSampleCount,
          memoryBytes: previous.memoryBytes > 0 ? previous.memoryBytes : graphMemoryBytes,
          resourceFacts: previous.resourceFacts ?? resourceFacts,
          lightEntity: accepted.lightEntity,
          lightKind: accepted.lightKind,
          pointLightEntity: accepted.pointLightEntity,
          spotLightEntity: accepted.spotLightEntity,
          projector: accepted.projector,
        };

  const candidateIdentity =
    fog?.guid === undefined || fog.generation === undefined
      ? undefined
      : {
          guid: fog.guid,
          generation: fog.generation,
          digest: fog.digest,
        };
  const selectedLightAvailable =
    fog?.lightKind === 'spot'
      ? lights.spot.some((light) => light.entity === fog.lightEntity)
      : fog?.lightKind === 'point'
        ? lights.point.some(
            (light) => light.entity === (fog.pointLightEntity ?? fog.lightEntity),
          ) &&
          (fog.spotLightEntity === undefined ||
            lights.spot.some((light) => light.entity === fog.spotLightEntity))
        : fog?.lightKind === 'directional'
          ? lights.directional?.entity === fog.lightEntity
          : lights.directional !== undefined;
  const capability = volumeCapability && selectedLightAvailable ? 'available' : 'unavailable';

  const inspectAccepted = (status: 'accepted' | 'degraded', candidateFailure?: 'submit-failed') => {
    if (
      acceptedLkg === undefined ||
      acceptedLkg.guid === undefined ||
      acceptedLkg.generation === undefined
    ) {
      return false;
    }
    const recovery = {
      guid: acceptedLkg.guid,
      generation: acceptedLkg.generation,
      deviceEpoch: acceptedLkg.deviceEpoch,
      status,
      ...(status === 'degraded' ? { lkgGeneration: acceptedLkg.generation } : {}),
      ...(candidateIdentity === undefined
        ? {}
        : {
            candidateGeneration: candidateIdentity.generation,
            ...(candidateIdentity.digest === undefined
              ? {}
              : { candidateDigest: candidateIdentity.digest }),
          }),
      ...(acceptedLkg.lightEntity === undefined || acceptedLkg.lightKind === undefined
        ? {}
        : {
            selectedLight: {
              entity: acceptedLkg.lightEntity,
              kind: acceptedLkg.lightKind,
              revision: 0,
              shadowTile: -1,
              ...(acceptedLkg.pointLightEntity === undefined
                ? {}
                : { pointLightEntity: acceptedLkg.pointLightEntity }),
              ...(acceptedLkg.spotLightEntity === undefined
                ? {}
                : { spotLightEntity: acceptedLkg.spotLightEntity }),
              ...(acceptedLkg.projector === undefined ? {} : { projector: acceptedLkg.projector }),
            },
          }),
      ...(candidateFailure === undefined ? {} : { candidateFailure }),
    } satisfies import('../volume/recovery').VolumeRecoveryState;
    frameState.volumetricFogInspection = inspectVolumetricFog({
      authored: true,
      capability: 'available',
      degraded: status === 'degraded',
      recovery,
      ...(acceptedLkg.digest === undefined ? {} : { acceptedDigest: acceptedLkg.digest }),
      ...(acceptedLkg.format === undefined ? {} : { format: acceptedLkg.format }),
      passCount: acceptedLkg.passCount,
      sampleCount: acceptedLkg.sampleCount,
      memoryBytes: acceptedLkg.memoryBytes,
      ...(acceptedLkg.resourceFacts === undefined
        ? {}
        : { resourceFacts: acceptedLkg.resourceFacts }),
    });
    return true;
  };

  if (fog === undefined || fog.status === 'off') {
    // A failed fog-off candidate must not erase the inspection/LKG that is
    // still being rendered. The accepted projection is retired only after a
    // successful no-volume submission below.
    if (!submitted && volumeSubmissionAttempted && inspectAccepted('degraded', 'submit-failed')) {
      return;
    }
    if (!submitted && volumeSubmissionAttempted) return;
    if (!submitted) return;
    frameState.volumetricFogInspection = inspectVolumetricFog({
      authored: false,
      capability: 'available',
    });
    return;
  }

  const authored = fog.status === 'available' || fog.status === 'degraded';

  // A successfully submitted available candidate is the only path that may
  // become the new accepted projection. This call runs after graph settlement
  // so the inspection and the graph/context observe the same transaction.
  if (
    submitted &&
    fog.status === 'available' &&
    prepared !== undefined &&
    capability === 'available'
  ) {
    const recovery =
      candidateIdentity === undefined
        ? undefined
        : {
            guid: candidateIdentity.guid,
            generation: candidateIdentity.generation,
            deviceEpoch: previous.deviceEpoch,
            status: 'accepted' as const,
            ...(fog.lightEntity === undefined || fog.lightKind === undefined
              ? {}
              : {
                  selectedLight: {
                    entity: fog.lightEntity,
                    kind: fog.lightKind,
                    revision: 0,
                    shadowTile:
                      lights.spot.find((spot) => spot.entity === fog.spotLightEntity)
                        ?.shadowAtlasTile ??
                      lights.spot.find((spot) => spot.entity === fog.lightEntity)
                        ?.shadowAtlasTile ??
                      -1,
                    ...(fog.pointLightEntity === undefined
                      ? {}
                      : { pointLightEntity: fog.pointLightEntity }),
                    ...(fog.spotLightEntity === undefined
                      ? {}
                      : { spotLightEntity: fog.spotLightEntity }),
                    ...(fog.projector === undefined ? {} : { projector: fog.projector }),
                  },
                }),
          };
    frameState.volumetricFogInspection = inspectVolumetricFog({
      authored: true,
      capability,
      ...(recovery === undefined ? {} : { recovery }),
      ...(candidateIdentity?.digest === undefined
        ? {}
        : { acceptedDigest: candidateIdentity.digest }),
      ...(fog.densityAsset?.format === undefined ? {} : { format: fog.densityAsset.format }),
      passCount: VOLUMETRIC_FOG_PASS_COUNT,
      sampleCount: graphSampleCount,
      memoryBytes: graphMemoryBytes,
      ...(resourceFacts === undefined ? {} : { resourceFacts }),
    });
    return;
  }

  // A submitted degraded source (or an available source whose residency
  // preparation failed) is rendered through the previously accepted graph.
  // Keep that LKG resource fact visible instead of projecting a zero-resource
  // candidate merely because the current source could not be prepared.
  if (
    submitted &&
    acceptedLkg !== undefined &&
    (fog.status === 'degraded' || prepared === undefined)
  ) {
    if (inspectAccepted('degraded')) return;
  }

  // Any candidate that reached encode/submit but failed must project the LKG,
  // never the unsubmitted candidate. The candidate identity remains visible so
  // recovery tooling can distinguish the rejected bytes from the frame being
  // rendered.
  if (!submitted && volumeSubmissionAttempted && inspectAccepted('degraded', 'submit-failed')) {
    return;
  }

  // A degraded source that has no LKG is still a diagnostic, but it must not
  // claim accepted resources. Keep its identity in the candidate stage.
  const candidateRecovery =
    candidateIdentity === undefined
      ? undefined
      : {
          guid: candidateIdentity.guid,
          generation: candidateIdentity.generation,
          deviceEpoch: previous.deviceEpoch,
          status: 'candidate' as const,
          candidateGeneration: candidateIdentity.generation,
          ...(candidateIdentity.digest === undefined
            ? {}
            : { candidateDigest: candidateIdentity.digest }),
          ...(!submitted && volumeSubmissionAttempted
            ? { candidateFailure: 'submit-failed' as const }
            : {}),
        };
  frameState.volumetricFogInspection = inspectVolumetricFog({
    authored,
    capability,
    degraded: fog.status === 'degraded' || capability === 'unavailable',
    ...(candidateRecovery === undefined ? {} : { recovery: candidateRecovery }),
    ...(acceptedLkg?.digest === undefined ? {} : { acceptedDigest: acceptedLkg.digest }),
    ...(fog.densityAsset?.format === undefined
      ? acceptedLkg?.format === undefined
        ? {}
        : { format: acceptedLkg.format }
      : { format: fog.densityAsset.format }),
    passCount: 0,
    sampleCount: 0,
    memoryBytes: 0,
  });
}

export function recordFrame(...args: Parameters<typeof prepareFrameRecording>): boolean {
  return submitFrameRecordings([prepareFrameRecording(...args)]);
}

export function* prepareFrameRecording(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  cameras: CameraSnapshot[],
  lights: ExtractedLights,
  renderables: FrameList<RenderableSnapshot>,
  transparentDispatch: DispatchList,
  frameState: RenderFrameState,
  dispatchCounts: DispatchCounts,
  bindGroupCounts: BindGroupCounts,
  skylight: SkylightSnapshot | undefined,
  skylightCount: number,
  skybox: SkyboxSnapshot | undefined,
  skyboxCount: number,
  postProcessParams: ReadonlyMap<string, Uint8Array>,
  // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): the
  // full worlds[] list passed to `renderer.draw`, indexed by
  // RenderableSnapshot.worldId so the record stage resolves each renderable's
  // mesh + material textures against the world it was extracted from (mirroring
  // the per-world extract stage). Optional + defaulting to `[world]` keeps the
  // pre-split single-world identity path (worldId always 0) byte-for-byte and
  // the existing unit-test callers (which pass a single mock world) valid.
  worlds: readonly RenderResourceScope[] = [world],
  profilePhase?: RecordProfileRunner,
  gpuDriven?: {
    readonly owner: GpuDrivenProduction;
    readonly scene: PersistentGpuDrivenState | undefined;
    /** Physical queue acceptance, before publication/finalization observers. */
    readonly onSubmittedWork?: (completed: Promise<void>) => void;
    readonly onRasterLane: (owned: GpuRasterOwnership | undefined) => void;
    readonly activeEntityKeys?: ReadonlySet<number>;
    readonly activeEntityRevision?: number;
    /** Extraction culling count; GPU-owned candidates can stay in residency rows. */
    readonly visibleRasterRows: number;
    readonly cameraVisible?: (source: RenderableSnapshot) => boolean;
    readonly telemetryCandidateCount?: number;
    readonly telemetrySubmit?: GpuDrivenLodSubmitIdentity;
    readonly frameTime?: number;
    readonly deviceGeneration?: number;
    readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
    readonly geometryLane?: 'automatic' | 'direct';
  },
  renderReadLeases?: readonly RenderReadLease[],
  featureGraphCandidate?: RenderFeatureGraphCandidate,
  pointsLinesOwner?: import('./render-context').PointsLinesRecordOwner,
  cubeCapture?: CubeCaptureFrameInput,
  environmentSignature = '',
  fogSignature = '',
  environmentReady = true,
  transmissionDemand?: TransmissionDemand,
  volumetricFog?: ExtractedVolumetricFog,
  timingCapture?: GpuTimingCapture,
  shadowCasterProjection?: PersistentShadowCasterProjection,
  shadowCasterWorldKeys?: readonly number[],
  preparedLighting?: ReturnType<typeof prepareFrameLighting>,
  ssrDependencies?: SsrDependenciesInspection,
  onRenderableDraw?: (
    entry: Pick<ValidatedRenderable, 'source'>,
    submeshIndex?: number,
    receipt?: RenderableDrawReceipt,
  ) => void,
  analyticFog?: FogFrame,
  sampleTimeSeconds?: number,
  temporalReset = false,
  cloudLayer?: ExtractedCloudLayer,
  sharedEncoder?: RhiCommandEncoder,
  // Only Renderer passes the scalar from its private merged light record.
  // Raw/direct callers retain full capacity and their original getter reads.
  directionalShadowCascadeCount?: number,
  // Renderer extraction/receipt admission owns detached matrix inputs. Direct
  // helper calls retain their complete legacy observation and recording path.
  rendererRecording = false,
): FrameRecording {
  frameState.reflectionFallbackObservationSource = undefined;
  frameState.reflectionFallbackCompletion = undefined;
  // The `try / finally` wrapper advances `frameState.frameNumber` exactly
  // once per `recordFrame` invocation regardless of which early-return
  // branch is taken (camera missing, cap exceeded, pipeline pending,
  // swap-chain unavailable, etc).
  // The boolean result reports whether the shared frame encoder reached queue
  // submission; prepared graphics uses it to distinguish in-flight from
  // unsubmitted buffer leases.
  // No Camera is a valid scene state. The internal snapshot supplies only
  // stable clear/UI frame parameters; it never becomes an authored view.
  const activeCameras = cameras.length === 0 ? [makeZeroCameraFallbackSnapshot()] : cameras;
  if (cameras.length === 0) {
    renderables = [];
    transparentDispatch = [];
    gpuDriven = undefined;
  }
  const captureOnly = cubeCapture?.captureOnly === true;
  let preparedGpuDriven: PreparedGpuDrivenFrame | undefined;
  let submitted = false;
  let shadowMeshLease: ShadowMeshInput | undefined;
  const captureFrames: Array<
    ReturnType<
      typeof prepareTargetCaptureLighting<import('./target-capture-graph').CubeCaptureGraphWork>
    > & {
      viewport: { readonly width: number; readonly height: number };
      graph: import('@forgeax/engine-render-graph').CompiledRenderGraph<
        import('../render-pipeline').RenderPipelineFrame
      >;
    }
  > = [];
  const probeCaptureFrames: Array<
    ReturnType<typeof prepareTargetCaptureLighting> & {
      viewport: { readonly width: number; readonly height: number };
      graph: import('@forgeax/engine-render-graph').CompiledRenderGraph<
        import('../render-pipeline').RenderPipelineFrame
      >;
    }
  > = [];
  let completion: Promise<unknown> | undefined;
  let fallbackReadback:
    | Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>
    | undefined;
  let captureCompletion: Promise<unknown> | undefined;
  let resolutionTiming: GpuTimingCapture | undefined;
  let volumeInspectionReady = false;
  let volumeSubmissionAttempted = false;
  let preparedVolumetricFogForInspection: VolumetricFogFrameContext | undefined;
  let volumeCapabilityForInspection = false;
  let viewVolumetricFogForInspection = volumetricFog;
  try {
    // Case D: N>1 Camera => fire onError, use first hit (D-S7).
    if (activeCameras.length > 1) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'render-system-multi-camera',
          expected: 'world has exactly one entity with Transform + Camera',
          hint: 'attach CameraView to cameras for ordered simultaneous output; each record invocation accepts one camera',
        }),
      );
    }
    const requestedCamera = activeCameras[0];
    if (!requestedCamera) return false;
    const frameDepthOfField = resolveDepthOfFieldFrameParams(
      requestedCamera.depthOfField,
      requestedCamera.depthOfFieldError,
      frameState.depthOfFieldAccepted?.params,
    );
    const camera: CameraSnapshot =
      frameDepthOfField === undefined || frameDepthOfField === requestedCamera.depthOfField
        ? requestedCamera
        : { ...requestedCamera, depthOfField: frameDepthOfField };
    if (
      internals.standardProfile?.probePlacement !== undefined &&
      (captureOnly ||
        cameras.length !== 1 ||
        camera.projection !== 'perspective' ||
        (cubeCapture?.scheduledWork.length ?? 0) > 0 ||
        (cubeCapture?.auxiliaryCameras.length ?? 0) > 0 ||
        (cubeCapture?.sceneInputs?.length ?? 0) > 0 ||
        (cubeCapture?.reflectionProbes?.graph.work.length ?? 0) > 0 ||
        (internals.featureSceneInputs?.work.length ?? 0) > 0 ||
        camera.planarReflection !== undefined)
    ) {
      frameState.probePlacement?.disable();
      throw new RhiError({
        code: 'rhi-not-available',
        expected:
          'one perspective display view without auxiliary, Cube, reflection or scene-input capture views for probe placement',
        hint: 'disable placement or remove the additional views before recording',
      });
    }
    frameState.ssrRequested = camera.screenSpaceReflection !== undefined;
    const pipelineState = internals.getPipelineState();
    if (pipelineState === null) return false;
    if (
      frameState.environmentFrame?.source.kind === 'atmosphere' &&
      (pipelineState.atmosphereAvailable !== true ||
        !internals.device.caps.compute ||
        !internals.device.caps.storageTexture ||
        !internals.device.caps.rgba16floatRenderable ||
        (internals.device.limits.maxTextureDimension3D ?? 0) < 32)
    ) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: `Atmosphere admission: bindings=${pipelineState.atmosphereAvailable}, compute=${internals.device.caps.compute}, storage=${internals.device.caps.storageTexture}, float=${internals.device.caps.rgba16floatRenderable}, dimension3D=${internals.device.limits.maxTextureDimension3D}, sampled=${internals.device.limits.maxSampledTexturesPerShaderStage}`,
        hint: 'select a device meeting the atmosphere capabilities or remove Atmosphere',
        detail: {
          error: {
            code: 'atmosphere-capability-unavailable',
            message: 'Atmosphere device admission failed',
            detail: {
              atmosphereAvailable: pipelineState.atmosphereAvailable,
              caps: internals.device.caps,
              limits: internals.device.limits,
            },
          },
        },
      });
    }
    if (pipelineState.device !== internals.device) {
      internals.errorRegistry.fire(
        new RendererOperationError('device-operation-failed', {
          operation: 'draw',
          cause: {
            code: 'pipeline-device-mismatch',
            expected: 'pipelineState.device === runtime.device',
            hint: 'discard stale pipeline state before recording the next frame',
            detail: {
              expected: 'pipelineState.device === runtime.device',
              hint: 'discard stale pipeline state before recording the next frame',
            },
          },
        }),
      );
      return false;
    }
    resetFrameRecordingOutputs(frameState.frameOutputs);
    if (frameState.reflectionFallbackReadback !== undefined) {
      internals.device.destroyBuffer(frameState.reflectionFallbackReadback.buffer);
      frameState.reflectionFallbackReadback = undefined;
    }

    const lightingPreparation = runRecordProfilePhase(profilePhase, 'record/scene-state', () => {
      const foldBuckets = runRecordProfilePhase(
        profilePhase,
        'record/scene-state/fold-buckets',
        () =>
          gpuDriven?.scene !== undefined && shadowCasterProjection !== undefined
            ? []
            : computeFoldBuckets(
                world,
                frameState,
                transparentDispatch,
                renderables.map((source) => ({
                  transform: source.transform,
                  material: source.material.snapshot,
                })),
              ),
      );

      // Multi-light warnings + point/spot shadow-snapshot pin + point-shadow atlas
      // ensure + ExtractedLights three-arm destructure (directional fallback,
      // point/spot/Rect arrays, totalLightCount). Extracted to prepareFrameLighting
      // (M3/w18) so recordFrame stays a skeleton.
      const lighting = runRecordProfilePhase(
        profilePhase,
        'record/scene-state/lighting-prep',
        () =>
          preparedLighting ??
          prepareFrameLighting(internals, frameState, lights, camera, pipelineState),
      );
      if (!lighting.ok) return lighting;
      const { light, totalLightCount, standard } = lighting.value;

      runRecordProfilePhase(profilePhase, 'record/scene-state/ambient-resolution', () => {
        // feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10 + F-4 nit):
        // 0-light three-condition conjunction (plan-strategy D-5):
        //   no Skylight (skylight === undefined)
        //   AND 0 direct light (totalLightCount === 0)
        //   AND StandardMaterial (renderables.some materialShaderId !== 'forgeax::default-unlit')
        // All three true -> black + warn. A single false -> no warn.
        //
        // Multi-Skylight warn (F-4 nit + feat-20260630 M3 / w19): >1 Skylight
        // entity -> warn ONCE per RenderSystem lifetime (not per frame), naming the
        // winning entity handle so the scene author can tell which Skylight is used
        // (F-8: warn carries conflicting entity info). First Skylight (by archetype
        // order) wins.
        warnMultiSkylight(frameState, skylightCount, skylight?.entityHandle ?? 0);

        // Multi-SkyboxBackground warn (feat-20260630 M3 / w19): mirror the Skylight
        // once-warn + winning-entity-handle pattern. First SkyboxBackground (by
        // archetype order) wins.
        warnMultiSkybox(frameState, skyboxCount, skybox?.entityHandle ?? 0);

        // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
        // lazy equirect-to-cubemap projection trigger (the single per-frame driver;
        // plan-strategy D-4 + sequence diagram). The Skylight (or, when present
        // without one, the SkyboxBackground) supplies the equirect handle; both
        // reuse the same handle so a single projection serves IBL ambient + skybox.
        //   - handle 0          -> no equirect (solid-color ambient); skip
        //   - caps.rgba16float
        //     Renderable false  -> permanent white fallback; never project (AC-06,
        //                          the only IBL gate; no UA guard)
        //   - status undefined  -> first sight: resolve POD + fire-and-forget launch
        //                          (does NOT await; the store writes status:'pending'
        //                          synchronously so this launches exactly once)
        //   - status pending    -> projection in flight; white fallback this frame
        //                          (normal transition, not an error -- no fire)
        //   - status ready      -> real IBL bound by the encodeMainPass cache check
        //   - status failed     -> fire EquirectProjectionFailedError ONCE per
        //                          handle (R-2/AC-09: store records failed
        //                          permanently and never retries; the latch keeps
        //                          the channel from flooding)
        for (const lazyEquirectHandle of selectLazyEquirectHandles(skylight, skybox)) {
          driveLazyEquirectProjection(internals, world, frameState, lazyEquirectHandle);
        }
      });

      // Zero-light standard-material once-warn (no Skylight + 0 direct light +
      // >=1 lit material -> black). Extracted to warnZeroLightStandard (M3/w18).
      warnZeroLightStandard(frameState, renderables, skylight, totalLightCount);

      return { ok: true as const, value: { foldBuckets, light, standard } };
    });
    if (!lightingPreparation.ok) {
      internals.errorRegistry.fire(lightingPreparation.error);
      return false;
    }
    const { foldBuckets, light, standard } = lightingPreparation.value;
    // Do not fill the GPU queue with fallback display frames while an authored
    // image is being prepared. Retain the picture and use the ordinary barrier;
    // no scene graph, history or draw receipt is promoted by this pending work.
    // Capture and nonempty Feature dependencies keep their complete recording path.
    const imagePending = [skylight?.equirectHandle, skybox?.equirectHandle].some(
      (handle) =>
        handle !== undefined &&
        handle !== 0 &&
        internals.gpuStore.getCubemapStatus(handle as AssetHandle<'equirect'>, world) === 'pending',
    );
    const deferImageDisplay =
      imagePending &&
      frameState.lastSuccessfulBarrelDistortion !== undefined &&
      frameState.lastSuccessfulBarrelDistortion.width === internals.canvas.width &&
      frameState.lastSuccessfulBarrelDistortion.height === internals.canvas.height &&
      !captureOnly &&
      cameras.length === 1 &&
      (camera.output === undefined ||
        (camera.output.exposure.kind === 'manual' && camera.output.colorLut === 0)) &&
      frameState.autoExposureState === undefined &&
      frameState.standardLutState.lastKnownGood === null &&
      camera.dynamicResolution === undefined &&
      (featureGraphCandidate?.plans.every(
        ({ plan }) => plan.resources.length === 0 && plan.passes.length === 0,
      ) ??
        true) &&
      (featureGraphCandidate?.fullscreenEffects.size ?? 0) === 0 &&
      (cubeCapture?.scheduledWork.length ?? 0) === 0 &&
      (cubeCapture?.auxiliaryCameras.length ?? 0) === 0 &&
      (cubeCapture?.sceneInputs?.length ?? 0) === 0 &&
      (cubeCapture?.reflectionProbes?.graph.work.length ?? 0) === 0 &&
      camera.planarReflection === undefined;
    if (deferImageDisplay) {
      submitted = yield* recordPreparationBarrier(internals, sharedEncoder);
      featureGraphCandidate?.onRejected?.();
      return submitted;
    }

    // Deferred lighting is the only lane that shades capsule shadows, so only
    // there may admitted characters leave the directional cascades.
    const capsuleShadowDirectional = standard.prepared.renderPath === 'deferred';

    // Case E (this commit): 0 renderables = legitimate scene (LO §1.1
    // hello-window minimum semantic). Mirrors the Case C softening for
    // 0 DirectionalLight (line 134 above; D-Q7). recordFrame() falls
    // through to encode + submit a clear-pass-only render pass so the
    // canvas is painted with `clearColor` even when no entity carries
    // MeshFilter + MeshRenderer. Geometry submission (mat4 uploads,
    // bind-group construction, vertex/index binding, drawIndexed) is
    // conditional on `validatedOrdered.length > 0` further down.

    // Point-shadow params UBO write (per-layer near/far/invSpan). Extracted to
    // writeShadowParamsBuffer (M3/w18).
    writeShadowParamsBuffer(internals, frameState, pipelineState);

    // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
    // the per-spot perspective `lightViewProj` matrices fold into the View UBO
    // tail (`view.spotLightViewProj`, floats 132..195 / bytes 528..784) and are
    // written as part of the per-frame viewPayload below — no standalone binding
    // 9 uniform buffer (it overflowed the WebGL2 fallback fragment uniform-buffer
    // budget). See the viewPayload construction (VIEW_PAYLOAD_FLOATS = 196).

    const effectiveShadowMapSize = resolveShadowMapSize(internals, lights);
    const directionalPreparationLimit =
      directionalShadowCascadeCount === undefined
        ? undefined
        : directionalShadowPreparationLimit(
            directionalShadowCascadeCount,
            frameState.compiledFrameGraph,
            frameState.compiledFrameGraphCandidate?.previous.installed,
          );
    const effectiveSpotShadowMapSize = resolveSpotShadowMapSize(internals, lights);
    const graphShadowMapSize = effectiveShadowMapSize ?? effectiveSpotShadowMapSize;
    let frameShadowPlanes: ReadonlyMap<string, Float32Array> | undefined;
    const shadowPlanesByView = (): ReadonlyMap<string, Float32Array> => {
      frameShadowPlanes ??= shadowViewPlanesByView(lights, directionalPreparationLimit);
      return frameShadowPlanes;
    };
    const hasShadowViews = hasShadowViewDemand(lights);
    const volumeCapability = hasVolumetricFogCapability(
      internals.device.caps,
      internals.volumetricFogShaders,
    );
    volumeInspectionReady = true;
    volumeCapabilityForInspection = volumeCapability;

    const viewVolumetricFog = volumeCapability
      ? volumetricFogForView(volumetricFog, camera, internals.canvas.width, internals.canvas.height)
      : volumetricFog;
    const volumeViewCulled =
      volumetricFog?.status === 'available' && viewVolumetricFog === undefined;
    viewVolumetricFogForInspection = viewVolumetricFog;

    const preparedSpotLightProjector = prepareSpotLightProjectorFrame(
      internals,
      world,
      worlds,
      lights,
      volumetricFog,
    );
    const cloudShadowProjection = cloudShadowProjectionFor(cloudLayer);

    const preparedVolumetricFog = prepareVolumetricFogFrame(
      internals,
      frameState,
      world,
      worlds,
      viewVolumetricFog,
      lights,
      volumeCapability,
      preparedSpotLightProjector,
    );
    preparedVolumetricFogForInspection = preparedVolumetricFog;
    // A degraded authored snapshot must keep consuming the last accepted GPU
    // projection.  The current source is still surfaced as a diagnostic, but
    // it must not replace the graph/context that produced the last good frame.
    // An absent component is different: a successful no-volume frame retires
    // the accepted projection and compiles the normal graph.
    const acceptedFallback =
      volumeCapability && viewVolumetricFog !== undefined && preparedVolumetricFog === undefined
        ? frameState.volumetricFogAccepted
        : undefined;
    const acceptedFallbackContext =
      acceptedFallback === undefined
        ? undefined
        : stageAcceptedVolumetricFogFrame(
            internals,
            frameState,
            frameState.volumetricFogAcceptedContext,
          );
    const graphVolumetricFog = volumeCapability
      ? preparedVolumetricFog === undefined
        ? acceptedFallback
        : viewVolumetricFog
      : undefined;
    const baseVolumetricFogContext = preparedVolumetricFog ?? acceptedFallbackContext;
    // A volume graph replacement is provisional whenever it can affect the
    // accepted volume projection. This includes authoring degradation (which
    // consumes the LKG graph), an authored replacement, and an explicit
    // fog-off transition. Non-volume frames retain the legacy immediate graph
    // retirement path.
    const volumeTopologyCandidate =
      (graphVolumetricFog?.status === 'available' && baseVolumetricFogContext !== undefined) ||
      (graphVolumetricFog === undefined && frameState.volumetricFogAccepted !== undefined) ||
      (volumetricFog?.status === 'degraded' && acceptedFallback !== undefined);

    let acceptedMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
    let acceptedShadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
    let materialBindingClasses: ReadonlyMap<string, string> | undefined;
    let directShadowValidated: readonly ValidatedRenderable[] | undefined;
    const abortPreparedGpuDriven = (): void => {
      preparedGpuDriven?._abortResourceReplacement?.();
    };
    const cubeCaptureWork = prepareCubeCapture(
      internals,
      cubeCapture,
      camera,
      frameState.frameNumber,
    );
    const reflectionFallbackCandidate =
      cubeCapture?.reflectionProbes?.fallbackDemand === true ||
      (ssrDependencies?.requested === true && ssrDependencies.reflectionFallback !== undefined);
    // The forward Standard PBR GPU raster owns one color target while the
    // reflection fallback adds an MRT attachment, so a forward frame keeps the
    // ordinary CPU producer. Deferred writes the fallback in its lighting pass,
    // never in a raster pass, so the G-buffer keeps the GPU-driven lane (and
    // the visible-surface table that ray-traced GI requires).
    const fallbackLaneLimit =
      reflectionFallbackCandidate && standard.prepared.renderPath !== 'deferred';
    frameState.surfaceSubmissionObservation?.setActualLaneReason(
      fallbackLaneLimit ? 'reflection-fallback-mrt' : undefined,
    );
    if (gpuDriven?.scene !== undefined)
      gpuDriven = { ...gpuDriven, scene: querySceneExecution(gpuDriven.scene) };
    const frameGpuDriven = fallbackLaneLimit ? undefined : gpuDriven;
    // Capture views have independent draw ownership; display-camera GPU work
    // remains active while their faces and SSR fallback attachments are recorded.
    // ProbeBlendRecord is a shared object-level fragment ABI. The prepared
    // GPU owner receives the renderer-owned record buffer below and binds it
    // at the same slot used by the direct material path, so probe-bearing rows
    // remain eligible for the GPU lane.

    // Settle LOD residency before validation captures handles and its cache epoch.
    // An upgrade retires old allocations; this frame must use the replacement.
    const gpuDrivenMeshes = gpuDrivenMeshesForFrame(internals, worlds, gpuDriven?.scene);
    const nativeScene = gpuDriven?.scene;
    const sourceRenderables = shadowCasterProjection?.renderables ?? renderables;
    let materialFrame = shadowCasterProjection?.content.materials;
    let manualSubsurface: SubsurfaceSelection | undefined;
    if (materialFrame === undefined) {
      manualSubsurface = new SubsurfaceSelection();
      // Hand-authored recorder inputs have no Scene owner; freeze their roots once.
      materialFrame = new MaterialFrame(undefined);
      for (const source of sourceRenderables) {
        for (const resource of source.materials.length === 0 ? [source.material] : source.materials)
          if (materialFrame.get(resource) === undefined)
            materialFrame = materialFrame.with(resource);
        manualSubsurface.add(source, materialFrame);
      }
    }
    const fixedMaterials = materialFrame;
    const materialPrograms = shadowCasterProjection?.materialPrograms;
    const prepareSources = (sources: FrameList<RenderableSnapshot>, dispatch: DispatchList = []) =>
      runRecordProfilePhase(profilePhase, 'record/validation', () =>
        validateRenderables(
          internals,
          world,
          worlds,
          pipelineState,
          frameState,
          sources,
          dispatch,
          EMPTY_ENTITY_KEYS,
          undefined,
          profilePhase,
          undefined,
          fixedMaterials,
          shadowCasterProjection?.content.meshes,
        ),
      );
    const prepareGeometry = (mesh: MeshGpuHandles, material: MaterialSnapshot) =>
      materialGeometry(mesh, material, () => internals.gpuStore.ensureNineSliceGeometry().unwrap());
    const lodRows = cpuLaneLodRows(internals.device.caps, camera);
    // Only the manual recorder path lacks native source bindings. Here these
    // rows are actual Direct draw inputs, not a GPU-side validation mirror.
    const manualDraws =
      nativeScene === undefined ? lodRows(prepareSources(renderables, transparentDispatch)) : [];
    const fixedShadowDomain =
      rendererRecording &&
      !captureOnly &&
      nativeScene?.retained?.isSourceCurrent() === true &&
      nativeScene.unbatchedSlots?.length === 0 &&
      shadowCasterProjection !== undefined &&
      (shadowCasterProjection.content.viewDraws?.length ?? 0) === 0 &&
      (lights.cascadeCount ?? 0) > 0 &&
      (effectiveShadowMapSize ?? 0) > 0;
    if (fixedShadowDomain && shadowCasterProjection !== undefined) {
      shadowMeshLease = shadowMeshReadsForQuery(
        frameState.directionalShadowCache,
        worlds,
        shadowCasterProjection,
        internals.gpuStore.meshChanges,
      );
    }
    const collectShadowMeshes =
      shadowMeshLease !== undefined &&
      shadowMeshLease.reads !== frameState.directionalShadowCache?.meshReads;
    let shadowGeometryFixed = fixedShadowDomain;
    const prepareShadowGeometry = (mesh: MeshGpuHandles, material: MaterialSnapshot) => {
      const effective = prepareGeometry(mesh, material);
      // CPU material-derived selection has no fixed source witness yet.
      if (effective !== mesh) shadowGeometryFixed = false;
      return effective;
    };
    if (fixedShadowDomain && selectGpuLodLane(internals.device.caps) === 'cpu') {
      frameState.directionalShadowLod ??= { values: [], token: {} };
    } else {
      frameState.directionalShadowLod = undefined;
    }
    const shadowLodSelection = frameState.directionalShadowLod;
    const shadowLodRows = cpuLaneLodRows(internals.device.caps, camera, shadowLodSelection);
    const gpuShadowMaterials = new ShadowMaterialContent();
    const directShadowMaterials = new ShadowMaterialContent();
    let subsurface: import('../render-pipeline').RenderPipelineTopology['subsurface'];
    const unsupportedSubsurfaceCapture =
      captureOnly ||
      (cubeCapture?.state.work.length ?? 0) > 0 ||
      cubeCapture?.reflectionProbes?.graph.work.some(
        (work) => work.rawCaptureFace !== undefined,
      ) === true ||
      cubeCapture?.state.planar?.current() !== undefined;
    try {
      // Capture admission includes off-screen surfaces from the validation superset.
      const demand = shadowCasterProjection?.content.subsurface;
      subsurface = subsurfaceTopology(
        !unsupportedSubsurfaceCapture && renderables.length === 0
          ? 0
          : demand === undefined
            ? (manualSubsurface?.demand ?? 0)
            : unsupportedSubsurfaceCapture
              ? demand.source
              : (cubeCapture?.subsurfaceDemand ?? demand.admitted),
        frameState.cameraStandardProfile ?? internals.standardProfile,
        internals.device,
        unsupportedSubsurfaceCapture || camera.antialias === 'msaa',
      );
    } catch (error) {
      if (!(error instanceof RhiError)) throw error;
      internals.errorRegistry.fire(error);
      abortPreparedGpuDriven();
      return false;
    }
    // Deferred SSR consumes only the opaque G-buffer selection. Later forward,
    // transparent and medium layers do not publish into its receiver buffers.
    // Receiver selection has no consumer without SSR or probe fallback demand.
    const sceneInputs =
      (reflectionFallbackCandidate || camera.screenSpaceReflection !== undefined) &&
      hasSsrSceneInputs(
        {
          renderables,
          dispatch: transparentDispatch,
          materialFrame: fixedMaterials,
        },
        standard.prepared.renderPath,
      );
    const ssrAdmission =
      ssrDependencies === undefined
        ? undefined
        : admitSsrSpatial({
            camera,
            environment: {
              lane: standard.prepared.renderPath === 'deferred' ? 'deferred' : 'forward',
              m0: ssrDependencies.admission,
              sceneInputs,
              // Standard geometry produces current motion/coverage in this
              // graph, including its first frame. Prior history is optional.
              temporal: sceneInputs,
              reflectionFallback: ssrDependencies.reflectionFallback !== undefined,
              capabilities: {
                compute: internals.device.caps.compute,
                storageTexture: internals.device.caps.storageTexture,
                rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
                r32floatSampledStorage: ssrDependencies.format?.verdict === 'admitted',
              },
              recovery: true,
            },
          });
    frameState.reflectionFallbackDemand =
      (reflectionFallbackCandidate || ssrAdmission?.status === 'admitted') && sceneInputs;

    // Settle the complete SH buffer before any geometry binds it. The retained
    // scene projection preserves its delta-upload fast path for deferred too.
    const visibleSurface =
      internals.standardProfile?.visibleSurface === true
        ? projectVisibleSurfaces(
            frameGpuDriven?.scene?.slots ?? [],
            Math.min(
              1_048_576,
              Math.floor(internals.device.limits.maxStorageBufferBindingSize / 64),
            ),
          ).unwrap()
        : undefined;
    if (visibleSurface !== undefined) {
      if (frameGpuDriven?.scene === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'the retained RenderScene for visible-surface projection',
          hint: 'prepare the ordinary renderer scene before enabling visible surfaces',
        });
      for (const source of renderables) {
        if (
          (source.instances?.instanceCount ?? 1) * 128 >
          internals.device.limits.maxStorageBufferBindingSize
        ) {
          throw new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'qualified unchunked rigid instance addressing for visible surfaces',
            hint: 'this first admission does not yet cover storage-split instance draws',
          });
        }
      }
    }
    let deferredProbeBuffer: Buffer | undefined;
    if (standard.prepared.renderPath === 'deferred') {
      const projection = frameGpuDriven?.scene?.probeBlend;
      const records =
        projection?.records ??
        renderables.flatMap((source) => {
          const record = source.probeBlendRecord;
          return record === undefined
            ? []
            : [{ cacheKey: worldEntityKey(source.worldId, source.entityKey), record }];
        });
      const capacity =
        projection?.capacity ??
        records.reduce((max, { record }) => Math.max(max, record.objectKey + 2), 1);
      if (capacity > 0x1000000)
        throw new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'deferred probe rows fit 24 bits',
          hint: 'reduce the retained probe object roster',
        });
      deferredProbeBuffer = ensureProbeBlendRecordBuffer(
        internals.device,
        frameState,
        projection ?? records,
      );
    }
    if (frameGpuDriven !== undefined) {
      const gpuShadowViews = hasShadowViews && frameGpuDriven.geometryLane !== 'direct';
      // Resolve one producer artifact for every prepared draw. COLOR_0 is a
      // per-geometry ABI axis, so a residency-wide `.some(color)` would pair
      // a no-color draw with the colored receipt (or vice versa) and collapse
      // two distinct pipeline/projection identities before indirect record.
      const preparedBindingClasses =
        cubeCapture?.reflectionProbes?.bindingClasses ?? EMPTY_MATERIAL_BINDINGS;
      materialBindingClasses = preparedBindingClasses;
      const {
        materialArtifacts,
        shadowMaterialArtifacts,
        firstArtifact,
        firstSkinArtifact,
        batchExecutions,
      } = collectGpuDrivenMaterialArtifacts({
        batches: frameGpuDriven.scene?.plan.batches ?? [],
        probeBlend: (frameGpuDriven.scene?.probeBlend?.records.length ?? 0) > 0,
        programs: materialPrograms,
        resolve: internals.getMaterialShaderArtifact,
        clustered:
          standard.kind === 'clustered' &&
          (standard.prepared.local.length > 0 ||
            frameState.installedPipelineConfig?.ssao?.enabled === true),
        reflectionFallback: frameState.reflectionFallbackDemand === true,
        shadowViews: hasShadowViews,
      });
      if (hasShadowViews)
        for (const [binding, execution] of batchExecutions) {
          if (execution.shadow.route === 'none') continue;
          const scope = worlds[binding.worldId];
          if (scope !== undefined)
            gpuShadowMaterials.add(
              binding.material,
              execution.shadow.material,
              scope,
              internals.preparedMaterialTexture,
            );
          const mesh = gpuDrivenMeshes.get(binding);
          if (collectShadowMeshes) shadowMeshLease?.reads.add(mesh?.changeToken);
        }
      acceptedMaterialArtifacts = materialArtifacts;
      acceptedShadowMaterialArtifacts = shadowMaterialArtifacts;
      const gpuProbeBlendRequested = [...materialArtifacts.values()].some((artifact) =>
        requiresProbeBlendRecord(artifact),
      );
      const gpuProbeBlendBuffer =
        deferredProbeBuffer ??
        (gpuProbeBlendRequested
          ? ensureProbeBlendRecordBuffer(
              internals.device,
              frameState,
              frameGpuDriven.scene?.probeBlend,
            )
          : undefined);
      const preparedAccepted = runRecordProfilePhase(
        profilePhase,
        'record/gpu-driven-prepare',
        () => {
          const prepared = frameGpuDriven.owner.prepare({
            scene: frameGpuDriven.scene,
            batchExecutions,
            materialArtifactResolver: (shader, request) =>
              internals.getMaterialShaderArtifact?.(shader, {
                ...(typeof request === 'boolean' ? { vertexColorAvailable: request } : request),
                clustered:
                  standard.kind === 'clustered' &&
                  (standard.prepared.local.length > 0 ||
                    frameState.installedPipelineConfig?.ssao?.enabled === true),
                probeBlend: (frameGpuDriven.scene?.probeBlend?.records.length ?? 0) > 0,
                reflectionFallback: frameState.reflectionFallbackDemand === true,
              }),
            geometryLane: frameGpuDriven.geometryLane ?? 'automatic',
            gbufferBatchOrderDiagnostic: internals.standardProfile?.gbufferBatchOrderDiagnostic,
            ...(visibleSurface === undefined ? {} : { visibleSurface }),
            camera,
            meshByBinding: gpuDrivenMeshes,
            viewBindGroupLayout: pipelineState.viewBindGroupLayout,
            // `hdrp` remains a compatibility stop for callers that cannot provide
            // the clustered topology. The production frame supplies the explicit
            // Standard topology below, so the GPU owner can select a matching
            // published group(2) artifact and bind the existing cluster owner.
            hdrp:
              standard.kind === 'clustered' &&
              (standard.prepared.local.length > 0 ||
                frameState.installedPipelineConfig?.ssao?.enabled === true),
            clustered: standard.kind === 'clustered',
            materialBindingClasses: preparedBindingClasses,
            ...(frameGpuDriven.activeEntityKeys === undefined
              ? {}
              : { activeEntityKeys: frameGpuDriven.activeEntityKeys }),
            ...(frameGpuDriven.activeEntityRevision === undefined
              ? {}
              : { activeEntityRevision: frameGpuDriven.activeEntityRevision }),
            ...(frameGpuDriven.telemetryCandidateCount === undefined
              ? {}
              : { telemetryCandidateCount: frameGpuDriven.telemetryCandidateCount }),
            ...(frameGpuDriven.telemetrySubmit === undefined
              ? {}
              : { telemetrySubmit: frameGpuDriven.telemetrySubmit }),
            ...(frameGpuDriven.frameTime === undefined
              ? {}
              : { frameTime: frameGpuDriven.frameTime }),
            ...(frameGpuDriven.deviceGeneration === undefined
              ? {}
              : { deviceGeneration: frameGpuDriven.deviceGeneration }),
            ...(frameGpuDriven.surfaceDynamicInput === undefined
              ? {}
              : { surfaceDynamicInput: frameGpuDriven.surfaceDynamicInput }),
            ...(frameGpuDriven.scene?.structureMetrics === undefined
              ? {}
              : { structureMetrics: frameGpuDriven.scene.structureMetrics }),
            ...(firstArtifact === undefined ? {} : { materialArtifact: firstArtifact }),
            ...(firstSkinArtifact === undefined ? {} : { materialSkinArtifact: firstSkinArtifact }),
            ...(materialArtifacts.size === 0 ? {} : { materialArtifacts }),
            ...(shadowMaterialArtifacts.size === 0 ? {} : { shadowMaterialArtifacts }),
            ...(gpuProbeBlendBuffer === undefined
              ? {}
              : { probeBlendRecordBuffer: gpuProbeBlendBuffer }),
            materialPipelineState: pipelineState,
            shadowViews: gpuShadowViews,
            shadowMaterials: gpuShadowMaterials,
            ...(shadowCasterProjection === undefined
              ? {}
              : { materialFrame: shadowCasterProjection.content.materials }),
            ...(internals.getMaterialShaderPipelineEntry === undefined
              ? {}
              : { materialPipelineFactory: internals.getMaterialShaderPipelineEntry }),
            ...(internals.prepareMaterialShaderPipelineEntry === undefined
              ? {}
              : {
                  materialPipelinePreparationFactory: internals.prepareMaterialShaderPipelineEntry,
                }),
            capsuleShadowDirectional,
            ...(profilePhase === undefined ? {} : { profilePhase }),
          });
          if (!prepared.ok) {
            // A capable GPU-owned candidate with missing producer resources is a
            // structured stop, not permission to enumerate the same draw through
            // the CPU semantic path. Preserve the last-known-good graph and retry
            // after the producer publishes a validated artifact.
            internals.errorRegistry.fire(prepared.error);
            return false;
          } else if (prepared.value !== undefined) {
            preparedGpuDriven = prepared.value;
            const shadowViews: ShadowViewRequest[] = [];
            if (gpuShadowViews) {
              const planesByView = shadowPlanesByView();
              const pushShadowView = (
                identity: ShadowViewIdentity,
                matrix: Float32Array,
                cameraCull?: ShadowCameraCullDilation,
              ) => {
                shadowViews.push({
                  identity,
                  casterChannels:
                    identity.kind === 'directional'
                      ? lights.directionalCsmConfig?.shadowCasterChannels
                      : identity.kind === 'point'
                        ? lights.pointShadow[identity.index]?.shadowCasterChannels
                        : lights.spot.filter((light) => (light.shadowAtlasTile ?? -1) >= 0)[
                            identity.index
                          ]?.shadowCasterChannels,
                  planes: planesByView.get(shadowViewIdentityKey(identity)) ?? shadowPlanes(matrix),
                  matrix,
                  targetSize: graphShadowMapSize,
                  graphGeneration: frameState.graphGeneration,
                  ...(cameraCull === undefined ? {} : { cameraCull }),
                  ...(identity.kind === 'directional' &&
                  lights.directionalCsmConfig?.staticShadowCache === false
                    ? { staticLayer: false as const }
                    : {}),
                });
              };
              const directionalCameraCull =
                lights.directionalShadowQuality === undefined
                  ? undefined
                  : shadowCameraCullDilation(
                      directionalShadowFilterRadiusTexels(lights.directionalShadowQuality),
                      lights.normalBias ?? 0.05,
                      graphShadowMapSize,
                    );
              for (const [index, matrix] of (lights.lightViewProj ?? []).entries()) {
                if (
                  directionalPreparationLimit !== undefined &&
                  index >= directionalPreparationLimit
                )
                  continue;
                pushShadowView({ kind: 'directional', index }, matrix, directionalCameraCull);
              }
              for (const [index, point] of lights.pointShadow.entries()) {
                for (let face = 0; face < 6; face += 1) {
                  pushShadowView(
                    { kind: 'point', index, face },
                    point.shadowMatrices.subarray(face * 16, face * 16 + 16),
                  );
                }
              }
              let shadowSpotIndex = 0;
              for (const spot of lights.spot) {
                if (spot.lightViewProj === undefined) continue;
                pushShadowView(
                  { kind: 'spot', index: shadowSpotIndex },
                  spot.lightViewProj,
                  shadowCameraCullDilation(
                    Math.min(2, Math.max(0, (Math.round(spot.pcfKernelSize ?? 3) - 1) / 2)),
                    0,
                    graphShadowMapSize,
                  ),
                );
                shadowSpotIndex += 1;
              }
            }
            const updateShadowViews = prepared.value.updateShadowViews;
            if (updateShadowViews !== undefined) {
              const shadowUpdate = runRecordProfilePhase(
                profilePhase,
                'record/gpu-driven-prepare/shadow-views',
                () => updateShadowViews(shadowViews),
              );
              if (!shadowUpdate.ok) {
                internals.errorRegistry.fire(shadowUpdate.error);
                return false;
              }
            }
          }
          return true;
        },
      );
      if (!preparedAccepted) {
        abortPreparedGpuDriven();
        return false;
      }
      if (
        gpuShadowViews &&
        preparedGpuDriven?.shadowViewPool !== undefined &&
        frameGpuDriven.scene?.unbatchedSlots !== undefined
      ) {
        const captureShadows =
          cubeCaptureWork.length > 0 ||
          cubeCapture?.reflectionProbes?.graph.work.some(
            (work) => work.rawCaptureFace !== undefined,
          ) === true;
        directShadowValidated = shadowLodRows(
          directDrawRows(
            frameGpuDriven.scene,
            (binding) => {
              const execution = batchExecutions.get(binding)?.shadow;
              if (execution === undefined) throw new Error('Missing accepted Shadow execution');
              if (execution.route === 'none') return undefined;
              return captureShadows || execution.route === 'direct'
                ? execution.material
                : undefined;
            },
            gpuDrivenMeshes,
            worlds,
            'shadow',
            prepareSources,
            shadowCasterProjection?.content.viewDraws,
            prepareShadowGeometry,
          ),
        );
      }
    }

    // Direct acceptance keeps main preparation/residency and Surface
    // page/frame/shared-time validation on the same submit hooks. Its CPU
    // shadows need no GPU shadow plan; the empty view list above retires any
    // prior GPU shadow state through the ordinary submission transaction.
    const rasterGpuDriven =
      frameGpuDriven?.geometryLane === 'direct' ? undefined : preparedGpuDriven;
    const gpuSelection = rasterGpuDriven?.selection ?? EMPTY_GPU_DRAW_SELECTION;
    gpuDriven?.onRasterLane(
      rasterGpuDriven === undefined ? undefined : { selection: gpuSelection },
    );
    if (hasShadowViews && directShadowValidated === undefined) {
      directShadowValidated = shadowLodRows(
        nativeScene === undefined
          ? prepareSources(
              sourceRenderables,
              shadowCasterProjection?.dispatch ?? transparentDispatch,
            )
          : directDrawRows(
              nativeScene,
              (binding) => {
                const material = fixedMaterials.get(binding.material);
                if (material === undefined)
                  throw new Error('Shadow draw requires its accepted material');
                return materialMatchesPass(
                  material,
                  SHADOW_CASTER_PASS_SELECTOR,
                  undefined,
                  undefined,
                )
                  ? material.snapshot
                  : undefined;
              },
              gpuDrivenMeshes,
              worlds,
              'shadow',
              prepareSources,
              shadowCasterProjection?.content.viewDraws,
              prepareShadowGeometry,
            ),
      );
    }
    for (const row of directShadowValidated ?? []) {
      if (collectShadowMeshes) shadowMeshLease?.reads.add(row.mesh.changeToken);
      const scope = worlds[row.source.worldId ?? 0];
      if (scope === undefined) continue;
      for (const index of row.submeshIndices ?? row.mesh.submeshes.keys()) {
        const submesh = row.mesh.submeshes[index];
        if (submesh === undefined) continue;
        const resource = row.source.materials[submesh.materialSlot] ?? row.source.material;
        const accepted = fixedMaterials.get(resource);
        if (accepted !== undefined)
          directShadowMaterials.add(
            resource,
            accepted.snapshot,
            scope,
            internals.preparedMaterialTexture,
          );
      }
    }

    // Compile the single frame graph only after GPU preparation has projected
    // the current frame. This keeps the graph topology and its execution
    // closure on the same prepared GPU-owned draw set.

    frameState.dynamicResolution ??= new DynamicResolutionController();
    const resolution = frameState.dynamicResolution;
    const renderExtent = resolution.configure(
      camera.dynamicResolution,
      worlds[camera.worldId ?? 0] ?? world,
      camera.entityKey ?? 0,
      Math.max(1, internals.canvas.width),
      Math.max(1, internals.canvas.height),
      internals.deviceScope?.generation ?? 0,
      isTimestampQueryAdmitted(internals.device.caps),
    );
    if (internals.standardProfile?.probePlacement !== undefined) {
      if (visibleSurface === undefined || frameGpuDriven?.scene === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'the actual visible-surface row projection for placement',
          hint: 'prepare the ordinary rigid deferred scene',
        });
      for (const slot of frameGpuDriven.scene.slots) {
        if (!visibleSurface.slotBases.has(slot.slot)) continue;
        for (const draw of slot.snapshot.gpuDrivenDraws ?? []) {
          if (draw.count === 0) continue;
          const material = slot.snapshot.materials[draw.materialSlot]?.snapshot;
          const scope = worlds[slot.worldId] ?? world;
          const handle = material?.materialHandle ?? (0 as AssetHandle<'material'>);
          const source = scope.resolveAsset<MaterialAsset>(handle);
          const asset = source;
          const projection = asset.ok
            ? internals.assets.getMaterialProjectionForPayload(asset.value)
            : undefined;
          const nativeSource =
            projection === undefined ? readMaterialContent(scope, handle) : asset;
          if (
            material === undefined ||
            !isNativePlacementMaterial(
              material,
              projection,
              nativeSource.ok ? nativeSource.value : undefined,
            )
          )
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'native lit Standard materials for every admitted placement row',
              hint: 'publish the selected native Standard program and Surface; custom/unlit rows are not admitted',
            });
        }
      }
      frameState.probePlacement ??= new RendererProbePlacement();
      frameState.probePlacementFrame = frameState.probePlacement.prepare({
        runtime: internals,
        seeds: internals.standardProfile.probePlacement.seeds,
        ...(internals.standardProfile.probePlacement.global === undefined
          ? {}
          : {
              globalSource: { scene: frameGpuDriven.scene, worlds, leases: renderReadLeases },
            }),
        camera: camera.entityKey ?? 0,
        world: (worlds[camera.worldId ?? 0] ?? world).identity,
        records: visibleSurface.records,
        width: renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
        height: renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
      });
    } else {
      frameState.probePlacement?.disable();
    }
    const probePlacement = frameState.probePlacementFrame;
    if (!captureOnly && internals.standardProfile?.diffuseGi?.gather === 'exact') {
      if (frameGpuDriven?.scene === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'a retained scene for diffuse GI',
          hint: 'prepare the ordinary deferred scene before enabling diffuse GI',
        });
      frameState.rayDiffuse ??= new RendererRayDiffuse();
      frameState.rayDiffuse.prepare({
        runtime: internals,
        scene: frameGpuDriven.scene,
        worlds,
        lights: [
          ...(lights.directional === undefined ? [] : [lights.directional]),
          ...lights.point,
          ...lights.spot,
          ...lights.rect,
        ],
        sampler: pipelineState.defaultSampler,
        profile: internals.standardProfile.diffuseGi,
        width: renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
        height: renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
      });
    } else if (!captureOnly) {
      // Preserve the generation counter across toggles. A retained graph must
      // never confuse a new preparation with a retired allocation's generation.
      frameState.rayDiffuse?.disable();
    }
    const rayDiffuse = captureOnly ? undefined : frameState.rayDiffuse?.ready;
    const irradianceGi = internals.standardProfile?.diffuseGi;
    // One persistent field serves both its own per-pixel gather and, as the
    // world fallback and Card-radiance producer, the Screen Probe gather.
    const fieldGi =
      irradianceGi?.gather === 'irradiance-field' || irradianceGi?.gather === 'screen-probe'
        ? irradianceGi
        : undefined;
    if (!captureOnly && fieldGi !== undefined) {
      if (frameGpuDriven?.scene === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: `a retained scene for ${fieldGi.gather} diffuse GI`,
          hint: 'prepare the ordinary deferred scene before enabling diffuse GI',
        });
      frameState.irradianceField ??= new RendererIrradianceField();
      frameState.irradianceField.prepare({
        runtime: internals,
        scene: frameGpuDriven.scene,
        worlds,
        leases: renderReadLeases,
        lights: [
          ...(lights.directional === undefined ? [] : [lights.directional]),
          ...lights.point,
          ...lights.spot,
          ...lights.rect,
        ],
        profile: {
          gather: 'irradiance-field',
          maxDistance: fieldGi.maxDistance,
          environment: fieldGi.environment,
          field: fieldGi.field,
          ...(fieldGi.reflections === undefined ? {} : { reflections: fieldGi.reflections }),
        },
        width: renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
        height: renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
        // Screen Probes own the diffuse view gather; Lite reflections stay field-owned.
        gatherView: fieldGi.gather === 'irradiance-field',
        focus: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0],
      });
    } else if (!captureOnly) {
      frameState.irradianceField?.disable();
    }
    const irradianceField =
      captureOnly || irradianceGi?.gather !== 'irradiance-field'
        ? undefined
        : frameState.irradianceField?.ready;
    // Baked GI only gathers a Catalog volume: no scene, Cards or probe updates.
    if (!captureOnly && irradianceGi?.gather === 'baked') {
      frameState.bakedField ??= new RendererBakedField();
      frameState.bakedField.prepare({
        runtime: internals,
        profile: irradianceGi,
        width: renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
        height: renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
      });
    } else if (!captureOnly) {
      frameState.bakedField?.disable();
    }
    const bakedField = captureOnly ? undefined : frameState.bakedField?.ready;
    if (!captureOnly && irradianceGi?.gather === 'screen-probe') {
      frameState.screenProbe ??= new RendererScreenProbe();
      frameState.screenProbe.prepare({
        runtime: internals,
        profile: irradianceGi,
        field: frameState.irradianceField?.ready,
        width: renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
        height: renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
      });
    } else if (!captureOnly) {
      frameState.screenProbe?.disable();
    }
    const screenProbe = captureOnly ? undefined : frameState.screenProbe?.ready;
    const terrainReceivers = terrainShadowReceivers(
      shadowCasterProjection?.renderables ?? renderables,
    );
    if (cubeCapture !== undefined)
      for (const work of cubeCaptureWork) {
        const lighting = prepareTargetCaptureLighting(
          cubeCapture.state,
          work,
          internals,
          frameState,
          pipelineState,
          lights,
        );
        const graph = compileTargetCaptureFrameGraph(
          lighting.runtime,
          lighting.frameState,
          lighting.pipeline,
          work.faceCamera,
          lighting.lights,
          graphShadowMapSize,
          { work: [work], atmosphere: lighting.capturedAtmosphere !== undefined },
          lighting.lighting,
          undefined,
          terrainReceivers,
        );
        captureFrames.push({ ...lighting, graph, viewport: work.physical.descriptor });
      }
    if (cubeCapture !== undefined)
      for (const probe of cubeCapture.reflectionProbes?.graph.work ?? []) {
        if (probe.rawCaptureFace === undefined || probe.faceCamera === undefined) continue;
        const work = {
          ...probe,
          target: probe.rawTexture,
          faceCamera: probe.faceCamera,
          candidateGeneration: probe.captureGeneration ?? 0,
        };
        const lighting = prepareTargetCaptureLighting(
          cubeCapture.state,
          work,
          internals,
          frameState,
          pipelineState,
          lights,
        );
        const graph = compileTargetCaptureFrameGraph(
          lighting.runtime,
          lighting.frameState,
          lighting.pipeline,
          work.faceCamera,
          lighting.lights,
          graphShadowMapSize,
          { work: [], atmosphere: lighting.capturedAtmosphere !== undefined },
          lighting.lighting,
          { ...probe, viewBindGroupDynamicOffset: 0, step: undefined },
          terrainReceivers,
        );
        probeCaptureFrames.push({
          ...lighting,
          graph,
          viewport: { width: probe.rawSize, height: probe.rawSize },
        });
      }
    const transparencyView = resolveTransparencyView({
      requested: camera.transparency ?? 'sorted',
      rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
      renderables,
      materialFrame: fixedMaterials,
      dispatch: transparentDispatch,
    });
    const preparationMaterials = frameState.candidatePipelinePreparations?.materials;
    const preparationTransmission = preparationMaterials?.transmissionDemand;
    const graphTransmission =
      preparationTransmission !== undefined && preparationTransmission.activeCount > 0
        ? {
            activeCount:
              (transmissionDemand?.activeCount ?? 0) + preparationTransmission.activeCount,
            needsRoughMips:
              transmissionDemand?.needsRoughMips === true || preparationTransmission.needsRoughMips,
            needsBackPass:
              transmissionDemand?.needsBackPass === true ||
              preparationTransmission.needsBackPass === true,
          }
        : transmissionDemand;
    const preflightGraph = runRecordProfilePhase(profilePhase, 'record/render-graph', () =>
      captureOnly
        ? (captureFrames[0]?.graph ?? null)
        : ensureCompiledFrameGraph(
            internals,
            frameState,
            pipelineState,
            camera,
            lights,
            Math.max(1, internals.canvas.width),
            Math.max(1, internals.canvas.height),
            graphShadowMapSize,
            rasterGpuDriven,
            featureGraphCandidate,
            cubeCapture?.state,
            cameras.length === 0,
            graphTransmission,
            graphVolumetricFog,
            volumeTopologyCandidate,
            standard,
            undefined,
            ssrAdmission,
            renderExtent,
            fixedMaterials.hasMedium || preparationMaterials?.hasMedium === true,
            analyticFog !== undefined && analyticFog.density > 0 && analyticFog.maxOpacity > 0,
            cloudShadowProjection?.resolution,
            transparencyView.topology,
            terrainReceivers,
            subsurface,
            rendererRecording,
          ),
    );
    const acceptedExtent = resolution.submittedExtent;
    const retainedWrongExtent =
      frameState.barrelDistortionGraphResolution === 'retained' &&
      (renderExtent === undefined
        ? acceptedExtent !== undefined
        : acceptedExtent?.internalWidth !== renderExtent.internalWidth ||
          acceptedExtent?.internalHeight !== renderExtent.internalHeight ||
          acceptedExtent?.outputWidth !== renderExtent.outputWidth ||
          acceptedExtent?.outputHeight !== renderExtent.outputHeight);
    if (preflightGraph === null || retainedWrongExtent) {
      abortPreparedGpuDriven();
      return false;
    }

    // The compiled graph is the acceptance boundary for the prepared
    // Standard lighting declaration. Upload the same declaration only after
    // that graph is current; a failed candidate therefore cannot leave an old
    // graph consuming a new buffer generation.
    if (
      !captureOnly &&
      frameState.standardLightingGraphSignature !== standardLightingTopologySignature(standard)
    ) {
      internals.errorRegistry.fire(
        new RendererOperationError('device-operation-failed', {
          operation: 'draw',
          cause: {
            code: 'standard-graph-generation-mismatch',
            expected: 'compiled graph and prepared Standard lighting share one topology signature',
            hint: 'retry the frame after the Standard graph candidate is accepted',
            detail: {
              expected: standardLightingTopologySignature(standard),
              actual: frameState.standardLightingGraphSignature,
            },
          },
        }),
      );
      abortPreparedGpuDriven();
      return false;
    }
    if (!captureOnly && standard.kind === 'clustered') {
      // The clustered HDRP payload owns the direct-light slot upload, so it
      // must also drive the shared IES/light-texture resource upload from the
      // authoritative extracted-light corpus. The prepared local carrier can
      // omit the source payload on this path, leaving the shader bound to its
      // white Cookie fallback even though the authored handle is valid.
      writeLightModifierTextures(internals, pipelineState, lights);
      const clusterWrite = runRecordProfilePhase(
        profilePhase,
        'record/scene-state/hdrp-cluster',
        () =>
          writeHdrpClusterAndSsaoBuffers(
            internals,
            frameState,
            camera,
            standard.prepared,
            standard.transport,
            profilePhase,
            pipelineState.hdrpClusterMembershipPipeline !== null,
            pipelineState.hdrpClusterMembershipBindGroupLayout,
            preparedSpotLightProjector?.lightSlotIndex,
            pipelineState,
          ),
      );
      if (!clusterWrite.ok) {
        internals.errorRegistry.fire(clusterWrite.error);
        abortPreparedGpuDriven();
        return false;
      }
    }

    // Acquire the swap-chain texture + colour view + target dimensions (with
    // one reconfigure-and-retry on surface-outdated). Extracted to
    // acquireSwapChainTarget (M3/w18); returns null on unrecoverable failure
    // (context null / double getCurrentTexture fail / view creation fail), in
    // which case recordFrame bails after the finally-block frame advance.
    const swapTarget = runRecordProfilePhase(profilePhase, 'record/swapchain', () =>
      captureOnly
        ? (() => {
            const capture = cubeCaptureWork[0];
            if (capture === undefined) return null;
            return {
              currentTexture: capture.physical.texture,
              view: capture.physical.view,
              targetW: capture.physical.descriptor.width,
              targetH: capture.physical.descriptor.height,
            };
          })()
        : acquireSwapChainTarget(internals, pipelineState),
    );
    if (swapTarget === null) {
      abortPreparedGpuDriven();
      return false;
    }
    const currentTexture = swapTarget.currentTexture;
    const view = swapTarget.view;
    const targetW = swapTarget.targetW;
    const targetH = swapTarget.targetH;
    const submittedBarrelMapping = captureOnly
      ? undefined
      : resolveSubmittedBarrelMapping(frameState, preflightGraph, camera, targetW, targetH);

    const previousTemporalView = frameState.lastSuccessfulTemporalView;
    const motionBlurDemand =
      camera.motionBlur === undefined
        ? false
        : motionBlurTemporalDemand({
            shutterAngle: camera.motionBlur.shutterAngle,
            maxRadiusPixels: camera.motionBlur.maxRadiusPixels,
            sampleCount: camera.motionBlur.sampleCount,
            targetFps: camera.motionBlur.targetFps ?? 60,
          });
    const temporalDemand = standardSceneTemporalDemand(camera, visibleSurface !== undefined);
    const clock = frameClockSample(world, worlds, camera, sampleTimeSeconds);
    const deltaSeconds =
      temporalReset || clock.invalidSampleTime
        ? Number.NaN
        : motionBlurSampleDelta(
            clock.elapsedSeconds,
            previousTemporalView?.sampleTimeSeconds,
            clock.deltaSeconds,
          );
    const intervalValid = isMotionBlurIntervalValid(deltaSeconds);
    // An off MB-only frame still carries an unjittered temporal view so the
    // accepted sample clock remains observable. Its history flag is false,
    // however, and must form a new baseline when the effect is enabled again.
    // A reset frame already has an explicit reason and is the valid baseline
    // for the following pair, so it is deliberately excluded here.
    const motionBlurFirstFrame =
      motionBlurDemand &&
      camera.antialias !== 'taa' &&
      (previousTemporalView === undefined ||
        (previousTemporalView.mode === 'off' &&
          !previousTemporalView.historyValid &&
          previousTemporalView.resetReason === undefined));
    const currentUnjitteredViewProjection = mat4.multiply(
      mat4.create(),
      computeProjectionMatrix(camera),
      computeViewMatrix(camera),
    );
    const currentCameraPosition = [
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
    ] as const;
    const temporalCandidate = createTemporalView({
      antialias: camera.antialias,
      width: Math.max(1, targetW),
      height: Math.max(1, targetH),
      frameIndex: frameState.successfulTemporalFrameIndex ?? 0,
      viewIdentity: `camera:${camera.entityKey ?? 0}`,
      environmentSignature,
      fogSignature,
      deviceGeneration: internals.deviceScope?.generation ?? 0,
      ...(renderExtent === undefined
        ? {}
        : {
            internalWidth: renderExtent.internalWidth,
            internalHeight: renderExtent.internalHeight,
          }),
      ...(camera.historyVersion === undefined ? {} : { historyVersion: camera.historyVersion }),
      ...(clock.elapsedSeconds === undefined ? {} : { sampleTimeSeconds: clock.elapsedSeconds }),
      historyValid: false,
      currentUnjitteredViewProjection,
      currentCameraPosition,
    });
    const resetReason =
      temporalDemand && environmentReady
        ? (resolveTemporalReset(previousTemporalView, temporalCandidate) ??
          (temporalReset || (motionBlurDemand && !intervalValid)
            ? 'time-discontinuity'
            : motionBlurFirstFrame
              ? 'first-frame'
              : undefined))
        : undefined;
    const canReusePrevious = previousTemporalView !== undefined && resetReason === undefined;
    const temporalView = createTemporalView({
      ...temporalCandidate.input,
      frameIndex: resetReason === undefined ? temporalCandidate.input.frameIndex : 0,
      // Motion Blur needs a finite positive pair before it can read the
      // baseline. TAA-only frames retain their existing temporal contract and
      // do not depend on the simulation clock being present in a test host.
      historyValid:
        temporalDemand &&
        environmentReady &&
        canReusePrevious &&
        (!motionBlurDemand || intervalValid),
      resetReason,
      ...(canReusePrevious && previousTemporalView.currentUnjitteredViewProjection !== undefined
        ? {
            previousUnjitteredViewProjection: previousTemporalView.currentUnjitteredViewProjection,
          }
        : {}),
      ...(canReusePrevious && previousTemporalView.currentCameraPosition !== undefined
        ? { previousCameraPosition: previousTemporalView.currentCameraPosition }
        : {}),
    });
    frameState.pendingTemporalCommit =
      cameras.length === 0 || !environmentReady || internals.deviceScope === undefined
        ? { kind: 'none' }
        : temporalView.mode === 'taa'
          ? { kind: 'taa', view: temporalView }
          : { kind: 'off', view: temporalView };
    const recordCamera: CameraSnapshot =
      temporalView.mode === 'taa' ? { ...camera, temporal: temporalView } : camera;
    const continuousGeometry =
      canReusePrevious || resetReason === 'environment-change' || resetReason === 'fog-change';
    const previousViewProjection = previousTemporalView?.currentUnjitteredViewProjection;
    const previousCameraPosition = previousTemporalView?.currentCameraPosition;
    screenProbe?.reproject(
      continuousGeometry &&
        previousViewProjection !== undefined &&
        previousCameraPosition !== undefined
        ? { viewProjection: previousViewProjection, cameraPosition: previousCameraPosition }
        : undefined,
    );
    rayDiffuse?.reconstruction?.prepare(temporalView, previousTemporalView, camera);
    rayDiffuse?.reflections?.reconstruction?.prepare(temporalView, previousTemporalView, camera);
    if (ssrAdmission !== undefined) {
      const historyWidth = renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width);
      const historyHeight = renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height);
      if (
        !stageSsrHistoryCandidate(
          internals,
          frameState,
          camera,
          historyWidth,
          historyHeight,
          ssrAdmission,
          temporalView,
        )
      ) {
        return false;
      }
    }
    let activeVolumetricFogContext: VolumetricFogFrameContext | undefined;
    let activeVolumetricFogSignature: VolumeTemporalSignature | undefined;
    if (graphVolumetricFog?.status === 'available' && baseVolumetricFogContext !== undefined) {
      const resolvedHistory = resolveVolumetricFogHistoryContext(
        frameState,
        preflightGraph,
        graphVolumetricFog,
        baseVolumetricFogContext,
        camera,
        lights,
        targetW,
        targetH,
      );
      activeVolumetricFogContext = resolvedHistory.context;
      activeVolumetricFogSignature = resolvedHistory.signature;
      const previousTime = frameState.volumetricFogHistorySignature?.worldTimeSeconds;
      const currentTime = resolvedHistory.signature.worldTimeSeconds;
      // Adjacent UBO lanes: validity, RenderResourceScope time, elapsed time since accepted history.
      const historyParams = new Float32Array([
        activeVolumetricFogContext.historyValid ? 1 : 0,
        currentTime ?? 0,
        previousTime === undefined || currentTime === undefined
          ? 0
          : Math.max(0, currentTime - previousTime),
      ]);
      frameState.volumetricFogParams.pending?.params.set(historyParams, 31);
      const historyParamsWritten = internals.device.queue.writeBuffer(
        activeVolumetricFogContext.paramsBuffer,
        31 * Float32Array.BYTES_PER_ELEMENT,
        historyParams,
      );
      if (!historyParamsWritten.ok) {
        internals.errorRegistry.fire(historyParamsWritten.error);
        abortPreparedGpuDriven();
        return false;
      }
    }

    // feat-20260709 M3 / D-3: clear-color read from the active CameraSnapshot's
    // single `clearColor` array field (first-archetype-hit per OOS-2). When the
    // world had zero Camera entities, `camera` here is the synthetic fallback
    // snapshot built above (Case B), which carries
    // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]`.
    const clear: readonly [number, number, number, number] = [
      camera.clearColor[0],
      camera.clearColor[1],
      camera.clearColor[2],
      camera.clearColor[3],
    ];

    pipelineState.perPassResources.shadowMapSize = graphShadowMapSize ?? 0;
    pipelineState.perPassResources.shadowCascadeCount = lights.cascadeCount ?? 0;
    const firstDirectionalShadowMatrix = lights.lightViewProj?.[0];
    pipelineState.perPassResources.shadowLightSpaceMatrix =
      firstDirectionalShadowMatrix === undefined
        ? null
        : new Float32Array(firstDirectionalShadowMatrix);
    if (lights.lightViewProj === undefined) {
      pipelineState.perPassResources.shadowCsmLightViewProj = null;
      pipelineState.perPassResources.shadowCsmSelection = null;
    } else {
      const csmMatrices = new Float32Array(64);
      for (let cascade = 0; cascade < 4; cascade += 1) {
        const matrix = lights.lightViewProj[cascade];
        if (matrix !== undefined) csmMatrices.set(matrix, cascade * 16);
      }
      pipelineState.perPassResources.shadowCsmLightViewProj = csmMatrices;
      pipelineState.perPassResources.shadowCsmSelection =
        lights.splitPlanes === undefined
          ? null
          : {
              viewMatrix: new Float32Array(computeViewMatrix(camera)),
              splitPlanes: new Float32Array(lights.splitPlanes),
            };
    }

    // Tonemap + skybox-active resolution (skybox requires tonemap HDR target +
    // a resident cubemap view). Extracted to resolveSkyboxActive (M3/w18).
    const { tonemapActive, skyboxActive } = resolveSkyboxActive(
      internals,
      frameState,
      recordCamera,
      skybox,
      world,
    );

    // feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9 (D-6, C-9):
    // MSAA is a per-Camera switch derived from `camera.antialias`, never
    // stored separately. When active the geometry pass writes a count=4
    // multisample colour target and resolves to a single-sample output; the
    // record stage selects the `*Msaa` pipeline variants and the geometry
    // pass attaches the resolve target. When inactive every attachment +
    // pipeline stays single-sample (the pre-MSAA path is byte-for-byte
    // unchanged).
    const msaaActive =
      camera.antialias === 'msaa' && internals.device.caps.backendKind !== 'wgpu-webgl2';
    const geometryDepthKey: string | null = null;

    // Only the installed stock graph's capable Shadow lane can release its
    // unused legacy mesh slots. Keep every material row: alpha/custom Shadow
    // groups still bind that table, and its getters/diagnostics remain observed.
    const gpuOwnsShadowGeometry =
      rendererRecording &&
      !captureOnly &&
      captureFrames.length === 0 &&
      probeCaptureFrames.length === 0 &&
      (cubeCapture?.scheduledWork.length ?? 0) === 0 &&
      (cubeCapture?.auxiliaryCameras.length ?? 0) === 0 &&
      (cubeCapture?.sceneInputs?.length ?? 0) === 0 &&
      frameState.compiledFrameGraph?.graph === preflightGraph &&
      frameState.compiledFrameGraph.directionalShadowViewCount !== undefined &&
      rasterGpuDriven?.shadowDirectRequired === false &&
      rasterGpuDriven.shadowViewPool !== undefined;

    const sceneWork =
      nativeScene === undefined || shadowCasterProjection === undefined
        ? undefined
        : prepareScenePasses(
            [
              preflightGraph,
              ...captureFrames.map(({ graph }) => graph),
              ...probeCaptureFrames.map(({ graph }) => graph),
            ].flatMap(scenePassRequests),
            nativeScene,
            shadowCasterProjection.content.materials,
            gpuSelection,
            gpuDrivenMeshes,
            worlds,
            prepareSources,
            shadowCasterProjection.content.viewDraws ?? [],
            prepareGeometry,
            shadowCasterProjection.prepareDrawDispatch,
            (dispatch, sources) => computeFoldBuckets(world, frameState, dispatch, sources),
            (rows, request) =>
              cpuLaneLodRows(internals.device.caps, request.camera?.() ?? camera)(rows),
            world,
            camera,
            gpuDriven?.cameraVisible,
          );
    const sceneDispatch = sceneWork?.dispatch ?? transparentDispatch;

    // Dispatch-ordered render plan: reorder validated renderables to dispatch
    // order, run the mesh-SSBO capacity gate (graceful truncation), and build
    // the fold dispatch plan. Extracted to buildDispatchPlan (M3/w18).
    const dispatchPlan = runRecordProfilePhase(profilePhase, 'record/dispatch-plan', () =>
      buildDispatchPlan(
        internals,
        sceneWork?.rows ?? manualDraws,
        sceneDispatch,
        sceneWork?.buckets ?? foldBuckets,
        directShadowValidated ?? [],
        materialBindingClasses,
        gpuOwnsShadowGeometry,
        { bindings: rasterGpuDriven?.materialBindings ?? [], worlds, frame: fixedMaterials },
        shadowCasterProjection?.meshDraws,
      ),
    );
    const validatedOrdered = dispatchPlan.validatedOrdered;
    const shadowValidatedOrdered = dispatchPlan.shadowValidatedOrdered;
    const scenePassWork = sceneWork?.finish(dispatchPlan);
    const preparationSources: RenderableSnapshot[] = [];
    if (nativeScene === undefined) {
      for (const source of sourceRenderables)
        if (source.pipelinePreparation !== undefined) preparationSources.push(source);
    } else {
      for (const slot of nativeScene.pipelinePreparationSlots ?? []) {
        const source = nativeScene.drawSnapshotAt?.(slot);
        if (source !== undefined) preparationSources.push(source);
      }
    }
    const pipelinePreparationEntries = prepareSources(preparationSources);
    cleanPerFrameCaches(internals, frameState, [
      ...validatedOrdered,
      ...shadowValidatedOrdered,
      ...pipelinePreparationEntries,
    ]);

    let pointsLinesSlots = 0;
    for (const row of validatedOrdered)
      if (row.source.pointsLines !== undefined)
        pointsLinesSlots = Math.max(pointsLinesSlots, row.renderableIndex + 1);
    pipelineState.ensurePointsLinesViewCapacity?.(pointsLinesSlots);
    for (const capture of [...captureFrames, ...probeCaptureFrames])
      capture.pipeline.ensurePointsLinesViewCapacity?.(pointsLinesSlots);

    const capsuleShadowLight =
      capsuleShadowDirectional &&
      lights.directional !== undefined &&
      lights.directionalShadowQuality !== undefined
        ? {
            direction: lights.directional.direction,
            coneHalfAngle: capsuleConeHalfAngle(lights.directionalShadowQuality),
            renderables: shadowCasterProjection?.renderables ?? renderables,
          }
        : undefined;
    frameState.capsuleShadowSubmission = undefined;
    const shadowMaterialRowBase = validatedOrdered.length;
    const shadowDispatch = shadowCasterProjection?.dispatch;
    const foldDispatchPlan = dispatchPlan.foldDispatchPlan;
    const materialSlotIndices = dispatchPlan.materialSlotIndices;
    const materialSlots = dispatchPlan.materialSlots;
    const materialSlotCount = dispatchPlan.materialSlotCount;

    // D-2 (bug-20260527): LDR sprite pass split, generalised feat-20260625
    // M2 / w7 via {@link computeSplitLdrSprite}; M3 w13 finalised by deleting
    // the legacy shadingModel arm — transparent is the single SSOT. AC-05
    // (non-sprite shader carrying transparent:true) trips the split too;
    // the unit suite render-system-record.test.ts 'transparent decouples
    // from sprite shader' locks the contract.
    //
    // When the LDR path (tonemapActive=false) has transparent entities in
    // the validated draw list, the render is split into two serial passes
    // sharing one color attachment. The transparent pass format is resolved
    // by transparentPassColorFormat: native linear-LDR frames use the
    // graph-owned `ldrColor` attachment (which may be rgba16float), while
    // the swap-chain fallback uses its raw storage view. The encoder and
    // sprite PSO must use the same resolved format because WebGPU requires
    // attachment and pipeline target formats to match.
    const splitLdrSprite = computeSplitLdrSprite(validatedOrdered, tonemapActive, sceneDispatch);

    // View / mesh uniform uploads are needed when geometry or a feature consumes View,
    // OR when a skybox is active (skybox pass reads inverseViewProj from
    // the View UBO). Skip the writeBuffer round-trips on the Case E
    // (clear-pass-only) path only when neither condition is met.
    // feat-20260531-skybox-env-background M2 / w6: gate relaxed from
    // `validatedOrdered.length > 0` to include skybox-only frames
    // (plan-strategy D-3, R-3).
    const currentViewProjection = mat4.create();
    mat4.multiply(
      currentViewProjection,
      computeProjectionMatrix(camera),
      computeViewMatrix(camera),
    );
    if (
      validatedOrdered.length > 0 ||
      shadowValidatedOrdered.length > 0 ||
      (rasterGpuDriven !== undefined && materialSlotCount > 0) ||
      getRenderFeatureGraphState(internals).plans.some(({ plan }) => plan.passes.length > 0) ||
      skyboxActive ||
      frameState.environmentFrame?.source.kind === 'atmosphere' ||
      activeVolumetricFogContext !== undefined ||
      preparedVolumetricFog !== undefined
    ) {
      runRecordProfilePhase(profilePhase, 'record/uploads', () => {
        // View UBO + CSM/spot-shadow matrix pack: assembled + uploaded in one
        // queue.writeBuffer round-trip. Extracted to view-ubo.ts (M3/w18) so
        // recordFrame stays an orchestration skeleton (D-2).
        // The stable projection is carried in the View UBO. Direct-sun shader
        // consumers sample the renderer-owned map at each receiver position.
        writeViewUbo(
          internals.device.queue,
          pipelineState.viewUniformBuffer,
          camera,
          light,
          lights,
          frameState.spotShadowSnapshots,
          temporalView,
          preparedSpotLightProjector?.spotIndex,
          cloudShadowProjection,
          analyticFog,
          frameState.environmentFrame?.source.kind === 'atmosphere'
            ? frameState.environmentFrame.source.atmosphere
            : undefined,
          false,
          clock.elapsedSeconds,
          { width: targetW, height: targetH },
        );
        if (pipelineState.pointsLinesViewBuffer !== undefined) {
          writePointsLinesViewUbo(
            internals.device.queue,
            pipelineState.pointsLinesViewBuffer,
            camera,
            targetW,
            targetH,
          );
        }
        writeShadowCasterUniforms(
          internals.device.queue,
          pipelineState.shadowCasterCascadeBuffer,
          lights,
        );
      });
    }

    const sealedReads = preparedGpuDriven?._sealResourceReads();
    if (sealedReads !== undefined && !sealedReads.ok) {
      internals.errorRegistry.fire(sealedReads.error);
      return false;
    }
    const shadowMeshInput =
      shadowGeometryFixed &&
      shadowMeshLease !== undefined &&
      shadowMeshInputCurrent(shadowMeshLease)
        ? shadowMeshLease
        : undefined;
    const shadowLodToken = shadowLodSelection?.token;
    const directionalShadowCache = runRecordProfilePhase(
      profilePhase,
      'record/scene-state/directional-shadow-cache',
      () =>
        prepareDirectionalShadowCache(
          internals,
          frameState,
          worlds,
          renderReadLeases,
          lights,
          effectiveShadowMapSize,
          shadowMeshInput,
          shadowCasterProjection,
          [gpuShadowMaterials, directShadowMaterials],
          shadowLodToken,
        ),
    );
    frameState.directionalShadowCacheRecorded = false;
    const shadowPublication =
      lights.directionalCsmConfig?.staggerCascades === true &&
      rasterGpuDriven?.shadowViewPool === undefined
        ? currentDirectionalShadowPublication(
            worlds,
            shadowCasterProjection,
            frameState.directionalShadowCache,
          )
        : undefined;
    const cascadeCadence =
      lights.directionalCsmConfig?.staggerCascades === true &&
      rasterGpuDriven?.shadowViewPool === undefined
        ? prepareDirectionalCascadeCadence(
            lights,
            frameState.directionalShadowCache === null
              ? undefined
              : frameState.directionalCascadeCadence,
            directionalShadowCache.miss,
          )
        : undefined;

    const encoderResult =
      sharedEncoder === undefined
        ? internals.device.createCommandEncoder({ label: 'render-system-frame' })
        : ok(sharedEncoder);
    if (!encoderResult.ok) {
      internals.errorRegistry.fire(encoderResult.error);
      abortPreparedGpuDriven();
      return false;
    }
    const encoder: RhiCommandEncoder = encoderResult.value;

    // Per-frame bind group cache resolution (view / mesh / HDRP-cluster).
    // Extracted to buildPerFrameBindGroups (M3/w18) so recordFrame stays a
    // skeleton; returns null groups on the Case E (0-validated) path.
    const { viewBindGroup, meshBindGroup, hdrpClusterBindGroup, hdrpClusterMembershipBindGroup } =
      runRecordProfilePhase(profilePhase, 'record/bind-groups', () =>
        buildPerFrameBindGroups(
          internals,
          frameState,
          pipelineState,
          validatedOrdered.length > 0 ||
            shadowValidatedOrdered.length > 0 ||
            rasterGpuDriven !== undefined,
          bindGroupCounts,
          undefined,
          true,
          standard,
        ),
      );

    const planarCapture = cubeCapture?.state.planar?.current();
    const planarUniform = new Float32Array(24);
    if (planarCapture?.camera.planarReflection !== undefined) {
      const reflected = planarCapture.camera;
      planarUniform.set(
        mat4.multiply(
          mat4.create(),
          computeProjectionMatrix(reflected),
          computeViewMatrix(reflected),
        ),
      );
      const config = planarCapture.camera.planarReflection;
      const length = Math.hypot(...config.normal);
      planarUniform.set(
        [...config.normal].map((x) => x / length),
        16,
      );
      planarUniform[19] = config.distance / length;
      planarUniform[20] = 1;
    }
    const planarUpload = internals.device.queue.writeBuffer(
      pipelineState.viewUniformBuffer,
      PLANAR_REFLECTION_UNIFORM_OFFSET,
      planarUniform,
    );
    if (!planarUpload.ok) throw planarUpload.error;

    // ── feat-20260529-rendergraph-pass-abstraction M4 / w13b ───────────
    // The compiled typed graph is the sole per-frame pass owner.
    //
    // Every pass records into the shared encoder. The graph owns ordering and
    // the renderer finishes and submits exactly once after graph execution.
    // feat-20260601 M2 / w12: the per-frame shared state is the clean
    // `RenderPipelineContext` - `internals` is replaced by the named `assets`
    // (CPU POD) / `store` (GPU residency) / `pipelineState` / `runtime` (device +
    // errorRegistry + shader-cache lookups) surfaces (`internals` itself satisfies
    // `RenderSystemRuntime` so `runtime: internals` is a zero-cost reference). The
    // 0-consumed `skyboxCount` residual is dropped.
    // Camera-owned temporal controls are projected into the per-frame
    // post-process parameter map at record time. The extracted ECS map only
    // carries explicit PostProcessParams components; without this bridge the
    // builtin motion-blur pass receives its all-zero registration default and
    // becomes a no-op even though the temporal scene target is populated.
    const framePostProcessParams = new Map(postProcessParams);
    // The negotiated surface color space is renderer state, not camera state: stamp the
    // effective output gamut into this frame's Output Transform parameters so a fallback
    // to sRGB never encodes P3 values into an sRGB surface.
    const outputGamut = OUTPUT_GAMUT_CODE[internals.outputColorSpace?.report.effective ?? 'srgb'];
    if (outputGamut !== 0) {
      const extractedTonemap = postProcessParams.get(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
      const tonemap = new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize);
      if (extractedTonemap !== undefined)
        tonemap.set(extractedTonemap.subarray(0, tonemap.byteLength));
      new DataView(tonemap.buffer).setUint32(
        TONEMAP_PARAMS_LAYOUT.outputGamutOffset,
        outputGamut,
        true,
      );
      framePostProcessParams.set(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, tonemap);
    }
    if (camera.motionBlur !== undefined) {
      if (motionBlurDemand) {
        const motionBlurParams = new Uint8Array(MOTION_BLUR_PARAMS_BYTE_SIZE);
        const motionBlurView = new DataView(motionBlurParams.buffer);
        const uniformDeltaSeconds = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
        motionBlurView.setFloat32(0, camera.motionBlur.shutterAngle, true);
        motionBlurView.setFloat32(4, camera.motionBlur.maxRadiusPixels, true);
        motionBlurView.setUint32(
          8,
          effectiveMotionBlurSampleCount(camera.motionBlur.sampleCount),
          true,
        );
        motionBlurView.setUint32(12, temporalView?.historyValid === true ? 0 : 1, true);
        motionBlurView.setFloat32(16, camera.motionBlur.targetFps ?? 60, true);
        motionBlurView.setFloat32(
          20,
          motionBlurExposureScale(uniformDeltaSeconds, camera.motionBlur.targetFps ?? 60),
          true,
        );
        motionBlurView.setFloat32(24, uniformDeltaSeconds, true);
        framePostProcessParams.set('forgeax.motion-blur', motionBlurParams);
      }
    }
    if (camera.depthOfField !== undefined) {
      const dofParams = packDepthOfFieldParams(camera.depthOfField, {
        outputHeight: targetH,
        near: camera.near,
        far: camera.far,
        useTemporalDepth: camera.antialias === 'taa' && temporalView !== undefined,
      });
      for (const id of [
        ...DEPTH_OF_FIELD_POST_PROCESS_IDS,
        ...DEPTH_OF_FIELD_MSAA_POST_PROCESS_IDS,
      ]) {
        framePostProcessParams.set(id, dofParams);
      }
    }
    if (
      camera.lensEffects !== undefined ||
      internals.getPostProcessParamsBuffer?.(LENS_EFFECTS_POST_PROCESS_ID) !== undefined
    ) {
      framePostProcessParams.set(
        LENS_EFFECTS_POST_PROCESS_ID,
        packLensEffectsParams(camera.lensEffects, frameState.frameNumber),
      );
    }
    if (camera.lensFlare !== undefined) {
      const lensFlareParams = packLensFlareParams(camera.lensFlare);
      for (const program of LENS_FLARE_PROGRAMS)
        framePostProcessParams.set(program.name, lensFlareParams);
    }
    if (submittedBarrelMapping !== undefined && submittedBarrelMapping.strength > 0) {
      framePostProcessParams.set(
        BARREL_DISTORTION_POST_PROCESS_ID,
        packBarrelDistortionParams(submittedBarrelMapping),
      );
    }

    if (preparedGpuDriven !== undefined) {
      frameState.surfaceSubmissionObservation?.setResourceGeneration(
        preparedGpuDriven.standardPbrFrameResources.resourceGeneration,
      );
    }
    const shadowRoster = {
      dispatch: sceneDispatch,
      validatedOrdered,
      materialSlotIndices,
      materialSlots,
      ...(shadowValidatedOrdered.length === 0 &&
      !gpuOwnsShadowGeometry &&
      directShadowValidated === undefined
        ? {}
        : { shadowValidatedOrdered }),
      ...(shadowDispatch === undefined ? {} : { shadowDispatch }),
    };
    const passCtx: _InternalRenderPipelineContext = {
      ...(camera.antialias === 'taa' || gpuDriven?.cameraVisible === undefined
        ? {}
        : { cameraVisible: gpuDriven.cameraVisible }),
      ...(scenePassWork === undefined ? {} : { scenePassWork }),
      pipelinePreparationEntries,
      mainPassMaterialSelection: createMainPassMaterialSelectionOwner({
        ...shadowRoster,
        materialSlots,
        materialSlotIndices,
      }),
      ...(frameGpuDriven === undefined
        ? {}
        : { gpuDrivenGeometryLane: frameGpuDriven.geometryLane ?? 'automatic' }),
      ...(visibleSurface === undefined ? {} : { visibleSurface }),
      ...(probePlacement === undefined ? {} : { probePlacement }),
      resourceScopes: worlds,
      assets: internals.assets,
      world,
      store: internals.gpuStore,
      pipelineState,
      bloomResources: pipelineState.perPassResources.getBloomResources?.() ?? null,
      runtime: internals,
      encoder,
      view,
      clear,
      targetW,
      targetH,
      ...(renderExtent === undefined ? {} : { extent: renderExtent }),
      currentTexture,
      camera: recordCamera,
      tonemapActive,
      geometryDepthKey,
      validatedOrdered,
      viewBindGroup,
      meshBindGroup,
      frameState,
      dispatchCounts,
      bindGroupCounts,
      skylight,
      skylightCount,
      skyboxActive,
      skybox,
      splitLdrSprite,
      msaaActive,
      postProcessParams: framePostProcessParams,
      ...(internals.volumetricFogShaders === undefined
        ? {}
        : { volumetricFogShaders: internals.volumetricFogShaders }),
      ...(internals.ssrShaders === undefined ? {} : { ssrShaders: internals.ssrShaders }),
      ...(internals.depthPyramidShaders === undefined
        ? {}
        : { depthPyramidShaders: internals.depthPyramidShaders }),
      ...(internals.atmosphereShaders === undefined
        ? {}
        : { atmosphereShaders: internals.atmosphereShaders }),
      ...(activeVolumetricFogContext === undefined
        ? {}
        : {
            volumetricFog: {
              ...activeVolumetricFogContext,
              compositeProjectedBounds:
                camera.captureProjection === undefined &&
                camera.target === undefined &&
                camera.view === undefined &&
                graphVolumetricFog?.status === 'available' &&
                graphVolumetricFog.fog !== undefined &&
                (graphVolumetricFog.additional ?? []).every(
                  (member) => member.status === 'available' && member.fog !== undefined,
                )
                  ? projectVolumeCompositeBounds(
                      [
                        graphVolumetricFog.fog.bounds,
                        ...(graphVolumetricFog.additional ?? []).flatMap((member) =>
                          member.fog === undefined ? [] : [member.fog.bounds],
                        ),
                      ],
                      currentUnjitteredViewProjection,
                      camera.position,
                    )
                  : undefined,
            },
          }),
      ...(preparedSpotLightProjector === undefined
        ? {}
        : { spotLightProjector: preparedSpotLightProjector }),
      dispatch: sceneDispatch,
      hdrpClusterBindGroup,
      hdrpClusterMembershipBindGroup,
      standardLighting: standard,
      foldDispatchPlan,
      materialSlotIndices,
      materialSlots,
      materialBindings: dispatchPlan.materialBindings,
      materialSlotCount,
      ...(preparedGpuDriven === undefined
        ? {}
        : {
            gpuDrivenStandardPbrFrameResources: {
              ...preparedGpuDriven.standardPbrFrameResources,
              ...(frameState.surfaceSubmissionObservation === undefined
                ? {}
                : { surfaceSubmissionObservation: frameState.surfaceSubmissionObservation }),
            },
            ...(rasterGpuDriven === undefined
              ? {}
              : {
                  gpuDrivenSelection: gpuSelection,
                  ...(acceptedShadowMaterialArtifacts === undefined
                    ? {}
                    : { gpuDrivenShadowPreparationArtifacts: acceptedShadowMaterialArtifacts }),
                  gpuDrivenShadowViews: rasterGpuDriven.shadowViewPool,
                  shadowDirectRequired: rasterGpuDriven.shadowDirectRequired,
                  gpuDrivenShadowBatchProjections: rasterGpuDriven.shadowBatchProjections,
                }),
          }),
      shadowViewPlanesByView: shadowPlanesByView(),
      materialFrame: fixedMaterials,
      ...(frameGpuDriven?.scene?.slotForEntity === undefined
        ? {}
        : { shadowSlotForEntity: frameGpuDriven.scene.slotForEntity }),
      ...(shadowCasterProjection === undefined
        ? {}
        : { shadowCasterBounds: shadowCasterProjection.worldBoundsOf }),
      ...(frameGpuDriven?.scene === undefined
        ? {}
        : { gpuDrivenSceneMaterialBuffer: frameGpuDriven.scene.scene.materialBuffer }),
      ...(cubeCapture?.reflectionProbes === undefined
        ? {}
        : { reflectionProbes: cubeCapture.reflectionProbes }),
      ...(cubeCapture?.captureDispatch === undefined
        ? {}
        : { captureDispatch: cubeCapture.captureDispatch }),
      ...(planarCapture === undefined
        ? {}
        : { planarReflectionView: planarCapture.physical.resolveView }),
      pointsLines: pointsLinesOwner,
      materialBgAssemblyCache: frameState.materialBgAssemblyCache,
      ...(onRenderableDraw === undefined ? {} : { onRenderableDraw }),
      shadowUpdatePolicy: (identity) =>
        shadowUpdatePolicy(
          identity,
          lights,
          worlds,
          effectiveShadowMapSize,
          effectiveSpotShadowMapSize,
          frameState.pointShadowAtlas?.getTexture() ?? undefined,
        ),
      directionalShadowCacheMiss: directionalShadowCache.miss,
      ...(cascadeCadence?.cascadeMiss === undefined
        ? {}
        : { directionalShadowCascadeMiss: cascadeCadence.cascadeMiss }),
      capsuleShadowDirectional,
      ...(capsuleShadowLight === undefined ? {} : { capsuleShadowLight }),
      ...(shadowValidatedOrdered.length === 0 &&
      !gpuOwnsShadowGeometry &&
      directShadowValidated === undefined
        ? {}
        : { shadowValidatedOrdered, shadowMaterialRowBase }),
      ...(shadowDispatch === undefined ? {} : { shadowDispatch }),
      ...(shadowCasterWorldKeys === undefined ? {} : { shadowCasterWorldKeys }),
      ...(profilePhase !== undefined ? { profilePhase } : {}),
    };
    frameState.candidatePipelinePreparations?.process(passCtx, hasShadowViews);
    if (
      frameState.compiledFrameGraph?.graph === preflightGraph &&
      frameState.compiledFrameGraph.prepareGpuDrivenPipelines?.(
        passCtx.pipelinePreparationEntries,
        acceptedMaterialArtifacts,
        (reason) => {
          frameState.pipelinePreparationPendingReason ??= Object.freeze(reason);
        },
        fixedMaterials,
      ) === false
    ) {
      markPipelinePreparationPending(frameState, { code: 'scene-pipeline-preparation' });
    }
    if (hasShadowViews)
      prepareShadowMaterialPipelines(
        passCtx,
        rendererRecording,
        frameState.compiledFrameGraph?.graph === preflightGraph
          ? frameState.compiledFrameGraph.requiresShadowPipelinePreparation
          : undefined,
      );
    if (frameState.pipelinePreparationPending) {
      // Required authored depth PSOs are still compiling. Submit the ordinary
      // completion barrier, but do not encode a partial atlas or promote scene,
      // shadow-cache, capture, or temporal-history state as a rendered picture.
      const pending = yield* recordPreparationBarrier(internals, encoder);
      abortPreparedGpuDriven();
      featureGraphCandidate?.onRejected?.();
      return pending;
    }
    {
      const timing = internals.gpuPassTimingCapture;
      for (const capture of [...captureFrames, ...probeCaptureFrames]) {
        writeViewUbo(
          internals.device.queue,
          capture.pipeline.viewUniformBuffer,
          capture.work.faceCamera,
          capture.lights.directional ?? light,
          capture.lights,
          frameState.spotShadowSnapshots,
          0,
          preparedSpotLightProjector?.spotIndex,
          cloudShadowProjection,
          capture.frameState.environmentFrame?.fog,
          capture.capturedAtmosphere?.environment.source.kind === 'atmosphere'
            ? capture.capturedAtmosphere.environment.source.atmosphere
            : undefined,
          capture.work.sceneInput !== true,
          clock.elapsedSeconds,
          capture.viewport,
        );
        const groups = buildPerFrameBindGroups(
          capture.runtime,
          capture.frameState,
          capture.pipeline,
          validatedOrdered.length > 0 || shadowValidatedOrdered.length > 0,
          bindGroupCounts,
          undefined,
          true,
          capture.lighting,
        );
        const context = {
          ...passCtx,
          ...groups,
          runtime: capture.runtime,
          capturedAtmosphere: capture.capturedAtmosphere,
          pipelineState: capture.pipeline,
          camera: capture.work.faceCamera,
          shadowViewPlanesByView: shadowViewPlanesByView(capture.lights),
          frameState: capture.frameState,
          standardLighting: capture.lighting,
        };
        delete context.gpuDrivenShadowViews;
        delete context.cameraVisible;
        delete context.shadowDirectRequired;
        delete context.directionalShadowCascadeMiss;
        delete context.gpuDrivenShadowBatchProjections;
        const executed = capture.graph.execute(
          context,
          undefined,
          timing === undefined ? undefined : createPassTimingInstrumentation(timing),
        );
        if (!executed.ok) throw executed.error;
        flushMeshDrawUploads(internals.device.queue, capture.pipeline.meshStorageBuffer);
        const publishCapture = capture.frameState.pendingAtmospherePublish;
        if (publishCapture !== undefined) stageAtmospherePublish(frameState, publishCapture);
        internals.framePassNames?.push(...capture.graph.inspect().passes.map((pass) => pass.name));
      }
    }
    if ((cubeCapture?.sceneInputs?.length ?? 0) > 0) {
      const ready = yield { kind: 'scene-inputs' as const, encoder };
      if (!ready.ok) return false;
    }
    if (captureOnly) {
      internals.encodeRenderTargetReadbacks?.(
        encoder,
        cubeCaptureWork.map((work) => ({ target: work.target, layer: work.layer })),
      );
      const result = yield {
        encoder,
        device: internals.device,
        beforeSubmit: internals.beforeSubmit,
        ...(nativeScene?.retained === undefined
          ? {}
          : {
              isCurrent: () => nativeScene.retained?.isSourceCurrent() === true,
            }),
        onSubmittedWork: (done: Promise<void>) => {
          gpuDriven?.onSubmittedWork?.(done);
          preparedGpuDriven?._trackSubmittedWork(done);
        },
        reportError: (error: import('@forgeax/engine-rhi').RhiError) =>
          internals.errorRegistry.fire(error),
      };
      submitted = result.ok;
      frameState.frameOutputs.sceneSubmitted =
        submitted && (captureFrames.length > 0 || probeCaptureFrames.length > 0);
      settleAtmospherePublish(frameState, submitted);
      if (submitted)
        for (const capture of captureFrames)
          internals.markRenderTargetSubmitted?.(capture.work.target, capture.work.physical);
      if (submitted && (captureFrames.length > 0 || probeCaptureFrames.length > 0))
        captureCompletion =
          internals.gpuPassTimingSubmittedWork ?? internals.device.queue.onSubmittedWorkDone();
      return submitted;
    }
    const fallbackReadbackRequest =
      internals.captureReflectionFallbackReadback === true
        ? createReflectionFallbackReadbackRequest(internals, frameState)
        : undefined;
    if (fallbackReadbackRequest !== undefined) {
      frameState.reflectionFallbackReadback = fallbackReadbackRequest;
    }
    const stagedTemporalFrame = {
      frameId: frameState.frameNumber,
      currentViewProjection: new Float32Array(currentViewProjection),
      jitter: [0, 0] as [number, number],
      viewport: { width: targetW, height: targetH },
      cameraPosition: [
        camera.position[0] ?? 0,
        camera.position[1] ?? 0,
        camera.position[2] ?? 0,
      ] as [number, number, number],
    };
    frameState.temporalFrameTransaction.stage(stagedTemporalFrame);
    volumeSubmissionAttempted = volumeTopologyCandidate || activeVolumetricFogContext !== undefined;
    const ssrOwner = frameState.ssrHistoryOwner;
    const ssrCandidate = ssrOwner?.candidate;
    // Preparation precedes graph compilation. Accept the submitted stock graph's
    // generation with its depth, rather than invalidating it again next frame.
    const submittedShadowGraphGeneration =
      rendererRecording &&
      !captureOnly &&
      frameState.activePipeline === standardPipeline &&
      frameState.compiledFrameGraph?.graph === preflightGraph
        ? frameState.graphGeneration
        : undefined;
    // Skin history/task buffers track accepted submissions independently of other owners.
    const frameHooks =
      gpuDriven?.onSubmittedWork === undefined &&
      preparedGpuDriven === undefined &&
      ssrCandidate === undefined &&
      rayDiffuse === undefined &&
      irradianceField === undefined &&
      bakedField === undefined &&
      screenProbe === undefined &&
      probePlacement === undefined &&
      shadowPublication === undefined &&
      pointsLinesOwner === undefined &&
      nativeScene?.retained === undefined &&
      shadowMeshInput === undefined
        ? undefined
        : {
            generationFence: {
              capturedGeneration: 0,
              currentGeneration: () =>
                [
                  rayDiffuse?.fence,
                  irradianceField?.fence,
                  bakedField?.fence,
                  screenProbe?.fence,
                  probePlacement?.fence,
                ].every(
                  (fence) =>
                    fence === undefined || fence.currentGeneration() === fence.capturedGeneration,
                ) &&
                (shadowPublication === undefined || shadowPublication.isCurrent()) &&
                (nativeScene?.retained === undefined || nativeScene.retained.isSourceCurrent()) &&
                (shadowMeshInput === undefined ||
                  (shadowMeshInputCurrent(shadowMeshInput) &&
                    frameState.directionalShadowLod?.token === shadowLodToken))
                  ? 0
                  : -1,
            },
            onSubmittedWork: (done: Promise<void>) => {
              gpuDriven?.onSubmittedWork?.(done);
              preparedGpuDriven?._trackSubmittedWork(done);
              pointsLinesOwner?.track(done);
              probePlacement?.track(done);
              rayDiffuse?.track(done);
              irradianceField?.track(done);
              bakedField?.track(done);
              screenProbe?.track(done);
            },
            onSubmitted: () => {
              probePlacement?.commit();
              rayDiffuse?.commit();
              irradianceField?.commit();
              bakedField?.commit();
              screenProbe?.commit();
              if (ssrOwner !== undefined && ssrCandidate !== undefined) {
                const committed = ssrOwner.commitFrame(ssrCandidate);
                if (!committed.ok) {
                  ssrOwner.abortFrame(ssrCandidate, 'submit');
                  reportSsrHistoryFailure(internals, 'submit', committed.error);
                }
              }
              preparedGpuDriven?._commitResourceReplacement(submittedShadowGraphGeneration);
              const consumed = preparedGpuDriven?._consumeSurfaceDynamicInput?.(
                frameState.frameNumber,
              );
              if (consumed !== undefined && !consumed.ok) {
                internals.errorRegistry.fire(consumed.error);
              }
            },
            onAborted: () => {
              probePlacement?.abort();
              if (ssrOwner !== undefined && ssrCandidate !== undefined) {
                ssrOwner.abortFrame(ssrCandidate, 'submit');
              }
              preparedGpuDriven?._abortResourceReplacement?.();
            },
          };
    // Reuse an existing timing owner. Otherwise allocate only for this ready
    // frame, with at most one DRS readback outstanding across view changes.
    const sampleResolution = resolution.needsSample;
    if (
      sampleResolution &&
      timingCapture === undefined &&
      (internals.gpuPassTimingSession === undefined ||
        internals.gpuPassTimingFrameIdentity === undefined)
    ) {
      const created = GpuTimingCapture.create(internals.device);
      if (created.ok) resolutionTiming = created.value;
    }
    if (internals.shadowWorkload === true && internals.observationFrameId !== undefined) {
      rasterGpuDriven?.shadowViewPool?._setTelemetrySubmit({
        frameId: internals.observationFrameId,
        deviceGeneration: internals.deviceScope.generation,
        graphGeneration: frameState.graphGeneration,
      });
    }
    frameState.shadowRaster.begin(internals.shadowWorkload === true, internals.observationFrameId);
    submitted = yield* profileFrameRecording(
      recordCompiledFrameGraph(
        internals,
        frameState,
        passCtx,
        encoder,
        profilePhase === undefined
          ? undefined
          : (pass, encode) => profilePhase(graphExecutionPhase(pass.name), encode),
        frameHooks,
        cubeCaptureWork.length === 0
          ? undefined
          : cubeCaptureWork.map((work) => ({ target: work.target, layer: work.layer })),
        (done) => {
          completion = done;
          frameState.surfaceSubmissionObservation?.submit(done, frameState.graphGeneration);
          if (fallbackReadbackRequest !== undefined) {
            fallbackReadback = done.then(
              () =>
                mapReflectionFallbackReadback(
                  internals,
                  fallbackReadbackRequest,
                  cubeCapture?.reflectionProbes?.fallbackHasNonNeutral !== true,
                ),
              (cause) => {
                internals.device.destroyBuffer(fallbackReadbackRequest.buffer);
                throw cause;
              },
            );
          }
        },
        timingCapture ?? resolutionTiming,
      ),
      (action) => runRecordProfilePhase(profilePhase, 'record/graph-execute', action),
    );
    if (submitted) {
      frameState.frameOutputs.sceneSubmitted = true;
      for (const capture of captureFrames)
        internals.markRenderTargetSubmitted?.(capture.work.target, capture.work.physical);
      captureCompletion = completion;
      resolution.commit(renderExtent, gpuDriven?.visibleRasterRows ?? renderables.length);
      if (sampleResolution) {
        const passCapture = internals.gpuPassTimingCapture;
        const observation =
          passCapture !== undefined
            ? passCapture
                .observe()
                .then((result) =>
                  result.ok
                    ? gpuPassFrameMilliseconds(result.value, internals.gpuPassTimingViewId)
                    : undefined,
                )
            : (timingCapture ?? resolutionTiming)
                ?.observation()
                .then((result) => (result.status === 'ready' ? result.frameMs : undefined));
        resolution.observe(observation ?? Promise.resolve(undefined));
      }
    }
    if (submitted && onRenderableDraw !== undefined && frameGpuDriven !== undefined) {
      const summary = emitGpuDrivenDrawReceipts(renderables, gpuSelection, onRenderableDraw);
      frameGpuDriven.owner.recordDrawSummary(summary);
    }
    if (submitted) {
      // `ensureCompiledFrameGraph` can deliberately return the accepted LKG
      // while a topology candidate is still preparing. The submitted graph is
      // the picture authority: an identity frame publishes an identity
      // mapping, while a failed enable/disable candidate retains the previous
      // mapping together with its old picture. Never pair an LKG graph with
      // the live RenderResourceScope's newer camera component.
      // The exact mapping used to populate the accepted graph's UBO is the
      // only mapping promoted with its receipt. This keeps an identity frame,
      // a retained barrel LKG and a normal nonzero frame on one context.
      if (submittedBarrelMapping !== undefined) {
        frameState.lastSuccessfulBarrelDistortion = submittedBarrelMapping;
      }
      // Feature plans are submission-sensitive: VFX keeps queued fixed ticks
      // until the graph that consumed them is actually submitted. Acknowledge
      // the exact accepted graph here so successful frames do not replay every
      // prior tick into the next topology.
    }
    if (!submitted && fallbackReadbackRequest !== undefined) {
      internals.device.destroyBuffer(fallbackReadbackRequest.buffer);
    }
    if (submitted) {
      frameState.shadowRaster.commit();
      frameState.shadowDepthLayers?._commit();
      frameState.directionalShadowProjection = lights.lightViewProj;
      frameState.directionalCascadeCadence = cascadeCadence?.next ?? undefined;
    }
    if (submitted) {
      const previous = frameState.directionalShadowCache;
      const next =
        directionalShadowCache.miss !== undefined
          ? frameState.directionalShadowCacheRecorded
            ? directionalShadowCache.next
            : null
          : (directionalShadowCache.next ?? previous);
      if (next !== previous) {
        frameState.directionalShadowCache = next;
        // Transfer this candidate's lease only to accepted depth; hits with the
        // same header merely release their temporary borrower in finally.
        if (next !== null) shadowMeshLease = undefined;
        previous?.meshReads.release();
      }
    }
    if (submitted) {
      frameState.recoveryMaterialArtifacts = acceptedMaterialArtifacts;
      frameState.recoveryShadowMaterialArtifacts = acceptedShadowMaterialArtifacts;
      if (graphVolumetricFog === undefined) {
        // A valid offscreen view is an actual no-volume submission, not an
        // upload failure. Retain only the previously accepted source/resources
        // for degraded-authoring LKG; never replay that projection offscreen.
        // Genuine component removal still retires everything normally.
        if (!volumeViewCulled) {
          frameState.volumetricFogAccepted = undefined;
          frameState.volumetricFogAcceptedContext = undefined;
          retireVolumetricFogParams(internals, frameState);
        }
        frameState.volumetricFogHistoryGraph = null;
        frameState.volumetricFogHistorySlot = null;
        frameState.volumetricFogHistorySignature = null;
      } else if (
        activeVolumetricFogContext !== undefined &&
        activeVolumetricFogSignature !== undefined
      ) {
        // Temporal history is graph-owned state. Promote the write slot only
        // after queue submission succeeds; a failed candidate keeps the
        // accepted graph/context/slot and retries into the same pending slot.
        frameState.volumetricFogHistoryGraph = preflightGraph;
        frameState.volumetricFogHistorySlot = activeVolumetricFogContext.historyWriteSlot;
        frameState.volumetricFogHistorySignature = activeVolumetricFogSignature;
        promoteVolumetricFogParams(frameState.volumetricFogParams);
        if (volumetricFog?.status === 'available' && preparedVolumetricFog !== undefined) {
          frameState.volumetricFogAccepted = volumetricFog;
          frameState.volumetricFogAcceptedContext = activeVolumetricFogContext;
        } else if (acceptedFallback !== undefined) {
          // The current authored source is degraded, so keep the old accepted
          // POD while advancing the LKG graph's ping-pong slot.
          frameState.volumetricFogAcceptedContext = activeVolumetricFogContext;
        }
      } else if (volumetricFog?.status === 'available' && preparedVolumetricFog !== undefined) {
        // Defensive fallback for a volume graph that was accepted before the
        // temporal context could be resolved; do not manufacture history.
        frameState.volumetricFogAccepted = volumetricFog;
        frameState.volumetricFogAcceptedContext = preparedVolumetricFog;
      }
      frameState.submittedInspection = {
        standardLighting: inspectStandardLighting(standard),
        pointShadow: inspectPointShadow(lights.pointShadow, SHADOW_ATLAS_DEFAULT_LAYERS),
        transparency: captureOnly ? undefined : transparencyView.inspection,
        capsuleShadow: inspectCapsuleShadow(
          shadowCasterProjection?.renderables ?? renderables,
          passCtx.materialFrame,
          capsuleShadowDirectional,
          lights.directionalShadowQuality !== undefined,
          frameState.capsuleShadowSubmission,
          internals.demandCapsuleShadow ?? (() => undefined),
        ),
      };
    }
    return submitted;
  } finally {
    shadowMeshLease?.reads.release();
    if (!submitted) frameState.shadowDepthLayers?._abort();
    // Every successful preparation ends, including capture-only and thrown setup paths.
    // Submitted captures may borrow scene tables without publishing display/shadow caches.
    preparedGpuDriven?._abortResourceReplacement?.();
    // Probe tickets belong to this recording attempt, including native
    // preparation barriers which return before queue submission.
    const fallbackSource =
      frameState.reflectionFallbackObservationSource as RenderFrameState['reflectionFallbackObservationSource'];
    const reflectionFallbackCompletion = cubeCapture?.reflectionProbes?.completeSubmission(
      submitted,
      completion ?? captureCompletion,
      fallbackSource === undefined
        ? undefined
        : {
            format: fallbackSource.descriptor.format,
            size: fallbackSource.descriptor.size,
            frameId: fallbackSource.frameId,
            graphGeneration: frameState.graphGeneration,
            textureIdentity: getTextureIdentity(fallbackSource.texture),
            ...(fallbackReadback === undefined ? {} : { readback: fallbackReadback }),
          },
      frameState.reflectionFallbackDemand,
    );
    frameState.reflectionFallbackCompletion = reflectionFallbackCompletion;
    frameState.reflectionFallbackObservationSource = undefined;
    frameState.probePlacementFrame?.abort();
    frameState.probePlacementFrame = undefined;
    cubeCapture?.state.planar?.submit(submitted, captureCompletion);
    for (const capture of [...captureFrames, ...probeCaptureFrames]) {
      if (captureCompletion === undefined) void capture.graph.retire();
      else
        void captureCompletion.then(
          () => capture.graph.retire(),
          () => capture.graph.retire(),
        );
    }
    if (!submitted) resolutionTiming?.discard();
    const ssrOwnerAtSettle = frameState.ssrHistoryOwner;
    const ssrPending = ssrOwnerAtSettle?.candidate;
    if (!submitted && ssrPending !== undefined) ssrOwnerAtSettle?.abortFrame(ssrPending, 'submit');
    // Output, DoF, and volume topology replacements are provisional until the
    // queue submission succeeds. This runs for every early-return path as
    // well, so a swapchain, encoder, or graph failure cannot leave a
    // non-submitted candidate as the next frame's accepted graph.
    settleCompiledFrameGraphCandidate(frameState, submitted);
    if (volumeInspectionReady && (submitted || volumeSubmissionAttempted)) {
      updateVolumetricFogInspection(
        frameState,
        viewVolumetricFogForInspection,
        lights,
        preparedVolumetricFogForInspection,
        submitted,
        volumeCapabilityForInspection,
        volumeSubmissionAttempted,
      );
    }
    frameState.frameNumber += 1;
    // feat-20260608-cluster-lighting M5 / w22: clear Standard once-per-frame fired
    // set so the next frame re-fires if the condition persists.
    frameState.standardOncePerFrameFired.clear();
  }
}
