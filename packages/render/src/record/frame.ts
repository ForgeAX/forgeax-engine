import { halfFloat } from '@forgeax/engine-math';
import { textureReadbackLayout } from '@forgeax/engine-rhi';
import {
  type FrameRecording,
  profileFrameRecording,
  recordPreparationBarrier,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import { capsuleConeHalfAngle } from '../capsule-shadow/frame';
import { inspectCapsuleShadow } from '../capsule-shadow/inspection';
import { PlanarCaptureState } from '../capture/planar-state';
import { PlanarReflectionInvalidError } from '../components/planar-reflection';
import { RenderTargetLayerInvalidError } from '../errors/render';
import type { FogFrame } from '../extract/environment';
import { EMPTY_GPU_DRAW_SELECTION } from '../gpu-driven/draw-selection';
import { EMPTY_MATERIAL_BINDINGS } from '../gpu-driven/material-bindings';
import { resolveTransparencyView } from '../oit/view';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import { ShadowMaterialContent } from '../scene/material-shadow-content';
import type { GpuRasterOwnership } from '../scene/render-scene';
import type { SubsurfaceDemand } from '../subsurface/selection';
import { renderTargetLayerCount } from '../targets/contracts';
import { cpuLaneLodRows } from './cpu-lod';
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
import { materialGeometry } from './material-geometry';
import { gpuDrivenMeshesForFrame, querySceneExecution } from './resident-meshes';
import { prepareScenePasses, scenePassRequests } from './scene-pass-work';
import { shadowViewPlanesByView } from './shadow-culling';
import { prepareShadowMaterialPipelines } from './shadow-pass';
import { shadowUpdatePolicy } from './shadow-update-policy';
import { disposeTargetCaptureLighting } from './target-capture-lighting';
import { PLANAR_REFLECTION_UNIFORM_OFFSET } from './view-ubo';
// @forgeax/engine-runtime - RenderSystem record stage: frame.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

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
import { isTimestampQueryAdmitted } from '../assembly/device-feature-admission';
import type { ExtractedCloudLayer } from '../cloud/extract';
import { cloudShadowResolutionForQuality } from '../cloud/parameters';
import { type CloudShadowProjection, createCloudShadowProjection } from '../cloud/shadow';
import { CUBE_CAMERA_FACE_ORDER } from '../components/cube-camera';
import type { MeshGpuHandles } from '../device/gpu-residency';
import {
  ObservationUnavailableError,
  type ObservationUnavailableReason,
  RendererOperationError,
} from '../errors/render';
import type { GpuDrivenProduction, PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { type GpuDrivenLodSubmitIdentity, selectGpuLodLane } from '../gpu-driven/view-gpu';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { DynamicResolutionController } from '../pipeline/dynamic-resolution';
import { inspectStandardLighting } from '../pipeline/standard-lighting/inspection';
import { standardLightingTopologySignature } from '../pipeline/standard-lighting/topology';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { inspectPointShadow } from '../point-shadow-inspection';
import type {
  CameraSnapshot,
  SpotLightProjectorFrameContext,
  VolumetricFogFrameContext,
} from '../render-contract';
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
import type { SsrDependenciesInspection, SsrSpatialAdmission } from '../ssr/admission';
import { createSsrHistoryOwner } from '../ssr/history';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import { terrainShadowReceivers } from '../terrain/shadow-family';
import type { TransmissionDemand } from '../transmission/projection';
import { hasVolumetricFogCapability } from '../volume/capability';
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
  type ValidatedRenderable,
  validateGraphTargetCaptureReadback,
} from './frame-snapshot';
import { emitGpuDrivenDrawReceipts, type RenderableDrawReceipt } from './gpu-draw-receipts';
import {
  type _InternalRenderPipelineContext,
  type PipelineState,
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

import type { RenderExtent } from '../pipeline/render-extent';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import type { TemporalView } from '../temporal/view';
import { inspectVolumetricFog } from '../volume/inspection';
import { resolveSubmittedBarrelMapping } from './barrel-distortion-frame';
import {
  admitFramePipeline,
  admitFrameSsr,
  assertProbePlacementSingleView,
  hasCubeCaptureViews,
  hasReflectionFallbackCandidate,
  isFixedShadowDomain,
  prepareDeferredProbeBuffer,
  projectFrameVisibleSurface,
  resetFrameAttemptOutputs,
  resolveFrameMaterials,
  resolveFrameSubsurface,
  resolveRecordCamera,
  shouldDeferImageDisplay,
} from './frame-admission';
import {
  type CubeCaptureFrame,
  compileCaptureFrames,
  executeCaptureFrames,
  type ProbeCaptureFrame,
} from './frame-capture';
import { prepareFrameDiffuseGi, reprojectDiffuseGiHistory } from './frame-diffuse-gi';
import {
  collectDirectShadowMaterials,
  collectFrameGpuDrivenArtifacts,
  collectGpuShadowMaterials,
  gpuDrivenPrepareRequest,
  gpuLaneDirectShadowRows,
  gpuProbeBlendBufferFor,
  prepareGpuDrivenOwner,
  validateDirectShadowRows,
} from './frame-gpu-driven';
import {
  capturePassContext,
  commitSubmittedDisplay,
  commitSubmittedShadows,
  frameSubmissionHooks,
  gpuDrivenPassContext,
  promoteDirectionalShadowCache,
  scenePassInputs,
  shaderSourcePassContext,
  shadowPassContext,
  submitCaptureOnlyFrame,
  volumetricFogPassContext,
} from './frame-submission';
import {
  acquireSwapChainTarget,
  graphExecutionPhase,
  hasShadowViewDemand,
  resolveShadowMapSize,
  resolveSpotShadowMapSize,
} from './frame-targets';
import {
  buildFramePostProcessParams,
  frameClockSample,
  resolveFrameTemporal,
} from './frame-temporal';
import { GpuTimingCapture } from './gpu-timing';
import {
  computeProjectionMatrix,
  computeViewMatrix,
  driveLazyEquirectProjection,
  selectLazyEquirectHandles,
  warnMultiSkybox,
  warnMultiSkylight,
} from './helpers';
import { createMainPassMaterialSelectionOwner } from './main-pass';
import { computeSplitLdrSprite } from './main-pass-sprite-draws';
import { writeShadowCasterUniforms } from './shadow-pass';
import {
  type CubeCaptureGraphState,
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

function volumetricFogResourceFacts(frameState: RenderFrameState) {
  return frameState.compiledFrameGraph === undefined || frameState.compiledFrameGraph === null
    ? undefined
    : inspectVolumetricFogResources(frameState.compiledFrameGraph.graph.inspect(), {
        parameterBufferCount: frameState.volumetricFogParams.buffers.filter(
          (buffer) => buffer !== null,
        ).length,
      });
}

type VolumeResourceFacts = ReturnType<typeof volumetricFogResourceFacts>;

/** The last accepted volume projection, completed with its inspected resource facts. */
function acceptedVolumetricFogLkg(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog | undefined,
  resourceFacts: VolumeResourceFacts,
) {
  const previous = frameState.volumetricFogInspection;
  const accepted = frameState.volumetricFogAccepted;
  if (accepted === undefined) return undefined;
  return {
    guid: accepted.guid ?? previous.guid,
    generation: accepted.generation ?? previous.generation,
    digest: accepted.digest ?? previous.digest,
    deviceEpoch: previous.deviceEpoch,
    format: previous.format ?? accepted.densityAsset?.format ?? fog?.densityAsset?.format,
    passCount: previous.passCount > 0 ? previous.passCount : VOLUMETRIC_FOG_PASS_COUNT,
    sampleCount:
      previous.sampleCount > 0 ? previous.sampleCount : (resourceFacts?.sampleCount ?? 0),
    memoryBytes: previous.memoryBytes > 0 ? previous.memoryBytes : (resourceFacts?.totalBytes ?? 0),
    resourceFacts: previous.resourceFacts ?? resourceFacts,
    lightEntity: accepted.lightEntity,
    lightKind: accepted.lightKind,
    pointLightEntity: accepted.pointLightEntity,
    spotLightEntity: accepted.spotLightEntity,
    projector: accepted.projector,
  };
}

type AcceptedVolumetricFogLkg = NonNullable<ReturnType<typeof acceptedVolumetricFogLkg>>;

function volumeCandidateIdentity(fog: ExtractedVolumetricFog | undefined) {
  return fog?.guid === undefined || fog.generation === undefined
    ? undefined
    : { guid: fog.guid, generation: fog.generation, digest: fog.digest };
}

type VolumeCandidateIdentity = ReturnType<typeof volumeCandidateIdentity>;

function selectedVolumeLightAvailable(
  fog: ExtractedVolumetricFog,
  lights: ExtractedLights,
): boolean {
  if (fog.lightKind === 'spot')
    return lights.spot.some((light) => light.entity === fog.lightEntity);
  if (fog.lightKind === 'point') {
    return (
      lights.point.some((light) => light.entity === (fog.pointLightEntity ?? fog.lightEntity)) &&
      (fog.spotLightEntity === undefined ||
        lights.spot.some((light) => light.entity === fog.spotLightEntity))
    );
  }
  if (fog.lightKind === 'directional') return lights.directional?.entity === fog.lightEntity;
  return lights.directional !== undefined;
}

function volumeLightingCapability(
  volumeCapability: boolean,
  fog: ExtractedVolumetricFog,
  lights: ExtractedLights,
): 'available' | 'unavailable' {
  return volumeCapability && selectedVolumeLightAvailable(fog, lights)
    ? 'available'
    : 'unavailable';
}

function candidateRecoveryFields(candidate: VolumeCandidateIdentity) {
  if (candidate === undefined) return {};
  return {
    candidateGeneration: candidate.generation,
    ...(candidate.digest === undefined ? {} : { candidateDigest: candidate.digest }),
  };
}

function acceptedVolumeSelectedLight(lkg: AcceptedVolumetricFogLkg) {
  if (lkg.lightEntity === undefined || lkg.lightKind === undefined) return {};
  return {
    selectedLight: {
      entity: lkg.lightEntity,
      kind: lkg.lightKind,
      revision: 0,
      shadowTile: -1,
      ...(lkg.pointLightEntity === undefined ? {} : { pointLightEntity: lkg.pointLightEntity }),
      ...(lkg.spotLightEntity === undefined ? {} : { spotLightEntity: lkg.spotLightEntity }),
      ...(lkg.projector === undefined ? {} : { projector: lkg.projector }),
    },
  };
}

/** Project the last accepted volume (LKG); false when no accepted identity exists. */
function inspectAcceptedVolume(
  frameState: RenderFrameState,
  lkg: AcceptedVolumetricFogLkg | undefined,
  candidate: VolumeCandidateIdentity,
  status: 'accepted' | 'degraded',
  candidateFailure?: 'submit-failed',
): boolean {
  if (lkg === undefined || lkg.guid === undefined || lkg.generation === undefined) return false;
  const recovery = {
    guid: lkg.guid,
    generation: lkg.generation,
    deviceEpoch: lkg.deviceEpoch,
    status,
    ...(status === 'degraded' ? { lkgGeneration: lkg.generation } : {}),
    ...candidateRecoveryFields(candidate),
    ...acceptedVolumeSelectedLight(lkg),
    ...(candidateFailure === undefined ? {} : { candidateFailure }),
  } satisfies import('../volume/recovery').VolumeRecoveryState;
  frameState.volumetricFogInspection = inspectVolumetricFog({
    authored: true,
    capability: 'available',
    degraded: status === 'degraded',
    recovery,
    ...(lkg.digest === undefined ? {} : { acceptedDigest: lkg.digest }),
    ...(lkg.format === undefined ? {} : { format: lkg.format }),
    passCount: lkg.passCount,
    sampleCount: lkg.sampleCount,
    memoryBytes: lkg.memoryBytes,
    ...(lkg.resourceFacts === undefined ? {} : { resourceFacts: lkg.resourceFacts }),
  });
  return true;
}

function submittedVolumeSelectedLight(fog: ExtractedVolumetricFog, lights: ExtractedLights) {
  if (fog.lightEntity === undefined || fog.lightKind === undefined) return {};
  return {
    selectedLight: {
      entity: fog.lightEntity,
      kind: fog.lightKind,
      revision: 0,
      shadowTile:
        lights.spot.find((spot) => spot.entity === fog.spotLightEntity)?.shadowAtlasTile ??
        lights.spot.find((spot) => spot.entity === fog.lightEntity)?.shadowAtlasTile ??
        -1,
      ...(fog.pointLightEntity === undefined ? {} : { pointLightEntity: fog.pointLightEntity }),
      ...(fog.spotLightEntity === undefined ? {} : { spotLightEntity: fog.spotLightEntity }),
      ...(fog.projector === undefined ? {} : { projector: fog.projector }),
    },
  };
}

/**
 * A successfully submitted available candidate is the only path that may
 * become the new accepted projection.
 */
function inspectSubmittedVolume(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog,
  lights: ExtractedLights,
  candidate: VolumeCandidateIdentity,
  resourceFacts: VolumeResourceFacts,
) {
  const recovery =
    candidate === undefined
      ? undefined
      : {
          guid: candidate.guid,
          generation: candidate.generation,
          deviceEpoch: frameState.volumetricFogInspection.deviceEpoch,
          status: 'accepted' as const,
          ...submittedVolumeSelectedLight(fog, lights),
        };
  return inspectVolumetricFog({
    authored: true,
    capability: 'available',
    ...(recovery === undefined ? {} : { recovery }),
    ...(candidate?.digest === undefined ? {} : { acceptedDigest: candidate.digest }),
    ...(fog.densityAsset?.format === undefined ? {} : { format: fog.densityAsset.format }),
    passCount: VOLUMETRIC_FOG_PASS_COUNT,
    sampleCount: resourceFacts?.sampleCount ?? 0,
    memoryBytes: resourceFacts?.totalBytes ?? 0,
    ...(resourceFacts === undefined ? {} : { resourceFacts }),
  });
}

/**
 * A degraded source that has no LKG is still a diagnostic, but it must not
 * claim accepted resources. Keep its identity in the candidate stage.
 */
function inspectCandidateVolume(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog,
  capability: 'available' | 'unavailable',
  candidate: VolumeCandidateIdentity,
  lkg: AcceptedVolumetricFogLkg | undefined,
  failedSubmission: boolean,
) {
  const recovery =
    candidate === undefined
      ? undefined
      : {
          guid: candidate.guid,
          generation: candidate.generation,
          deviceEpoch: frameState.volumetricFogInspection.deviceEpoch,
          status: 'candidate' as const,
          ...candidateRecoveryFields(candidate),
          ...(failedSubmission ? { candidateFailure: 'submit-failed' as const } : {}),
        };
  const format = fog.densityAsset?.format === undefined ? lkg?.format : fog.densityAsset.format;
  return inspectVolumetricFog({
    authored: fog.status === 'available' || fog.status === 'degraded',
    capability,
    degraded: fog.status === 'degraded' || capability === 'unavailable',
    ...(recovery === undefined ? {} : { recovery }),
    ...(lkg?.digest === undefined ? {} : { acceptedDigest: lkg.digest }),
    ...(format === undefined ? {} : { format }),
    passCount: 0,
    sampleCount: 0,
    memoryBytes: 0,
  });
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
  const resourceFacts = volumetricFogResourceFacts(frameState);
  const acceptedLkg = acceptedVolumetricFogLkg(frameState, fog, resourceFacts);
  const candidate = volumeCandidateIdentity(fog);
  // Any candidate that reached encode/submit but failed must project the LKG,
  // never the unsubmitted candidate. The candidate identity remains visible so
  // recovery tooling can distinguish the rejected bytes from the frame being
  // rendered.
  const failedSubmission = !submitted && volumeSubmissionAttempted;

  if (fog === undefined || fog.status === 'off') {
    // A failed fog-off candidate must not erase the inspection/LKG that is
    // still being rendered. The accepted projection is retired only after a
    // successful no-volume submission below.
    if (failedSubmission) {
      inspectAcceptedVolume(frameState, acceptedLkg, candidate, 'degraded', 'submit-failed');
      return;
    }
    if (!submitted) return;
    frameState.volumetricFogInspection = inspectVolumetricFog({
      authored: false,
      capability: 'available',
    });
    return;
  }

  const capability = volumeLightingCapability(volumeCapability, fog, lights);
  // This call runs after graph settlement so the inspection and the
  // graph/context observe the same transaction.
  if (
    submitted &&
    fog.status === 'available' &&
    prepared !== undefined &&
    capability === 'available'
  ) {
    frameState.volumetricFogInspection = inspectSubmittedVolume(
      frameState,
      fog,
      lights,
      candidate,
      resourceFacts,
    );
    return;
  }

  // A submitted degraded source (or an available source whose residency
  // preparation failed) is rendered through the previously accepted graph.
  // Keep that LKG resource fact visible instead of projecting a zero-resource
  // candidate merely because the current source could not be prepared.
  if (
    submitted &&
    (fog.status === 'degraded' || prepared === undefined) &&
    inspectAcceptedVolume(frameState, acceptedLkg, candidate, 'degraded')
  ) {
    return;
  }
  if (
    failedSubmission &&
    inspectAcceptedVolume(frameState, acceptedLkg, candidate, 'degraded', 'submit-failed')
  ) {
    return;
  }
  frameState.volumetricFogInspection = inspectCandidateVolume(
    frameState,
    fog,
    capability,
    candidate,
    acceptedLkg,
    failedSubmission,
  );
}

/** The volume projection this frame renders and the accepted state it may replace. */
function prepareFrameVolumetricFog(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
  lights: ExtractedLights,
  volumetricFog: ExtractedVolumetricFog | undefined,
) {
  const capability = hasVolumetricFogCapability(
    internals.device.caps,
    internals.volumetricFogShaders,
  );
  attempt.volumeInspectionReady = true;
  attempt.volumeCapability = capability;
  const viewFog = capability
    ? volumetricFogForView(volumetricFog, camera, internals.canvas.width, internals.canvas.height)
    : volumetricFog;
  attempt.viewVolumetricFog = viewFog;
  const spotLightProjector = prepareSpotLightProjectorFrame(
    internals,
    world,
    worlds,
    lights,
    volumetricFog,
  );
  const prepared = prepareVolumetricFogFrame(
    internals,
    frameState,
    world,
    worlds,
    viewFog,
    lights,
    capability,
    spotLightProjector,
  );
  attempt.preparedVolumetricFog = prepared;
  // A degraded authored snapshot must keep consuming the last accepted GPU
  // projection. The current source is still surfaced as a diagnostic, but
  // it must not replace the graph/context that produced the last good frame.
  // An absent component is different: a successful no-volume frame retires
  // the accepted projection and compiles the normal graph.
  const acceptedFallback =
    capability && viewFog !== undefined && prepared === undefined
      ? frameState.volumetricFogAccepted
      : undefined;
  const baseContext =
    prepared ??
    (acceptedFallback === undefined
      ? undefined
      : stageAcceptedVolumetricFogFrame(
          internals,
          frameState,
          frameState.volumetricFogAcceptedContext,
        ));
  const graphFog = capability ? (prepared === undefined ? acceptedFallback : viewFog) : undefined;
  return {
    viewCulled: volumetricFog?.status === 'available' && viewFog === undefined,
    spotLightProjector,
    prepared,
    acceptedFallback,
    graphFog,
    baseContext,
    // A volume graph replacement is provisional whenever it can affect the
    // accepted volume projection: authoring degradation (which consumes the
    // LKG graph), an authored replacement, and an explicit fog-off transition.
    // Non-volume frames retain the legacy immediate graph retirement path.
    topologyCandidate:
      (graphFog?.status === 'available' && baseContext !== undefined) ||
      (graphFog === undefined && frameState.volumetricFogAccepted !== undefined) ||
      (volumetricFog?.status === 'degraded' && acceptedFallback !== undefined),
  };
}

type FrameVolumetricFog = ReturnType<typeof prepareFrameVolumetricFog>;

/**
 * Resolve the temporal history slot of an available volume and write its
 * adjacent UBO lanes: validity, scope time and elapsed time since the
 * accepted history. False when the parameter upload fails.
 */
function prepareVolumetricFogHistory(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  volume: FrameVolumetricFog,
  graph: import('@forgeax/engine-render-graph').CompiledRenderGraph<
    import('../render-pipeline').RenderPipelineFrame
  >,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
):
  | false
  | { readonly context: VolumetricFogFrameContext; readonly signature: VolumeTemporalSignature }
  | { readonly context: undefined; readonly signature: undefined } {
  if (volume.graphFog?.status !== 'available' || volume.baseContext === undefined)
    return { context: undefined, signature: undefined };
  const resolved = resolveVolumetricFogHistoryContext(
    frameState,
    graph,
    volume.graphFog,
    volume.baseContext,
    camera,
    lights,
    width,
    height,
  );
  const previousTime = frameState.volumetricFogHistorySignature?.worldTimeSeconds;
  const currentTime = resolved.signature.worldTimeSeconds;
  const historyParams = new Float32Array([
    resolved.context.historyValid ? 1 : 0,
    currentTime ?? 0,
    previousTime === undefined || currentTime === undefined
      ? 0
      : Math.max(0, currentTime - previousTime),
  ]);
  frameState.volumetricFogParams.pending?.params.set(historyParams, 31);
  const historyParamsWritten = internals.device.queue.writeBuffer(
    resolved.context.paramsBuffer,
    31 * Float32Array.BYTES_PER_ELEMENT,
    historyParams,
  );
  if (!historyParamsWritten.ok) {
    internals.errorRegistry.fire(historyParamsWritten.error);
    return false;
  }
  return resolved;
}

/**
 * Temporal history is graph-owned state. Promote the write slot only after
 * queue submission succeeds; a failed candidate keeps the accepted
 * graph/context/slot and retries into the same pending slot.
 */
function promoteVolumetricFogHistory(
  frameState: RenderFrameState,
  volumetricFog: ExtractedVolumetricFog | undefined,
  volume: FrameVolumetricFog,
  context: VolumetricFogFrameContext,
  signature: VolumeTemporalSignature,
  graph: NonNullable<RenderFrameState['volumetricFogHistoryGraph']>,
): void {
  frameState.volumetricFogHistoryGraph = graph;
  frameState.volumetricFogHistorySlot = context.historyWriteSlot;
  frameState.volumetricFogHistorySignature = signature;
  promoteVolumetricFogParams(frameState.volumetricFogParams);
  if (volumetricFog?.status === 'available' && volume.prepared !== undefined) {
    frameState.volumetricFogAccepted = volumetricFog;
    frameState.volumetricFogAcceptedContext = context;
  } else if (volume.acceptedFallback !== undefined) {
    // The current authored source is degraded, so keep the old accepted
    // POD while advancing the LKG graph's ping-pong slot.
    frameState.volumetricFogAcceptedContext = context;
  }
}

function promoteSubmittedVolumetricFog(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  volumetricFog: ExtractedVolumetricFog | undefined,
  volume: FrameVolumetricFog,
  context: VolumetricFogFrameContext | undefined,
  signature: VolumeTemporalSignature | undefined,
  graph: NonNullable<RenderFrameState['volumetricFogHistoryGraph']>,
): void {
  if (volume.graphFog === undefined) {
    // A valid offscreen view is an actual no-volume submission, not an
    // upload failure. Retain only the previously accepted source/resources
    // for degraded-authoring LKG; never replay that projection offscreen.
    // Genuine component removal still retires everything normally.
    if (!volume.viewCulled) {
      frameState.volumetricFogAccepted = undefined;
      frameState.volumetricFogAcceptedContext = undefined;
      retireVolumetricFogParams(internals, frameState);
    }
    frameState.volumetricFogHistoryGraph = null;
    frameState.volumetricFogHistorySlot = null;
    frameState.volumetricFogHistorySignature = null;
    return;
  }
  if (context !== undefined && signature !== undefined) {
    promoteVolumetricFogHistory(frameState, volumetricFog, volume, context, signature, graph);
    return;
  }
  if (volumetricFog?.status === 'available' && volume.prepared !== undefined) {
    // Defensive fallback for a volume graph that was accepted before the
    // temporal context could be resolved; do not manufacture history.
    frameState.volumetricFogAccepted = volumetricFog;
    frameState.volumetricFogAcceptedContext = volume.prepared;
  }
}

/** The renderer-owned `gpuDriven` input of one display recording. */
export interface GpuDrivenRecordInput {
  readonly owner: GpuDrivenProduction;
  readonly scene: PersistentGpuDrivenState | undefined;
  /** Physical queue acceptance, before publication/finalization observers. */
  readonly onSubmittedWork?: (completed: Promise<void>) => void;
  readonly onRasterLane: (owned: GpuRasterOwnership | undefined) => void;
  readonly activeEntityKeys?: ReadonlySet<number>;
  readonly activeEntityRevision?: number;
  /** Extraction culling count; GPU-owned candidates can stay in residency rows. */
  /** Evaluated only by a dynamic-resolution owner; the count is lazy. */
  readonly visibleRasterRows: number | (() => number);
  readonly cameraVisible?: (source: RenderableSnapshot) => boolean;
  readonly telemetryCandidateCount?: number;
  readonly telemetrySubmit?: GpuDrivenLodSubmitIdentity;
  readonly frameTime?: number;
  readonly deviceGeneration?: number;
  readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
  readonly geometryLane?: 'automatic' | 'direct';
}

/**
 * Per-attempt state that the recording's `finally` settles on every exit
 * path (camera missing, pipeline pending, swap-chain unavailable, thrown
 * setup, capture-only or display submission).
 */
export interface FrameRecordingAttempt {
  /** Whether the shared frame encoder reached queue submission. */
  submitted: boolean;
  preparedGpuDriven: PreparedGpuDrivenFrame | undefined;
  shadowMeshLease: ShadowMeshInput | undefined;
  readonly captureFrames: CubeCaptureFrame[];
  readonly probeCaptureFrames: ProbeCaptureFrame[];
  completion: Promise<unknown> | undefined;
  fallbackReadback:
    | Promise<{
        readonly linearHdr: readonly [number, number, number, number];
        readonly hash: string;
        readonly graphGeneration: number;
        readonly textureIdentity: number;
      }>
    | undefined;
  captureCompletion: Promise<unknown> | undefined;
  resolutionTiming: GpuTimingCapture | undefined;
  volumeInspectionReady: boolean;
  volumeSubmissionAttempted: boolean;
  preparedVolumetricFog: VolumetricFogFrameContext | undefined;
  volumeCapability: boolean;
  viewVolumetricFog: ExtractedVolumetricFog | undefined;
}

function createFrameRecordingAttempt(
  volumetricFog: ExtractedVolumetricFog | undefined,
): FrameRecordingAttempt {
  return {
    submitted: false,
    preparedGpuDriven: undefined,
    shadowMeshLease: undefined,
    captureFrames: [],
    probeCaptureFrames: [],
    completion: undefined,
    fallbackReadback: undefined,
    captureCompletion: undefined,
    resolutionTiming: undefined,
    volumeInspectionReady: false,
    volumeSubmissionAttempted: false,
    preparedVolumetricFog: undefined,
    volumeCapability: false,
    viewVolumetricFog: volumetricFog,
  };
}

function abortPreparedGpuDriven(attempt: FrameRecordingAttempt): void {
  attempt.preparedGpuDriven?._abortResourceReplacement?.();
}

/** Probe tickets belong to this recording attempt, including preparation barriers. */
function completeReflectionProbeSubmission(
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  cubeCapture: CubeCaptureFrameInput | undefined,
): void {
  const fallbackSource = frameState.reflectionFallbackObservationSource;
  frameState.reflectionFallbackCompletion = cubeCapture?.reflectionProbes?.completeSubmission(
    attempt.submitted,
    attempt.completion ?? attempt.captureCompletion,
    fallbackSource === undefined
      ? undefined
      : {
          format: fallbackSource.descriptor.format,
          size: fallbackSource.descriptor.size,
          frameId: fallbackSource.frameId,
          graphGeneration: frameState.graphGeneration,
          textureIdentity: getTextureIdentity(fallbackSource.texture),
          ...(attempt.fallbackReadback === undefined ? {} : { readback: attempt.fallbackReadback }),
        },
    frameState.reflectionFallbackDemand,
  );
  frameState.reflectionFallbackObservationSource = undefined;
}

function retireCaptureGraphs(attempt: FrameRecordingAttempt): void {
  const completion = attempt.captureCompletion;
  for (const capture of [...attempt.captureFrames, ...attempt.probeCaptureFrames]) {
    if (completion === undefined) void capture.graph.retire();
    else
      void completion.then(
        () => capture.graph.retire(),
        () => capture.graph.retire(),
      );
  }
}

function settleFrameRecordingAttempt(
  frameState: RenderFrameState,
  attempt: FrameRecordingAttempt,
  lights: ExtractedLights,
  cubeCapture: CubeCaptureFrameInput | undefined,
): void {
  const submitted = attempt.submitted;
  attempt.shadowMeshLease?.reads.release();
  if (!submitted) frameState.shadowDepthLayers?._abort();
  // Every successful preparation ends, including capture-only and thrown setup paths.
  // Submitted captures may borrow scene tables without publishing display/shadow caches.
  abortPreparedGpuDriven(attempt);
  completeReflectionProbeSubmission(frameState, attempt, cubeCapture);
  frameState.probePlacementFrame?.abort();
  frameState.probePlacementFrame = undefined;
  cubeCapture?.state.planar?.submit(submitted, attempt.captureCompletion);
  retireCaptureGraphs(attempt);
  if (!submitted) attempt.resolutionTiming?.discard();
  const ssrOwnerAtSettle = frameState.ssrHistoryOwner;
  const ssrPending = ssrOwnerAtSettle?.candidate;
  if (!submitted && ssrPending !== undefined) ssrOwnerAtSettle?.abortFrame(ssrPending, 'submit');
  // Output, DoF, and volume topology replacements are provisional until the
  // queue submission succeeds. This runs for every early-return path as
  // well, so a swapchain, encoder, or graph failure cannot leave a
  // non-submitted candidate as the next frame's accepted graph.
  settleCompiledFrameGraphCandidate(
    frameState,
    submitted,
    !submitted && frameState.pipelinePreparationPending === true,
  );
  if (attempt.volumeInspectionReady && (submitted || attempt.volumeSubmissionAttempted)) {
    updateVolumetricFogInspection(
      frameState,
      attempt.viewVolumetricFog,
      lights,
      attempt.preparedVolumetricFog,
      submitted,
      attempt.volumeCapability,
      attempt.volumeSubmissionAttempted,
    );
  }
  frameState.frameNumber += 1;
  // feat-20260608-cluster-lighting M5 / w22: clear Standard once-per-frame fired
  // set so the next frame re-fires if the condition persists.
  frameState.standardOncePerFrameFired.clear();
}

type CompiledFrameGraph = import('@forgeax/engine-render-graph').CompiledRenderGraph<
  import('../render-pipeline').RenderPipelineFrame
>;

/**
 * The forward Standard PBR GPU raster owns one color target while the
 * reflection fallback adds an MRT attachment, so a forward frame keeps the
 * ordinary CPU producer. Deferred writes the fallback in its lighting pass,
 * never in a raster pass, so the G-buffer keeps the GPU-driven lane (and the
 * visible-surface table that ray-traced GI requires). Capture views have
 * independent draw ownership; display-camera GPU work remains active while
 * their faces and SSR fallback attachments are recorded.
 */
function selectFrameGpuDriven(
  frameState: RenderFrameState,
  gpuDriven: GpuDrivenRecordInput | undefined,
  reflectionFallbackCandidate: boolean,
  standard: StandardTopologyInputValue,
): GpuDrivenRecordInput | undefined {
  const fallbackLaneLimit =
    reflectionFallbackCandidate && standard.prepared.renderPath !== 'deferred';
  frameState.surfaceSubmissionObservation?.setActualLaneReason(
    fallbackLaneLimit ? 'reflection-fallback-mrt' : undefined,
  );
  return fallbackLaneLimit ? undefined : gpuDriven;
}

/** The GPU-driven lane owns raster geometry unless the frame selected the direct lane. */
function publishRasterLane(
  gpuDriven: GpuDrivenRecordInput | undefined,
  frameGpuDriven: GpuDrivenRecordInput | undefined,
  prepared: PreparedGpuDrivenFrame | undefined,
) {
  const raster = frameGpuDriven?.geometryLane === 'direct' ? undefined : prepared;
  const selection = raster?.selection ?? EMPTY_GPU_DRAW_SELECTION;
  gpuDriven?.onRasterLane(raster === undefined ? undefined : { selection });
  return { raster, selection };
}

function observePreparedResourceGeneration(
  frameState: RenderFrameState,
  prepared: PreparedGpuDrivenFrame | undefined,
): void {
  if (prepared === undefined) return;
  frameState.surfaceSubmissionObservation?.setResourceGeneration(
    prepared.standardPbrFrameResources.resourceGeneration,
  );
}

function emitSubmittedDrawReceipts(
  renderables: FrameList<RenderableSnapshot>,
  selection: PreparedGpuDrivenFrame['selection'],
  onRenderableDraw: Parameters<typeof emitGpuDrivenDrawReceipts>[2] | undefined,
  frameGpuDriven: GpuDrivenRecordInput | undefined,
): void {
  if (onRenderableDraw === undefined || frameGpuDriven === undefined) return;
  const summary = emitGpuDrivenDrawReceipts(renderables, selection, onRenderableDraw);
  frameGpuDriven.owner.recordDrawSummary(summary);
}

function withQueriedScene(
  gpuDriven: GpuDrivenRecordInput | undefined,
): GpuDrivenRecordInput | undefined {
  return gpuDriven?.scene === undefined
    ? gpuDriven
    : { ...gpuDriven, scene: querySceneExecution(gpuDriven.scene) };
}

function fixedShadowMeshLease(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  worlds: readonly RenderResourceScope[],
  projection: PersistentShadowCasterProjection | undefined,
  fixedShadowDomain: boolean,
): ShadowMeshInput | undefined {
  if (!fixedShadowDomain || projection === undefined) return undefined;
  return shadowMeshReadsForQuery(
    frameState.directionalShadowCache,
    worlds,
    projection,
    internals.gpuStore.meshChanges,
  );
}

/** The lease still has to collect mesh reads unless the accepted cache already holds them. */
function collectsShadowMeshReads(
  frameState: RenderFrameState,
  lease: ShadowMeshInput | undefined,
): ShadowMeshInput | undefined {
  return lease !== undefined && lease.reads !== frameState.directionalShadowCache?.meshReads
    ? lease
    : undefined;
}

function selectDirectionalShadowLod(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  fixedShadowDomain: boolean,
): RenderFrameState['directionalShadowLod'] {
  if (fixedShadowDomain && selectGpuLodLane(internals.device.caps) === 'cpu') {
    frameState.directionalShadowLod ??= { values: [], token: {} };
  } else {
    frameState.directionalShadowLod = undefined;
  }
  return frameState.directionalShadowLod;
}

function configureFrameResolution(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
) {
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
  return { resolution, renderExtent };
}

/** Candidate pipeline preparations add their transmission demand to the frame's. */
function mergeTransmissionDemand(
  demand: TransmissionDemand | undefined,
  preparation: TransmissionDemand | undefined,
): TransmissionDemand | undefined {
  if (preparation === undefined || preparation.activeCount <= 0) return demand;
  return {
    activeCount: (demand?.activeCount ?? 0) + preparation.activeCount,
    needsRoughMips: demand?.needsRoughMips === true || preparation.needsRoughMips,
    needsBackPass: demand?.needsBackPass === true || preparation.needsBackPass === true,
  };
}

/** A retained barrel-distortion graph must still match the requested extent. */
function retainedGraphExtentMismatch(
  frameState: RenderFrameState,
  acceptedExtent: RenderExtent | undefined,
  renderExtent: RenderExtent | undefined,
): boolean {
  if (frameState.barrelDistortionGraphResolution !== 'retained') return false;
  if (renderExtent === undefined) return acceptedExtent !== undefined;
  return (
    acceptedExtent?.internalWidth !== renderExtent.internalWidth ||
    acceptedExtent?.internalHeight !== renderExtent.internalHeight ||
    acceptedExtent?.outputWidth !== renderExtent.outputWidth ||
    acceptedExtent?.outputHeight !== renderExtent.outputHeight
  );
}

/**
 * The compiled graph is the acceptance boundary for the prepared Standard
 * lighting declaration. Upload the same declaration only after that graph is
 * current; a failed candidate therefore cannot leave an old graph consuming a
 * new buffer generation.
 */
function uploadAcceptedStandardLighting(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  standard: StandardTopologyInputValue,
  profilePhase: RecordProfileRunner | undefined,
  projectorLightSlot: number | undefined,
): boolean {
  if (frameState.standardLightingGraphSignature !== standardLightingTopologySignature(standard)) {
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
    return false;
  }
  if (standard.kind !== 'clustered') return true;
  // The clustered HDRP payload owns the direct-light slot upload, so it must
  // also drive the shared IES/light-texture resource upload from the
  // authoritative extracted-light corpus. The prepared local carrier can omit
  // the source payload on this path, leaving the shader bound to its white
  // Cookie fallback even though the authored handle is valid.
  writeLightModifierTextures(internals, pipelineState, lights);
  const clusterWrite = runRecordProfilePhase(profilePhase, 'record/scene-state/hdrp-cluster', () =>
    writeHdrpClusterAndSsaoBuffers(
      internals,
      frameState,
      camera,
      standard.prepared,
      standard.transport,
      profilePhase,
      pipelineState.hdrpClusterMembershipPipeline !== null,
      pipelineState.hdrpClusterMembershipBindGroupLayout,
      projectorLightSlot,
      pipelineState,
    ),
  );
  if (!clusterWrite.ok) {
    internals.errorRegistry.fire(clusterWrite.error);
    return false;
  }
  return true;
}

function cubeCaptureLayerWrites(
  cubeCaptureWork: readonly import('./typed-frame-graph').CubeCaptureGraphWork[],
) {
  return cubeCaptureWork.map((work) => ({ target: work.target, layer: work.layer }));
}

function captureSwapTarget(
  cubeCaptureWork: readonly import('./typed-frame-graph').CubeCaptureGraphWork[],
) {
  const capture = cubeCaptureWork[0];
  if (capture === undefined) return null;
  return {
    currentTexture: capture.physical.texture,
    view: capture.physical.view,
    targetW: capture.physical.descriptor.width,
    targetH: capture.physical.descriptor.height,
  };
}

function stageFrameSsrHistory(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  renderExtent: RenderExtent | undefined,
  admission: SsrSpatialAdmission | undefined,
  temporalView: TemporalView,
): boolean {
  if (admission === undefined) return true;
  return stageSsrHistoryCandidate(
    internals,
    frameState,
    camera,
    renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
    renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
    admission,
    temporalView,
  );
}

function publishShadowPassResources(
  pipelineState: PipelineState,
  lights: ExtractedLights,
  camera: CameraSnapshot,
  graphShadowMapSize: number | undefined,
): void {
  const resources = pipelineState.perPassResources;
  resources.shadowMapSize = graphShadowMapSize ?? 0;
  resources.shadowCascadeCount = lights.cascadeCount ?? 0;
  const firstDirectionalShadowMatrix = lights.lightViewProj?.[0];
  resources.shadowLightSpaceMatrix =
    firstDirectionalShadowMatrix === undefined
      ? null
      : new Float32Array(firstDirectionalShadowMatrix);
  if (lights.lightViewProj === undefined) {
    resources.shadowCsmLightViewProj = null;
    resources.shadowCsmSelection = null;
    return;
  }
  const csmMatrices = new Float32Array(64);
  for (let cascade = 0; cascade < 4; cascade += 1) {
    const matrix = lights.lightViewProj[cascade];
    if (matrix !== undefined) csmMatrices.set(matrix, cascade * 16);
  }
  resources.shadowCsmLightViewProj = csmMatrices;
  resources.shadowCsmSelection =
    lights.splitPlanes === undefined
      ? null
      : {
          viewMatrix: new Float32Array(computeViewMatrix(camera)),
          splitPlanes: new Float32Array(lights.splitPlanes),
        };
}

/**
 * Only the installed stock graph's capable Shadow lane can release its unused
 * legacy mesh slots. Every material row is kept: alpha/custom Shadow groups
 * still bind that table, and its getters/diagnostics remain observed.
 */
function gpuOwnsShadowGeometryFor(
  rendererRecording: boolean,
  captureOnly: boolean,
  attempt: FrameRecordingAttempt,
  cubeCapture: CubeCaptureFrameInput | undefined,
  frameState: RenderFrameState,
  preflightGraph: CompiledFrameGraph,
  raster: PreparedGpuDrivenFrame | undefined,
): boolean {
  return (
    rendererRecording &&
    !captureOnly &&
    attempt.captureFrames.length === 0 &&
    attempt.probeCaptureFrames.length === 0 &&
    !hasCubeCaptureViews(cubeCapture) &&
    frameState.compiledFrameGraph?.graph === preflightGraph &&
    frameState.compiledFrameGraph.directionalShadowViewCount !== undefined &&
    raster?.shadowDirectRequired === false &&
    raster.shadowViewPool !== undefined
  );
}

function pipelinePreparationSources(
  nativeScene: PersistentGpuDrivenState | undefined,
  sourceRenderables: FrameList<RenderableSnapshot>,
): RenderableSnapshot[] {
  const sources: RenderableSnapshot[] = [];
  if (nativeScene === undefined) {
    for (const source of sourceRenderables)
      if (source.pipelinePreparation !== undefined) sources.push(source);
    return sources;
  }
  for (const slot of nativeScene.pipelinePreparationSlots ?? []) {
    const source = nativeScene.drawSnapshotAt?.(slot);
    if (source !== undefined) sources.push(source);
  }
  return sources;
}

function ensurePointsLinesCapacity(
  pipelineState: PipelineState,
  validatedOrdered: readonly ValidatedRenderable[],
  attempt: FrameRecordingAttempt,
): void {
  let pointsLinesSlots = 0;
  for (const row of validatedOrdered)
    if (row.source.pointsLines !== undefined)
      pointsLinesSlots = Math.max(pointsLinesSlots, row.renderableIndex + 1);
  pipelineState.ensurePointsLinesViewCapacity?.(pointsLinesSlots);
  for (const capture of [...attempt.captureFrames, ...attempt.probeCaptureFrames])
    capture.pipeline.ensurePointsLinesViewCapacity?.(pointsLinesSlots);
}

function capsuleShadowLightFor(
  capsuleShadowDirectional: boolean,
  lights: ExtractedLights,
  renderables: FrameList<RenderableSnapshot>,
) {
  if (
    !capsuleShadowDirectional ||
    lights.directional === undefined ||
    lights.directionalShadowQuality === undefined
  ) {
    return undefined;
  }
  return {
    direction: lights.directional.direction,
    coneHalfAngle: capsuleConeHalfAngle(lights.directionalShadowQuality),
    renderables,
  };
}

/**
 * View / mesh uniform uploads are needed when geometry or a feature consumes
 * View, or when a skybox, atmosphere or volume reads the View UBO. The
 * clear-pass-only path skips the writeBuffer round-trips.
 */
function frameNeedsViewUploads(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  meshRows: boolean,
  raster: PreparedGpuDrivenFrame | undefined,
  materialSlotCount: number,
  skyboxActive: boolean,
  activeVolume: VolumetricFogFrameContext | undefined,
  preparedVolume: VolumetricFogFrameContext | undefined,
): boolean {
  return (
    meshRows ||
    (raster !== undefined && materialSlotCount > 0) ||
    getRenderFeatureGraphState(internals).plans.some(({ plan }) => plan.passes.length > 0) ||
    skyboxActive ||
    frameState.environmentFrame?.source.kind === 'atmosphere' ||
    activeVolume !== undefined ||
    preparedVolume !== undefined
  );
}

function sealPreparedResourceReads(
  internals: RenderSystemInternals,
  attempt: FrameRecordingAttempt,
): boolean {
  const sealedReads = attempt.preparedGpuDriven?._sealResourceReads();
  if (sealedReads === undefined || sealedReads.ok) return true;
  internals.errorRegistry.fire(sealedReads.error);
  return false;
}

function frameCommandEncoder(
  internals: RenderSystemInternals,
  sharedEncoder: RhiCommandEncoder | undefined,
): Result<RhiCommandEncoder, RhiError> {
  return sharedEncoder === undefined
    ? internals.device.createCommandEncoder({ label: 'render-system-frame' })
    : ok(sharedEncoder);
}

function currentShadowMeshInput(
  shadowGeometryFixed: boolean,
  lease: ShadowMeshInput | undefined,
): ShadowMeshInput | undefined {
  return shadowGeometryFixed && lease !== undefined && shadowMeshInputCurrent(lease)
    ? lease
    : undefined;
}

/** Staggered cascades without a GPU shadow pool publish one cascade cadence. */
function prepareCascadeStagger(
  frameState: RenderFrameState,
  lights: ExtractedLights,
  worlds: readonly RenderResourceScope[],
  projection: PersistentShadowCasterProjection | undefined,
  raster: PreparedGpuDrivenFrame | undefined,
  cacheMiss: Parameters<typeof prepareDirectionalCascadeCadence>[2],
) {
  if (
    lights.directionalCsmConfig?.staggerCascades !== true ||
    raster?.shadowViewPool !== undefined
  ) {
    return { shadowPublication: undefined, cascadeCadence: undefined };
  }
  return {
    shadowPublication: currentDirectionalShadowPublication(
      worlds,
      projection,
      frameState.directionalShadowCache,
    ),
    cascadeCadence: prepareDirectionalCascadeCadence(
      lights,
      frameState.directionalShadowCache === null ? undefined : frameState.directionalCascadeCadence,
      cacheMiss,
    ),
  };
}

function writePlanarReflectionUniform(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
  planarCapture: ReturnType<PlanarCaptureState['current']>,
): void {
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
}

/** Prepare the compiled graph's scene and shadow pipelines; pending work defers the picture. */
function prepareFramePipelines(
  frameState: RenderFrameState,
  preflightGraph: CompiledFrameGraph,
  passCtx: _InternalRenderPipelineContext,
  hasShadowViews: boolean,
  rendererRecording: boolean,
  materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  materials: MaterialFrame,
): void {
  frameState.candidatePipelinePreparations?.process(passCtx, hasShadowViews);
  if (
    frameState.compiledFrameGraph?.graph === preflightGraph &&
    frameState.compiledFrameGraph.prepareGpuDrivenPipelines?.(
      passCtx.pipelinePreparationEntries,
      materialArtifacts,
      (reason) => {
        frameState.pipelinePreparationPendingReason ??= Object.freeze(reason);
      },
      materials,
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
}

function stageReflectionFallbackReadback(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): ReflectionFallbackReadbackRequest | undefined {
  if (internals.captureReflectionFallbackReadback !== true) return undefined;
  const request = createReflectionFallbackReadbackRequest(internals, frameState);
  if (request !== undefined) frameState.reflectionFallbackReadback = request;
  return request;
}

function stageTemporalFrame(
  frameState: RenderFrameState,
  currentViewProjection: Float32Array,
  camera: CameraSnapshot,
  targetW: number,
  targetH: number,
): void {
  frameState.temporalFrameTransaction.stage({
    frameId: frameState.frameNumber,
    currentViewProjection: new Float32Array(currentViewProjection),
    jitter: [0, 0] as [number, number],
    viewport: { width: targetW, height: targetH },
    cameraPosition: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0] as [
      number,
      number,
      number,
    ],
  });
}

/**
 * Preparation precedes graph compilation. Accept the submitted stock graph's
 * generation with its depth, rather than invalidating it again next frame.
 */
function submittedShadowGraphGenerationFor(
  rendererRecording: boolean,
  frameState: RenderFrameState,
  preflightGraph: CompiledFrameGraph,
): number | undefined {
  return rendererRecording &&
    frameState.activePipeline === standardPipeline &&
    frameState.compiledFrameGraph?.graph === preflightGraph
    ? frameState.graphGeneration
    : undefined;
}

/**
 * Reuse an existing timing owner. Otherwise allocate only for this ready
 * frame, with at most one DRS readback outstanding across view changes.
 */
function allocateResolutionTiming(
  internals: RenderSystemInternals,
  sampleResolution: boolean,
  timingCapture: GpuTimingCapture | undefined,
): GpuTimingCapture | undefined {
  if (
    !sampleResolution ||
    timingCapture !== undefined ||
    (internals.gpuPassTimingSession !== undefined &&
      internals.gpuPassTimingFrameIdentity !== undefined)
  ) {
    return undefined;
  }
  const created = GpuTimingCapture.create(internals.device);
  return created.ok ? created.value : undefined;
}

function beginShadowRasterTelemetry(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  raster: PreparedGpuDrivenFrame | undefined,
): void {
  if (internals.shadowWorkload === true && internals.observationFrameId !== undefined) {
    raster?.shadowViewPool?._setTelemetrySubmit({
      frameId: internals.observationFrameId,
      deviceGeneration: internals.deviceScope.generation,
      graphGeneration: frameState.graphGeneration,
    });
  }
  frameState.shadowRaster.begin(internals.shadowWorkload === true, internals.observationFrameId);
}

/**
 * The submitted graph is the picture authority: the exact mapping used to
 * populate the accepted graph's UBO is the only mapping promoted with its
 * receipt, so an identity frame, a retained barrel LKG and a normal nonzero
 * frame stay on one context.
 */
function commitSubmittedBarrelMapping(
  frameState: RenderFrameState,
  mapping: ReturnType<typeof resolveSubmittedBarrelMapping>,
): void {
  if (mapping !== undefined) frameState.lastSuccessfulBarrelDistortion = mapping;
}

function submittedFrameInspection(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  standard: StandardTopologyInputValue,
  lights: ExtractedLights,
  transparency: ReturnType<typeof resolveTransparencyView>['inspection'],
  renderables: FrameList<RenderableSnapshot>,
  materials: MaterialFrame,
  capsuleShadowDirectional: boolean,
): NonNullable<RenderFrameState['submittedInspection']> {
  return {
    standardLighting: inspectStandardLighting(standard),
    pointShadow: inspectPointShadow(lights.pointShadow, SHADOW_ATLAS_DEFAULT_LAYERS),
    transparency,
    capsuleShadow: inspectCapsuleShadow(
      renderables,
      materials,
      capsuleShadowDirectional,
      lights.directionalShadowQuality !== undefined,
      frameState.capsuleShadowSubmission,
      internals.demandCapsuleShadow ?? (() => undefined),
    ),
  };
}

function discardReflectionFallbackReadback(
  internals: RenderSystemInternals,
  request: ReflectionFallbackReadbackRequest | undefined,
): void {
  if (request !== undefined) internals.device.destroyBuffer(request.buffer);
}

/** Publish the reflection-fallback readback once its submission completes. */
function observeReflectionFallbackReadback(
  internals: RenderSystemInternals,
  attempt: FrameRecordingAttempt,
  request: ReflectionFallbackReadbackRequest | undefined,
  cubeCapture: CubeCaptureFrameInput | undefined,
  done: Promise<unknown>,
): void {
  if (request === undefined) return;
  attempt.fallbackReadback = done.then(
    () =>
      mapReflectionFallbackReadback(
        internals,
        request,
        cubeCapture?.reflectionProbes?.fallbackHasNonNeutral !== true,
      ),
    (cause) => {
      internals.device.destroyBuffer(request.buffer);
      throw cause;
    },
  );
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
  gpuDriven?: GpuDrivenRecordInput,
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
  // The `finally` settlement advances `frameState.frameNumber` exactly once
  // per invocation regardless of which early-return branch is taken. The
  // boolean result reports whether the shared frame encoder reached queue
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
  const attempt = createFrameRecordingAttempt(volumetricFog);
  try {
    const camera = resolveRecordCamera(internals, frameState, activeCameras);
    if (camera === undefined) return false;
    assertProbePlacementSingleView(
      internals,
      frameState,
      camera,
      cameras.length,
      cubeCapture,
      captureOnly,
    );
    frameState.ssrRequested = camera.screenSpaceReflection !== undefined;
    const pipelineState = admitFramePipeline(internals, frameState);
    if (pipelineState === null) return false;
    resetFrameAttemptOutputs(internals, frameState);

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
    // Retain the picture and use the ordinary barrier while an authored image
    // prepares; no scene graph, history or draw receipt is promoted by it.
    if (
      shouldDeferImageDisplay(
        internals,
        world,
        frameState,
        camera,
        cameras.length,
        captureOnly,
        skylight,
        skybox,
        featureGraphCandidate,
        cubeCapture,
      )
    ) {
      attempt.submitted = yield* recordPreparationBarrier(internals, sharedEncoder);
      featureGraphCandidate?.onRejected?.();
      return attempt.submitted;
    }

    // Deferred lighting is the only lane that shades capsule shadows, so only
    // there may admitted characters leave the directional cascades.
    const capsuleShadowDirectional = standard.prepared.renderPath === 'deferred';

    // 0 renderables is a legitimate scene: the frame falls through to encode
    // and submit a clear-pass-only render pass so the canvas is painted with
    // `clearColor`. Geometry submission is conditional on validated rows.

    // Point-shadow params UBO write (per-layer near/far/invSpan).
    writeShadowParamsBuffer(internals, frameState, pipelineState);

    // Per-spot perspective `lightViewProj` matrices fold into the View UBO
    // tail and are written with the per-frame view payload below.
    const effectiveShadowMapSize = resolveShadowMapSize(internals, lights);
    const directionalPreparationLimit = directionalShadowPreparationLimit(
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
    const volume = prepareFrameVolumetricFog(
      internals,
      frameState,
      attempt,
      world,
      worlds,
      camera,
      lights,
      volumetricFog,
    );
    const cloudShadowProjection = cloudShadowProjectionFor(cloudLayer);

    let acceptedMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
    let acceptedShadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
    let materialBindingClasses: ReadonlyMap<string, string> | undefined;
    let directShadowValidated: readonly ValidatedRenderable[] | undefined;
    const cubeCaptureWork = prepareCubeCapture(
      internals,
      cubeCapture,
      camera,
      frameState.frameNumber,
    );
    const reflectionFallbackCandidate = hasReflectionFallbackCandidate(
      cubeCapture,
      ssrDependencies,
    );
    gpuDriven = withQueriedScene(gpuDriven);
    const frameGpuDriven = selectFrameGpuDriven(
      frameState,
      gpuDriven,
      reflectionFallbackCandidate,
      standard,
    );

    // Settle LOD residency before validation captures handles and its cache epoch.
    // An upgrade retires old allocations; this frame must use the replacement.
    const gpuDrivenMeshes = gpuDrivenMeshesForFrame(internals, worlds, gpuDriven?.scene);
    const nativeScene = gpuDriven?.scene;
    const sourceRenderables = shadowCasterProjection?.renderables ?? renderables;
    const { materials: fixedMaterials, manualSubsurface } = resolveFrameMaterials(
      shadowCasterProjection,
      sourceRenderables,
    );
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
    const fixedShadowDomain = isFixedShadowDomain(
      rendererRecording,
      captureOnly,
      nativeScene,
      shadowCasterProjection,
      lights,
      effectiveShadowMapSize,
    );
    attempt.shadowMeshLease = fixedShadowMeshLease(
      internals,
      frameState,
      worlds,
      shadowCasterProjection,
      fixedShadowDomain,
    );
    const shadowMeshReads = collectsShadowMeshReads(frameState, attempt.shadowMeshLease);
    let shadowGeometryFixed = fixedShadowDomain;
    const prepareShadowGeometry = (mesh: MeshGpuHandles, material: MaterialSnapshot) => {
      const effective = prepareGeometry(mesh, material);
      // CPU material-derived selection has no fixed source witness yet.
      if (effective !== mesh) shadowGeometryFixed = false;
      return effective;
    };
    const shadowLodSelection = selectDirectionalShadowLod(internals, frameState, fixedShadowDomain);
    const shadowLodRows = cpuLaneLodRows(internals.device.caps, camera, shadowLodSelection);
    const gpuShadowMaterials = new ShadowMaterialContent();
    const directShadowMaterials = new ShadowMaterialContent();
    const subsurface = resolveFrameSubsurface(
      internals,
      frameState,
      camera,
      renderables.length,
      cubeCapture,
      captureOnly,
      shadowCasterProjection,
      manualSubsurface,
    );
    if (!subsurface.ok) {
      internals.errorRegistry.fire(subsurface.error);
      abortPreparedGpuDriven(attempt);
      return false;
    }
    const ssrAdmission = admitFrameSsr(
      internals,
      frameState,
      camera,
      renderables,
      transparentDispatch,
      fixedMaterials,
      standard,
      ssrDependencies,
      reflectionFallbackCandidate,
    );
    const visibleSurface = projectFrameVisibleSurface(
      internals,
      frameGpuDriven?.scene,
      renderables,
    );
    const deferredProbeBuffer = prepareDeferredProbeBuffer(
      internals,
      frameState,
      standard,
      frameGpuDriven?.scene,
      renderables,
    );
    if (frameGpuDriven !== undefined) {
      const gpuShadowViews = hasShadowViews && frameGpuDriven.geometryLane !== 'direct';
      materialBindingClasses =
        cubeCapture?.reflectionProbes?.bindingClasses ?? EMPTY_MATERIAL_BINDINGS;
      const artifacts = collectFrameGpuDrivenArtifacts(
        internals,
        frameState,
        frameGpuDriven.scene,
        shadowCasterProjection?.materialPrograms,
        standard,
        hasShadowViews,
      );
      if (hasShadowViews)
        collectGpuShadowMaterials(
          internals,
          worlds,
          artifacts.batchExecutions,
          gpuDrivenMeshes,
          gpuShadowMaterials,
          shadowMeshReads,
        );
      acceptedMaterialArtifacts = artifacts.materialArtifacts;
      acceptedShadowMaterialArtifacts = artifacts.shadowMaterialArtifacts;
      const gpuProbeBlendBuffer = gpuProbeBlendBufferFor(
        internals,
        frameState,
        artifacts.materialArtifacts,
        deferredProbeBuffer,
        frameGpuDriven.scene,
      );
      const bindingClasses = materialBindingClasses;
      const preparedAccepted = runRecordProfilePhase(
        profilePhase,
        'record/gpu-driven-prepare',
        () =>
          prepareGpuDrivenOwner(
            internals,
            attempt,
            frameGpuDriven.owner,
            gpuDrivenPrepareRequest(
              internals,
              frameState,
              frameGpuDriven,
              artifacts,
              standard,
              camera,
              pipelineState,
              gpuDrivenMeshes,
              visibleSurface,
              gpuProbeBlendBuffer,
              gpuShadowViews,
              gpuShadowMaterials,
              bindingClasses,
              shadowCasterProjection,
              profilePhase,
              capsuleShadowDirectional,
            ),
            profilePhase,
            gpuShadowViews,
            lights,
            shadowPlanesByView,
            graphShadowMapSize,
            frameState.graphGeneration,
            directionalPreparationLimit,
          ),
      );
      if (!preparedAccepted) {
        abortPreparedGpuDriven(attempt);
        return false;
      }
      directShadowValidated = gpuLaneDirectShadowRows(
        attempt.preparedGpuDriven,
        frameGpuDriven.scene,
        gpuShadowViews,
        artifacts.batchExecutions,
        cubeCaptureWork.length,
        cubeCapture,
        gpuDrivenMeshes,
        worlds,
        prepareSources,
        shadowCasterProjection?.content.viewDraws,
        prepareShadowGeometry,
        shadowLodRows,
      );
    }

    // Direct acceptance keeps main preparation/residency and Surface
    // page/frame/shared-time validation on the same submit hooks. Its CPU
    // shadows need no GPU shadow plan; the empty view list above retires any
    // prior GPU shadow state through the ordinary submission transaction.
    const { raster: rasterGpuDriven, selection: gpuSelection } = publishRasterLane(
      gpuDriven,
      frameGpuDriven,
      attempt.preparedGpuDriven,
    );
    if (hasShadowViews && directShadowValidated === undefined) {
      directShadowValidated = validateDirectShadowRows(
        nativeScene,
        sourceRenderables,
        shadowCasterProjection?.dispatch ?? transparentDispatch,
        fixedMaterials,
        gpuDrivenMeshes,
        worlds,
        prepareSources,
        shadowCasterProjection?.content.viewDraws,
        prepareShadowGeometry,
        shadowLodRows,
      );
    }
    collectDirectShadowMaterials(
      internals,
      worlds,
      directShadowValidated,
      fixedMaterials,
      directShadowMaterials,
      shadowMeshReads,
    );

    // Compile the single frame graph only after GPU preparation has projected
    // the current frame. This keeps the graph topology and its execution
    // closure on the same prepared GPU-owned draw set.
    const { resolution, renderExtent } = configureFrameResolution(
      internals,
      frameState,
      world,
      worlds,
      camera,
    );
    const gi = prepareFrameDiffuseGi(
      internals,
      frameState,
      world,
      worlds,
      camera,
      lights,
      pipelineState,
      frameGpuDriven?.scene,
      visibleSurface,
      renderExtent,
      renderReadLeases,
      captureOnly,
    );
    const terrainReceivers = terrainShadowReceivers(sourceRenderables);
    compileCaptureFrames(
      internals,
      frameState,
      pipelineState,
      lights,
      cubeCapture,
      cubeCaptureWork,
      graphShadowMapSize,
      terrainReceivers,
      attempt.captureFrames,
      attempt.probeCaptureFrames,
    );
    const transparencyView = resolveTransparencyView({
      requested: camera.transparency ?? 'sorted',
      rgba16floatRenderable: internals.device.caps.rgba16floatRenderable,
      renderables,
      materialFrame: fixedMaterials,
      dispatch: transparentDispatch,
    });
    const preparationMaterials = frameState.candidatePipelinePreparations?.materials;
    const graphTransmission = mergeTransmissionDemand(
      transmissionDemand,
      preparationMaterials?.transmissionDemand,
    );
    const preflightGraph = runRecordProfilePhase(profilePhase, 'record/render-graph', () =>
      captureOnly
        ? (attempt.captureFrames[0]?.graph ?? null)
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
            volume.graphFog,
            volume.topologyCandidate,
            standard,
            undefined,
            ssrAdmission,
            renderExtent,
            fixedMaterials.hasMedium || preparationMaterials?.hasMedium === true,
            analyticFog !== undefined && analyticFog.density > 0 && analyticFog.maxOpacity > 0,
            cloudShadowProjection?.resolution,
            transparencyView.topology,
            terrainReceivers,
            subsurface.value,
            rendererRecording,
          ),
    );
    if (
      preflightGraph === null ||
      retainedGraphExtentMismatch(frameState, resolution.submittedExtent, renderExtent)
    ) {
      abortPreparedGpuDriven(attempt);
      return false;
    }
    if (
      !captureOnly &&
      !uploadAcceptedStandardLighting(
        internals,
        frameState,
        pipelineState,
        camera,
        lights,
        standard,
        profilePhase,
        volume.spotLightProjector?.lightSlotIndex,
      )
    ) {
      abortPreparedGpuDriven(attempt);
      return false;
    }

    // Acquire the swap-chain texture + colour view + target dimensions (with
    // one reconfigure-and-retry on surface-outdated); null on unrecoverable
    // failure, in which case the frame bails after the settlement advance.
    const swapTarget = runRecordProfilePhase(profilePhase, 'record/swapchain', () =>
      captureOnly
        ? captureSwapTarget(cubeCaptureWork)
        : acquireSwapChainTarget(internals, pipelineState),
    );
    if (swapTarget === null) {
      abortPreparedGpuDriven(attempt);
      return false;
    }
    const { currentTexture, view, targetW, targetH } = swapTarget;
    const submittedBarrelMapping = captureOnly
      ? undefined
      : resolveSubmittedBarrelMapping(frameState, preflightGraph, camera, targetW, targetH);

    const clock = frameClockSample(world, worlds, camera, sampleTimeSeconds);
    const temporal = resolveFrameTemporal(
      internals,
      frameState,
      camera,
      cameras.length,
      targetW,
      targetH,
      renderExtent,
      visibleSurface !== undefined,
      clock,
      environmentSignature,
      fogSignature,
      environmentReady,
      temporalReset,
    );
    const temporalView = temporal.view;
    reprojectDiffuseGiHistory(
      gi,
      camera,
      temporalView,
      temporal.previous,
      temporal.continuousGeometry,
    );
    if (
      !stageFrameSsrHistory(internals, frameState, camera, renderExtent, ssrAdmission, temporalView)
    ) {
      return false;
    }
    const volumeHistory = prepareVolumetricFogHistory(
      internals,
      frameState,
      volume,
      preflightGraph,
      camera,
      lights,
      targetW,
      targetH,
    );
    if (volumeHistory === false) {
      abortPreparedGpuDriven(attempt);
      return false;
    }
    const activeVolumetricFogContext = volumeHistory.context;

    // The clear color is read from the active CameraSnapshot's single
    // `clearColor` field; the zero-camera fallback carries [0, 0, 0, 1].
    const clear: readonly [number, number, number, number] = [
      camera.clearColor[0],
      camera.clearColor[1],
      camera.clearColor[2],
      camera.clearColor[3],
    ];
    publishShadowPassResources(pipelineState, lights, camera, graphShadowMapSize);

    // Tonemap + skybox-active resolution (skybox requires tonemap HDR target +
    // a resident cubemap view).
    const { tonemapActive, skyboxActive } = resolveSkyboxActive(
      internals,
      frameState,
      temporal.recordCamera,
      skybox,
      world,
    );

    // MSAA is a per-Camera switch derived from `camera.antialias`. When active
    // the geometry pass writes a count=4 multisample colour target and
    // resolves to a single-sample output with the `*Msaa` pipeline variants.
    const msaaActive =
      camera.antialias === 'msaa' && internals.device.caps.backendKind !== 'wgpu-webgl2';
    const geometryDepthKey: string | null = null;
    const gpuOwnsShadowGeometry = gpuOwnsShadowGeometryFor(
      rendererRecording,
      captureOnly,
      attempt,
      cubeCapture,
      frameState,
      preflightGraph,
      rasterGpuDriven,
    );

    const sceneWork =
      nativeScene === undefined || shadowCasterProjection === undefined
        ? undefined
        : prepareScenePasses(
            [
              preflightGraph,
              ...attempt.captureFrames.map(({ graph }) => graph),
              ...attempt.probeCaptureFrames.map(({ graph }) => graph),
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
    // the fold dispatch plan.
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
    const pipelinePreparationEntries = prepareSources(
      pipelinePreparationSources(nativeScene, sourceRenderables),
    );
    cleanPerFrameCaches(internals, frameState, [
      ...validatedOrdered,
      ...shadowValidatedOrdered,
      ...pipelinePreparationEntries,
    ]);
    ensurePointsLinesCapacity(pipelineState, validatedOrdered, attempt);

    const capsuleShadowLight = capsuleShadowLightFor(
      capsuleShadowDirectional,
      lights,
      sourceRenderables,
    );
    frameState.capsuleShadowSubmission = undefined;
    const shadowMaterialRowBase = validatedOrdered.length;
    const materialSlotIndices = dispatchPlan.materialSlotIndices;
    const materialSlots = dispatchPlan.materialSlots;
    const materialSlotCount = dispatchPlan.materialSlotCount;

    // When the LDR path (tonemapActive=false) has transparent entities in the
    // validated draw list, the render is split into two serial passes sharing
    // one color attachment; see computeSplitLdrSprite for the format contract.
    const splitLdrSprite = computeSplitLdrSprite(validatedOrdered, tonemapActive, sceneDispatch);

    const currentViewProjection = mat4.create();
    mat4.multiply(
      currentViewProjection,
      computeProjectionMatrix(camera),
      computeViewMatrix(camera),
    );
    const meshRows = validatedOrdered.length > 0 || shadowValidatedOrdered.length > 0;
    if (
      frameNeedsViewUploads(
        internals,
        frameState,
        meshRows,
        rasterGpuDriven,
        materialSlotCount,
        skyboxActive,
        activeVolumetricFogContext,
        volume.prepared,
      )
    ) {
      runRecordProfilePhase(profilePhase, 'record/uploads', () => {
        // View UBO + CSM/spot-shadow matrix pack: assembled + uploaded in one
        // queue.writeBuffer round-trip. The stable projection is carried in
        // the View UBO; direct-sun shader consumers sample the renderer-owned
        // map at each receiver position.
        writeViewUbo(
          internals.device.queue,
          pipelineState.viewUniformBuffer,
          camera,
          light,
          lights,
          frameState.spotShadowSnapshots,
          temporalView,
          volume.spotLightProjector?.spotIndex,
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

    if (!sealPreparedResourceReads(internals, attempt)) return false;
    const shadowMeshInput = currentShadowMeshInput(shadowGeometryFixed, attempt.shadowMeshLease);
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
    const { shadowPublication, cascadeCadence } = prepareCascadeStagger(
      frameState,
      lights,
      worlds,
      shadowCasterProjection,
      rasterGpuDriven,
      directionalShadowCache.miss,
    );

    const encoderResult = frameCommandEncoder(internals, sharedEncoder);
    if (!encoderResult.ok) {
      internals.errorRegistry.fire(encoderResult.error);
      abortPreparedGpuDriven(attempt);
      return false;
    }
    const encoder: RhiCommandEncoder = encoderResult.value;

    // Per-frame bind group cache resolution (view / mesh / HDRP-cluster);
    // returns null groups on the clear-pass-only path.
    const { viewBindGroup, meshBindGroup, hdrpClusterBindGroup, hdrpClusterMembershipBindGroup } =
      runRecordProfilePhase(profilePhase, 'record/bind-groups', () =>
        buildPerFrameBindGroups(
          internals,
          frameState,
          pipelineState,
          meshRows || rasterGpuDriven !== undefined,
          bindGroupCounts,
          undefined,
          true,
          standard,
        ),
      );

    const planarCapture = cubeCapture?.state.planar?.current();
    writePlanarReflectionUniform(internals, pipelineState, planarCapture);

    // The compiled typed graph is the sole per-frame pass owner. Every pass
    // records into the shared encoder; the graph owns ordering and the
    // renderer finishes and submits exactly once after graph execution.
    const framePostProcessParams = buildFramePostProcessParams(
      internals,
      frameState,
      camera,
      postProcessParams,
      temporal.motionBlurDemand,
      temporal.deltaSeconds,
      temporalView,
      targetH,
      submittedBarrelMapping,
    );

    observePreparedResourceGeneration(frameState, attempt.preparedGpuDriven);
    const publishShadowRows =
      shadowValidatedOrdered.length > 0 ||
      gpuOwnsShadowGeometry ||
      directShadowValidated !== undefined;
    const shadowDispatch = shadowCasterProjection?.dispatch;
    const passCtx: _InternalRenderPipelineContext = {
      ...scenePassInputs(camera, gpuDriven, scenePassWork, visibleSurface, gi.probePlacement),
      pipelinePreparationEntries,
      mainPassMaterialSelection: createMainPassMaterialSelectionOwner({
        dispatch: sceneDispatch,
        validatedOrdered,
        materialSlotIndices,
        materialSlots,
        ...(publishShadowRows ? { shadowValidatedOrdered } : {}),
        ...(shadowDispatch === undefined ? {} : { shadowDispatch }),
      }),
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
      camera: temporal.recordCamera,
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
      ...shaderSourcePassContext(internals),
      ...volumetricFogPassContext(
        camera,
        activeVolumetricFogContext,
        volume.graphFog,
        temporal.currentUnjitteredViewProjection,
      ),
      ...(volume.spotLightProjector === undefined
        ? {}
        : { spotLightProjector: volume.spotLightProjector }),
      dispatch: sceneDispatch,
      hdrpClusterBindGroup,
      hdrpClusterMembershipBindGroup,
      standardLighting: standard,
      foldDispatchPlan: dispatchPlan.foldDispatchPlan,
      materialSlotIndices,
      materialSlots,
      materialBindings: dispatchPlan.materialBindings,
      materialSlotCount,
      ...gpuDrivenPassContext(
        frameState,
        frameGpuDriven,
        attempt.preparedGpuDriven,
        rasterGpuDriven,
        gpuSelection,
        acceptedShadowMaterialArtifacts,
      ),
      shadowViewPlanesByView: shadowPlanesByView(),
      materialFrame: fixedMaterials,
      ...capturePassContext(cubeCapture, planarCapture),
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
      capsuleShadowDirectional,
      ...shadowPassContext(
        shadowCasterProjection,
        cascadeCadence,
        capsuleShadowLight,
        publishShadowRows,
        shadowValidatedOrdered,
        shadowMaterialRowBase,
        shadowCasterWorldKeys,
      ),
      ...(profilePhase !== undefined ? { profilePhase } : {}),
    };
    prepareFramePipelines(
      frameState,
      preflightGraph,
      passCtx,
      hasShadowViews,
      rendererRecording,
      acceptedMaterialArtifacts,
      fixedMaterials,
    );
    if (frameState.pipelinePreparationPending) {
      // Required authored depth PSOs are still compiling. Submit the ordinary
      // completion barrier, but do not encode a partial atlas or promote scene,
      // shadow-cache, capture, or temporal-history state as a rendered picture.
      const pending = yield* recordPreparationBarrier(internals, encoder);
      abortPreparedGpuDriven(attempt);
      featureGraphCandidate?.onRejected?.();
      return pending;
    }
    executeCaptureFrames(
      internals,
      frameState,
      passCtx,
      [...attempt.captureFrames, ...attempt.probeCaptureFrames],
      light,
      volume.spotLightProjector?.spotIndex,
      cloudShadowProjection,
      clock.elapsedSeconds,
      meshRows,
      bindGroupCounts,
    );
    if ((cubeCapture?.sceneInputs?.length ?? 0) > 0) {
      const ready = yield { kind: 'scene-inputs' as const, encoder };
      if (!ready.ok) return false;
    }
    if (captureOnly) {
      return yield* submitCaptureOnlyFrame(
        internals,
        frameState,
        attempt,
        encoder,
        cubeCaptureLayerWrites(cubeCaptureWork),
        nativeScene,
        gpuDriven,
      );
    }
    const fallbackReadbackRequest = stageReflectionFallbackReadback(internals, frameState);
    stageTemporalFrame(frameState, currentViewProjection, camera, targetW, targetH);
    attempt.volumeSubmissionAttempted =
      volume.topologyCandidate || activeVolumetricFogContext !== undefined;
    const frameHooks = frameSubmissionHooks(
      internals,
      frameState,
      attempt,
      gpuDriven,
      gi,
      shadowPublication,
      pointsLinesOwner,
      nativeScene,
      shadowMeshInput,
      shadowLodToken,
      submittedShadowGraphGenerationFor(rendererRecording, frameState, preflightGraph),
    );
    const sampleResolution = resolution.needsSample;
    attempt.resolutionTiming = allocateResolutionTiming(internals, sampleResolution, timingCapture);
    const frameTiming = timingCapture ?? attempt.resolutionTiming;
    beginShadowRasterTelemetry(internals, frameState, rasterGpuDriven);
    attempt.submitted = yield* profileFrameRecording(
      recordCompiledFrameGraph(
        internals,
        frameState,
        passCtx,
        encoder,
        profilePhase === undefined
          ? undefined
          : (pass, encode) => profilePhase(graphExecutionPhase(pass.name), encode),
        frameHooks,
        cubeCaptureWork.length === 0 ? undefined : cubeCaptureLayerWrites(cubeCaptureWork),
        (done) => {
          attempt.completion = done;
          frameState.surfaceSubmissionObservation?.submit(done, frameState.graphGeneration);
          observeReflectionFallbackReadback(
            internals,
            attempt,
            fallbackReadbackRequest,
            cubeCapture,
            done,
          );
        },
        frameTiming,
      ),
      (action) => runRecordProfilePhase(profilePhase, 'record/graph-execute', action),
    );
    if (!attempt.submitted) {
      discardReflectionFallbackReadback(internals, fallbackReadbackRequest);
      return false;
    }
    commitSubmittedDisplay(
      internals,
      frameState,
      attempt,
      resolution,
      renderExtent,
      gpuDriven?.visibleRasterRows,
      renderables.length,
      sampleResolution,
      frameTiming,
    );
    emitSubmittedDrawReceipts(renderables, gpuSelection, onRenderableDraw, frameGpuDriven);
    commitSubmittedBarrelMapping(frameState, submittedBarrelMapping);
    commitSubmittedShadows(frameState, lights, cascadeCadence);
    promoteDirectionalShadowCache(frameState, attempt, directionalShadowCache);
    frameState.recoveryMaterialArtifacts = acceptedMaterialArtifacts;
    frameState.recoveryShadowMaterialArtifacts = acceptedShadowMaterialArtifacts;
    promoteSubmittedVolumetricFog(
      internals,
      frameState,
      volumetricFog,
      volume,
      activeVolumetricFogContext,
      volumeHistory.signature,
      preflightGraph,
    );
    frameState.submittedInspection = submittedFrameInspection(
      internals,
      frameState,
      standard,
      lights,
      transparencyView.inspection,
      sourceRenderables,
      fixedMaterials,
      capsuleShadowDirectional,
    );
    return true;
  } finally {
    settleFrameRecordingAttempt(frameState, attempt, lights, cubeCapture);
  }
}
