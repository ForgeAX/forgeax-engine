// Non-stable implementation seam for engine-owned consumers and tests.

export { renderGraphCompileCount } from '@forgeax/engine-render-graph';

export {
  createDynamicGeometrySourceHost,
  type DynamicGeometryResidencyPort,
} from './assembly/dynamic-geometry-host';
export { DeviceScope } from './device/device-scope';
export { createLightResourceUnavailable } from './errors/render';
export {
  type FullscreenRenderFeatureDeclaration,
  fullscreenRenderFeatureDeclaration,
} from './features/fullscreen';
export {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
  type RenderFeatureNativePlanBuilder,
  type RenderFeatureNativePlanToken,
} from './features/prepared-gpu-work';
export {
  deriveLtcResourcePlan,
  type LtcResourcePlan,
} from './prepare/extended-lighting/ltc-resources';
export {
  deriveExtendedLightingCapability,
  EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
  type ExtendedLightingCapabilityResult,
  type ExtendedLightingResourceCandidate,
  extendedLightingSampledTextureCapacityAvailable,
} from './prepare/extended-lighting/resources';
export {
  createExtendedLightingState,
  type ExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
  recordExtendedLightingFailure,
} from './prepare/extended-lighting/state';
export type { MeshPipelinePreparation } from './publication/contract';
export { captureMeshPipelinePreparation } from './publication/mesh-pipeline-preparation';
export {
  buildRaySurfaceScene,
  type RaySurfaceInstance,
  type RaySurfaceScene,
} from './raytracing/attributes';
export type { SurfaceViewProjection } from './raytracing/capture-view';
export {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
  type SdfCardLookup,
} from './raytracing/card-lookup';
export {
  createDiffuseGi,
  type DiffuseGi,
  type DiffuseGiSettings,
  GI_PIXEL_STRIDE,
  GI_PROBE_SAMPLE_STRIDE,
  GI_SURFACE_STRIDE,
  GiStatus,
} from './raytracing/diffuse-gi';
export { createRayDisplay, type RayDisplayMode } from './raytracing/display';
export {
  createGlobalSdfCardLookup,
  createGlobalSdfCardLookupRecorder,
  GLOBAL_CARD_CANDIDATE_STRIDE,
  GLOBAL_SDF_CARD_LOOKUP_WGSL,
  GlobalCardCandidateFlags,
  type GlobalSdfCardLookup,
  type GlobalSdfCardLookupInputs,
} from './raytracing/global-card-lookup';
export {
  createGlobalSdfComposition,
  createGlobalSdfCompositionRecorder,
  GLOBAL_SDF_COMPOSE_WGSL,
  GLOBAL_SDF_VOXEL_STRIDE,
  type GlobalSdfComposition,
  type GlobalSdfCompositionInputs,
  type GlobalSdfGrid,
  GlobalSdfVoxelStatus,
} from './raytracing/global-sdf';
export {
  createGlobalSdfQuery,
  createGlobalSdfQueryRecorder,
  GLOBAL_SDF_HIT_STRIDE,
  GLOBAL_SDF_QUERY_WGSL,
  type GlobalSdfQuery,
  type GlobalSdfQueryInputs,
  type GlobalSdfQueryOptions,
  GlobalSdfQueryStatus,
} from './raytracing/global-sdf-query';
export {
  bakeIrradianceVolume,
  createIrradianceVolumeCooker,
  type IrradianceBakeInput,
  type IrradianceBakeResult,
  type IrradianceBakeSettings,
  type IrradianceVolumeCookInput,
  type IrradianceVolumeCookPayload,
  irradianceBakeFingerprint,
} from './raytracing/irradiance-bake';
export {
  IRRADIANCE_FIELD_COVERAGE_BYTES,
  IRRADIANCE_FIELD_COVERAGE_WGSL,
} from './raytracing/irradiance-field';
export {
  decodeIrradianceVolume,
  encodeIrradianceVolume,
  IRRADIANCE_VOLUME_ARTIFACT,
  IRRADIANCE_VOLUME_FORMAT,
  IRRADIANCE_VOLUME_KIND,
  IRRADIANCE_VOLUME_MEDIA_TYPE,
  type IrradianceProbeRays,
  type IrradianceVolume,
  type IrradianceVolumeContent,
  type IrradianceVolumeError,
  type IrradianceVolumeErrorCode,
  type IrradianceVolumeLattice,
  integrateIrradianceProbes,
  irradianceProbePosition,
  irradianceVolumeContribution,
  irradianceVolumeDigest,
  irradianceVolumeKind,
  irradianceVolumeProbeBlocks,
  sphericalFibonacci,
  validateIrradianceLattice,
  validateIrradianceVolume,
} from './raytracing/irradiance-volume';
export {
  createRayPathTracer,
  createSubmittedRayPathTracer,
  type RayPathCamera,
  type RayPathInitialRay,
  type RayPathMaterial,
  type RayPathSettings,
  type RayPathTracer,
} from './raytracing/path-tracer';
export {
  createRasterProbePlacement,
  type RasterProbePlacementInputs,
} from './raytracing/probe-placement';
export {
  createProbeRayRecorder,
  PROBE_RAYS_WGSL,
  type ProbeRayInputs,
  ProbeRayStatus,
} from './raytracing/probe-rays';
export { createRayReferenceQuery, type RayReferenceQuery } from './raytracing/query';
export { createRasterRayGenerator, type RasterRayInputs } from './raytracing/raster-source';
export {
  buildRayReferenceScene,
  packReferenceRays,
  type RayMeshInstance,
  type RayReferenceError,
  type RayReferenceScene,
  type ReferenceHit,
  type ReferenceRay,
  traceReferenceRay,
} from './raytracing/scene';
export {
  createSdfQuery,
  type SdfMeshInstance,
  type SdfQuery,
  type SdfQueryOptions,
  SdfQueryStatus,
} from './raytracing/sdf-query';
export { createSoftwareSdfQuery, type SoftwareSdfQuery } from './raytracing/software-sdf-query';
export {
  CARD_PLANES,
  createSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCardSource,
} from './raytracing/surface-cards';
export {
  type GraphTargetCaptureReadbackValidation,
  validateGraphTargetCaptureReadback,
} from './record/frame-snapshot';
export {
  type GpuPassTimingIntervalSummary,
  summarizeGpuPassTimingIntervals,
} from './record/gpu-pass-timing/parser';
export {
  buildRectAreaWorldFrame,
  rectAreaFacesPoint,
} from './render-system-extract';
export {
  admitProbeContributors,
  blendLightProbes,
  scaledProbeWeight,
} from './scene/probe-blend';
export { PROBE_BLEND_RECORD_CAPACITY } from './scene/probe-blend-record';
export {
  createSsrHistoryOwner,
  SSR_HISTORY_FORMAT,
  type SsrHistoryCandidate,
  type SsrHistoryError,
  type SsrHistoryInspection,
  SsrHistoryOwner,
  type SsrHistoryResetReason,
  type SsrHistoryResources,
  type SsrHistorySlot,
  type SsrHistoryState,
} from './ssr/history';
export { estimateSsrSpatialMemory } from './ssr/resources';
export {
  createSsrTemporalConsumer,
  type SsrTemporalCandidate,
  SsrTemporalConsumer,
  type SsrTemporalError,
  type SsrTemporalExecutionError,
  type SsrTemporalInspection,
} from './ssr/temporal';
export { TemporalFrameCoordinator } from './temporal/frame-coordinator';
