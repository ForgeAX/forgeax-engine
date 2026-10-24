export {
  type AsyncDynamicGeometryHost,
  createAsyncDynamicGeometryHost,
} from './async-dynamic-geometry';
export { CameraView, type CameraViewData } from './components/camera-view';
export {
  Outline,
  type OutlineData,
  OutlineOcclusionValue,
  type OutlineSnapshot,
  resolveOutline,
} from './components/outline';
export {
  StereoCamera,
  type StereoCameraData,
  type StereoCameraInvalidField,
  type StereoEye,
  type StereoLayout,
  StereoLayoutValue,
  stereoLayoutFromU32,
} from './components/stereo-camera';
export {
  CameraViewInvalidError,
  OutlineInvalidParameterError,
  StereoCameraInvalidError,
} from './errors/render';
export { SceneSdfUnavailableError, type SceneSdfUnavailableReason } from './errors/scene-sdf';
export type { RenderFeatureSceneSdfDescriptor } from './features/scene-sdf';
export type {
  GeometryCommandObservation,
  GeometryGBufferProgram,
  GeometryObservation,
  GeometrySourceIdentity,
  GeometryViewObservation,
} from './geometry-observation';
export type {
  CameraViewInspection,
  LodOcclusionReceiptCompleteViewObservation,
  LodOcclusionReceiptObservation,
  LodOcclusionReceiptUnavailableReason,
  LodOcclusionReceiptViewObservation,
  LodOcclusionReceiptViewState,
} from './inspection-types';
// @forgeax/engine-render — AI-facing render vocabulary.
//
// The root is deliberately small: ECS render components, grouped closed
// values, immutable frame facts, the renderer lifecycle/receipt contract, and
// the declarative RenderFeature plan. Graph builders, prepared GPU state, pipeline
// implementations, builtin feature factories, and diagnostic class names are
// owner-local implementation details.

export {
  ClippingContractError,
  type ClippingOptions,
  type ClippingPlane,
  MAX_CLIPPING_PLANES,
  normalizeClippingPlanes,
  withClipping,
} from '@forgeax/engine-types';
export { validateRenderProfile } from './assembly/renderer-facade.js';
export {
  materialContribution,
  renderPipelineContribution,
  samplerContribution,
} from './assets/asset-decoders.js';
export {
  type BakeDataKey,
  type BakeDataRecord,
  type BakeDataResolution,
  type BakeDataStaleDiagnostic,
  type BakeFingerprintInput,
  bakeFingerprint,
  resolveBakeData,
} from './bake-data.js';
export {
  attachBarrelDistortionCameraFrame,
  type BarrelDistortionCameraFrame,
  type BarrelDistortionMapping,
  createBarrelDistortionMapping,
  type DisplayPoint,
  freezeBarrelDistortionMapping,
  mapDisplayToScene,
  mapDisplayUvToSceneUv,
  mapSceneToDisplay,
  mapSceneUvToDisplayUv,
} from './barrel-distortion.js';
export type { CapsuleShadowInspection } from './capsule-shadow/inspection.js';
export type {
  CapsuleShadowFallbackReason,
  CapsuleShadowSnapshot,
} from './capsule-shadow/world-capsules.js';
// Runtime contract: leases, frame receipts, detached inspection, profile,
// lifecycle state, and the single renderer event stream.
export type {
  CubeCameraFaceView,
  CubeCameraFaceViewInput,
} from './capture/cube-views.js';
export { buildCubeCameraFaceViews } from './capture/cube-views.js';
export { buildPlanarReflectionView, type PlanarReflectionViewInput } from './capture/planar-view';
export {
  buildCloudDensityCache,
  type CloudDensityCache,
  type CloudDensityCacheSnapshot,
  type CloudDensitySample,
  evaluateCloudDensity,
  reconstructCloudDensityCache,
  sampleCloudDensity,
  snapshotCloudDensityCache,
} from './cloud/density.js';
export {
  type CloudLayerCandidate,
  type ExtractedCloudLayer,
  extractCloudLayer,
  selectCloudLayerFrame,
} from './cloud/extract.js';
export {
  CLOUD_DENSITY_COMPUTE_WGSL,
  CLOUD_HISTORY_FULLSCREEN_WGSL,
  CLOUD_LAYER_FEATURE_IDENTITY,
  CLOUD_VIEW_FULLSCREEN_WGSL,
  CLOUD_VIEW_PARAMS_BYTES,
  type CloudLayerFeatureFrame,
  type CloudLayerFeatureOptions,
  createCloudLayerFeature,
} from './cloud/feature.js';
export {
  type CloudLayerBudgetObservation,
  type CloudLayerInspection,
  type CloudLayerInspectionInput,
  type CloudLayerInspectionStatus,
  type CloudLayerResourceStage,
  type CloudPhysicalGpuEvidence,
  cloudCapabilitiesFromRhi,
  inspectCloudLayer,
} from './cloud/inspection.js';
export {
  applyCloudSolarTransmittance,
  type CloudInteriorLighting,
  type CloudOpticalPath,
  type CloudOpticalResult,
  type CloudOpticsInput,
  type CloudRay,
  integrateCloudCameraPath,
  integrateCloudInterior,
  integrateCloudPath,
  integrateCloudSolarColumn,
} from './cloud/optics.js';
export {
  CLOUD_QUALITY_PROFILES,
  type CloudLayerAuthoring,
  type CloudQualityProfile,
  cloudLayerSourceKey,
  DEFAULT_CLOUD_LAYER,
  type ValidatedCloudLayer,
  validateCloudLayer,
} from './cloud/parameters.js';
export {
  CLOUD_HISTORY_SURFACE_COUNT,
  CLOUD_RGBA16FLOAT_BYTES_PER_TEXEL,
  type CloudGpuResourceEvidence,
  type CloudLayerResourceFacts,
  type CloudLayerResourceInputs,
  inspectCloudLayerResources,
} from './cloud/resources.js';
export {
  type CloudShadowProjection,
  type CloudShadowSample,
  createCloudShadowProjection,
  projectCloudShadowUv,
  sampleCloudShadow,
} from './cloud/shadow.js';
export {
  type CloudHistory,
  type CloudHistoryReprojection,
  type CloudHistoryReprojectionInput,
  CloudHistoryStore,
  type CloudTemporalDecision,
  type CloudTemporalFrame,
  type CloudTemporalResetReason,
  type CloudTemporalSignature,
  cloudTemporalResetReasons,
  cloudTemporalSignature,
  createCloudHistory,
  reprojectCloudHistory,
} from './cloud/temporal.js';
export {
  AMBIENT_OCCLUSION_ALGORITHMS,
  AMBIENT_OCCLUSION_GTAO,
  AMBIENT_OCCLUSION_QUALITIES,
  AMBIENT_OCCLUSION_SSAO,
  AmbientOcclusion,
  type AmbientOcclusionData,
  ambientOcclusionParameters,
} from './components/ambient-occlusion.js';
export { Atmosphere } from './components/atmosphere.js';
export {
  BarrelDistortion,
  type BarrelDistortionData,
  validateBarrelDistortionParameters,
} from './components/barrel-distortion.js';
// ECS render vocabulary and grouped closed values.
export type {
  Antialias,
  BloomEnabled,
  CameraData,
  CameraErrorCode,
  CameraErrorDetail,
  CameraExposure,
  CameraProjection,
  Tonemap,
  Transparency,
} from './components/camera.js';
export {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  ANTIALIAS_SMAA,
  ANTIALIAS_TAA,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_BLOOM_INTENSITY_MAX,
  CAMERA_BLOOM_INTENSITY_MIN,
  CAMERA_BLOOM_RADIUS_MAX,
  CAMERA_BLOOM_RADIUS_MIN,
  CAMERA_BLOOM_SMOOTH_WIDTH_MAX,
  CAMERA_BLOOM_SMOOTH_WIDTH_MIN,
  CAMERA_BLOOM_THRESHOLD_MAX,
  CAMERA_BLOOM_THRESHOLD_MIN,
  CAMERA_EXPOSURE_MODE_AUTO,
  CAMERA_EXPOSURE_MODE_MANUAL,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  CAMERA_TEMPERATURE_MAX,
  CAMERA_TEMPERATURE_MIN,
  CAMERA_TINT_MAX,
  CAMERA_TINT_MIN,
  Camera,
  CameraError,
  cameraExposureFromColumns,
  cameraProjectionFromF32,
  orthographic,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
  TRANSPARENCY_SORTED,
  TRANSPARENCY_WEIGHTED_BLENDED,
  validateCameraBloom,
  validateCameraColorGrading,
  validateCameraExposure,
} from './components/camera.js';
export { CapsuleShadow } from './components/capsule-shadow.js';
export {
  ClippingPlanes,
  type ClippingPlanesData,
  clippingPlanesData,
} from './components/clipping-planes';
export {
  CloudLayer,
  type CloudLayerData,
  type CloudQuality,
  CloudQualityValue,
  cloudQualityFromF32,
} from './components/cloud-layer.js';
export {
  CUBE_CAMERA_FACE_ORDER,
  CUBE_CAMERA_UPDATE_CONTINUOUS,
  CUBE_CAMERA_UPDATE_ON_DEMAND,
  CUBE_CAMERA_UPDATE_ONCE,
  CubeCamera,
  type CubeCameraData,
  type CubeCameraFace,
  type CubeCameraUpdateIntent,
  cubeCameraUpdateIntentFromF32,
} from './components/cube-camera.js';
export {
  DepthOfField,
  type DepthOfFieldData,
  type DepthOfFieldQuality,
  DepthOfFieldQualityValue,
  type DepthOfFieldSide,
  DepthOfFieldSideValue,
  depthOfFieldQualityFromF32,
  depthOfFieldSideFromF32,
} from './components/depth-of-field.js';
export * from './components/directional-light.js';
export {
  DynamicResolution,
  type DynamicResolutionData,
  validateDynamicResolutionCamera,
  validateDynamicResolutionParameters,
} from './components/dynamic-resolution.js';
export { Fog } from './components/fog.js';
export { Instances, type InstancesData } from './components/instances.js';
export { Layer } from './components/layer.js';
export {
  LensEffects,
  type LensEffectsData,
  type LensEffectsSnapshot,
  resolveLensEffects,
} from './components/lens-effects.js';
export {
  LENS_FLARE_GHOST_COUNT,
  LensFlare,
  type LensFlareData,
  type LensFlareSnapshot,
  resolveLensFlare,
} from './components/lens-flare.js';
export * from './components/light-helpers.js';
export { LightProbe } from './components/light-probe.js';
export { LIGHTING_CHANNELS_DEFAULT } from './components/lighting-channels.js';
export {
  type LineCap,
  LineCapValue,
  Lines,
  type LineWidthUnits,
  LineWidthUnitsValue,
  lineCapFromU32,
  lineWidthUnitsFromU32,
} from './components/lines.js';
export * from './components/mesh-filter.js';
export * from './components/mesh-renderer.js';
export { MotionBlur } from './components/motion-blur.js';
export {
  PlanarReflection,
  type PlanarReflectionData,
  PlanarReflectionInvalidError,
} from './components/planar-reflection';
export { PointLight } from './components/point-light.js';
export { PointLightShadow } from './components/point-light-shadow.js';
export {
  type PointShape,
  PointShapeValue,
  Points,
  pointShapeFromU32,
} from './components/points.js';
export { PostProcessParams } from './components/post-process-params.js';
export { RectAreaLight } from './components/rect-area-light.js';
export {
  REFLECTION_PROBE_UPDATE_CONTINUOUS,
  REFLECTION_PROBE_UPDATE_ON_CHANGE,
  REFLECTION_PROBE_UPDATE_ONCE,
  ReflectionProbe,
  type ReflectionProbeData,
  type ReflectionProbeUpdateIntent,
  reflectionProbeUpdateIntentFromF32,
} from './components/reflection-probe.js';
export { SceneInstance } from './components/scene-instance.js';
export {
  ScreenSpaceReflection,
  type ScreenSpaceReflectionData,
} from './components/screen-space-reflection';
export { ShadowParticipation } from './components/shadow-participation.js';
export {
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
} from './components/skybox-background.js';
export { Skylight } from './components/skylight.js';
export { SortKey } from './components/sort-key.js';
export { SpotLight } from './components/spot-light.js';
export {
  Visibility,
  type VisibilityState,
  VisibilityStateValue,
  visibilityStateFromU32,
} from './components/visibility.js';
export { ProjectedDecal, ProjectedDecalInvalidError } from './decals/component';
export type {
  DynamicGeometryCandidate,
  DynamicGeometryCandidateState,
  DynamicGeometryErrorCode,
  DynamicGeometryErrorDetail,
  DynamicGeometryInspection,
  DynamicGeometryLifecycle,
  DynamicGeometryLifecycleOptions,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
  DynamicGeometryReceipt,
  MeshResidencyErrorCode,
  MeshResidencyPhaseObserver,
  PreparedMeshResidency,
} from './dynamic-geometry.js';
export {
  createDynamicGeometryLifecycle,
  DynamicGeometryError,
  MeshResidencyError,
  validateDynamicGeometryMeshBudget,
} from './dynamic-geometry.js';
// The environment selector owns this structured recovery error. Keep the
// class on the public environment path so consumers can branch by `code` and
// inspect its typed `detail` without importing an owner-private module.
export { SunCardinalityError } from './environment/frame.js';
export type {
  EnvironmentInspection,
  EnvironmentInspectionFailure,
  EnvironmentInspectionGeneration,
  EnvironmentInspectionStatus,
} from './environment/inspection.js';
export type {
  CloudLayerCacheInvalidDetail,
  CloudLayerCapabilityMissingDetail,
  CloudLayerError,
  CloudLayerErrorCode,
  CloudLayerInvalidParameterDetail,
  CloudLayerOwnerConflictDetail,
  CloudLayerResourceFailureDetail,
} from './errors/cloud.js';
export {
  CloudLayerCacheInvalidError,
  CloudLayerCapabilityMissingError,
  CloudLayerInvalidParameterError,
  CloudLayerOwnerConflictError,
  CloudLayerResourceFailureError,
} from './errors/cloud.js';
// Public structured operation failure union. Concrete error classes stay
// behind the Renderer Result/event boundary.
export type {
  GpuDrivenPreparationErrorCode,
  GpuDrivenPreparationErrorDetail,
  GpuDrivenPreparationReason,
  GpuDrivenRecoveryAction,
} from './errors/gpu-driven';
export { GpuDrivenPreparationError } from './errors/gpu-driven';
export type {
  BarrelDistortionInvalidParameterDetail,
  DynamicResolutionError,
  ExternalTextureInvalidDetail,
  ExternalTextureInvalidReason,
  ExternalTextureStateInvalidDetail,
  ExternalTextureStateInvalidReason,
  FramebufferSnapshotFailedDetail,
  FramebufferSnapshotFailureReason,
  MaterialSampledTextureBudgetExceededDetail,
  ReflectionProbeBudgetExceededDetail,
  RenderError,
  RenderErrorCode,
  RenderIntentInvalidDetail,
  RenderTargetCapabilityMissingDetail,
  RenderTargetDescriptorInvalidDetail,
  RenderTargetLayerInvalidDetail,
  RenderTargetOperationFailedDetail,
  RenderTargetStateInvalidDetail,
  SceneDataUnavailableDetail,
  SceneDataUnavailableReason,
} from './errors/render.js';
export {
  AtmosphereInvalidParameterError,
  BarrelDistortionInvalidParameterError,
  DynamicResolutionInvalidParameterError,
  DynamicResolutionRequiresTaaError,
  DynamicResolutionTimingUnavailableError,
  EnvironmentGenerationFailedError,
  EnvironmentSourceConflictError,
  ExternalTextureInvalidError,
  ExternalTextureStateInvalidError,
  FogCardinalityError,
  LensEffectsInvalidParameterError,
  LensFlareInvalidParameterError,
  MaterialSampledTextureBudgetExceededError,
  OwnerStageFailedError,
  RendererOperationError,
  SceneDataUnavailableError,
  TaaCapsInsufficientError,
} from './errors/render.js';
export {
  SINGLE_LAYER_MEDIUM_SURFACE_EXAMPLE,
  SINGLE_LAYER_MEDIUM_SURFACE_EXAMPLES,
} from './examples/single-layer-medium-surface.js';
export type {
  EnvironmentFrame,
  EnvironmentSource,
  FogFrame,
  FramePlan,
} from './extract/environment.js';
export {
  resolveVisibility,
  type VisibilityResolution,
  type VisibilitySnapshot,
} from './extract/visibility.js';
export {
  BARREL_DISTORTION_FEATURE_IDENTITY,
  BARREL_DISTORTION_POST_PROCESS_ID,
  BARREL_DISTORTION_WGSL,
  BARREL_DISTORTION_WGSL_COORDINATE,
  type BarrelDistortionFeatureFrame,
  createBarrelDistortionRenderFeature,
} from './features/barrel-distortion.js';
export {
  DEFAULT_DEPTH_OF_FIELD_PARAMS,
  DEPTH_OF_FIELD_PARAMS_BYTE_SIZE,
  type DepthOfFieldCameraInput,
  type DepthOfFieldErrorCode,
  type DepthOfFieldErrorDetail,
  type DepthOfFieldParams,
  type DepthOfFieldRequestFailure,
  DepthOfFieldValidationError,
  depthOfFieldQualityCode,
  depthOfFieldRequestFailure,
  depthOfFieldSideCode,
  depthOfFieldTapCount,
  packDepthOfFieldParams,
  resolveDepthOfFieldParams,
  signedDepthOfFieldCoC,
  validateDepthOfFieldFrameParams,
  validateDepthOfFieldParams,
} from './features/depth-of-field/depth-of-field-params.js';
export type {
  MotionBlurInvalidParamsDetail,
  MotionBlurParams,
  MotionBlurSampleTier,
} from './features/motion-blur/motion-blur-params.js';
export {
  DEFAULT_MOTION_BLUR_PARAMS,
  effectiveMotionBlurSampleCount,
  isMotionBlurIntervalValid,
  MotionBlurValidationError,
  motionBlurExposureScale,
  motionBlurSampleDelta,
  motionBlurTemporalDemand,
  resolveMotionBlurParams,
  validateMotionBlurParams,
} from './features/motion-blur/motion-blur-params.js';
export type {
  RenderFeatureLogicalTarget,
  RenderFeatureMaterialShaderBindingContract,
  RenderFeatureMaterialShaderContract,
  RenderFeaturePassDeclaration,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeaturePlanView,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
  RenderFeatureWorkPlan,
  RenderFeatureWorkScope,
} from './features/plan.js';
// Minimal declarative extension contract. Implementations use relative
// imports; the root does not expose prepared state, graph projectors, target
// handles, or builtin feature factories.
export type {
  RenderFeature,
  RenderFeatureCapabilityKey,
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
  RenderFeatureExtractContext,
  RenderFeatureExtractView,
  RenderFeatureFrameContext,
  RenderFeatureHiddenEntityReport,
  RenderFeaturePlacement,
  RenderFeatureShaderModuleMode,
  RenderFeatureStatus,
  RenderFeatureSubmission,
  RenderFeatureViewContext,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types.js';
export { glyphTextGeometry } from './glyph-geometry';
export {
  beginProbeIblUpdate,
  createIblKernelCache,
  createProbeIblOutput,
  type IblKernelCache,
  type ProbeIblOutput,
  type ProbeIblUpdate,
  publishProbeIblOutput,
  REFLECTION_PROBE_IBL_STAGES,
  type ReflectionProbeIblStage,
  resetIblKernelCaches,
} from './ibl/kernel-cache.js';
export type {
  BarrelDistortionInspection,
  BloomInspection,
  DepthOfFieldInspection,
  DepthOfFieldInspectionStatus,
  FrameCacheCounters,
  GpuDrivenLane,
  GpuDrivenLaneReason,
  GpuDrivenLaneSummary,
  GpuDrivenPreparationFailureInspection,
  GpuDrivenProductionInspection,
  GpuDrivenStructureMetrics,
  LightInspection,
  LodOcclusionInspection,
  MaterialTextureSourceInspection,
  MotionBlurExecutionPass,
  MotionBlurExecutionReceipt,
  MotionBlurInspection,
  MotionBlurInspectionLane,
  MotionBlurInspectionStatus,
  ReflectionFallbackFailureStage,
  ReflectionFallbackInspection,
  ReflectionFallbackReadbackReceipt,
  ReflectionFallbackReceipt,
  ReflectionFallbackRecoveryAction,
  ReflectionProbeInspection,
  ReflectionProbeSelectionInspection,
  RenderFeatureGraphInspection,
  RenderFeatureHostInspection,
  RenderFrameCacheInspection,
  ShadowCacheStatistics,
  ShadowRasterInspection,
  ShadowRasterViewInspection,
  ShadowViewIdentity,
  ShadowViewInvalidationReason,
  ShadowViewKind,
  ShadowWorkloadCommands,
  ShadowWorkloadObservation,
  ShadowWorkloadPass,
  TransmissionInspection,
} from './inspection-types.js';
export {
  type InstanceBackendKind,
  type InstanceCollectionFailureCode,
  type InstanceCollectionFailureFacts,
  type InstanceCollectionId,
  type InstanceCollectionInfo,
  type InstanceCollectionInspection,
  type InstanceDirtyRange,
  type InstanceSubmissionLane,
  InstanceTransformsError,
} from './instances';
export { MaterialResource } from './material-resource';
export {
  type MaterialSampledTextureBudget,
  materialSampledTextureBudget,
  WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
} from './material-sampled-texture-budget';
export {
  displayP3,
  MaterialAuthoringContractError,
  type MaterialColorInput3,
  type MaterialColorInput4,
  type MaterialColorTuple3,
  type MaterialColorTuple4,
  Materials,
  MaterialTransmissionContractError,
  srgb,
} from './materials.js';
export {
  type MeshMaterialBindingObservation,
  type MeshMaterialBindingPreparationFailure,
  type MeshMaterialBindingReadiness,
  type MeshMaterialBindingResidency,
  type MeshMaterialBindingSamplerObservation,
  type MeshMaterialBindingSummary,
  type MeshMaterialBindingTextureObservation,
  projectMeshMaterialBindingObservation,
  summarizeMeshMaterialBindings,
} from './mesh-material-bindings.js';
export {
  classifyOitDraw,
  OIT_INELIGIBLE_REASONS,
  type OitDrawEligibility,
  type OitIneligibleReason,
} from './oit/eligibility.js';
export type { TransparencyInspection, TransparencyViewReason } from './oit/view.js';
export {
  appliedOutputColorSpace,
  isOutputColorSpace,
  OUTPUT_COLOR_SPACES,
  OUTPUT_GAMUT_CODE,
  type OutputColorSpace,
  type OutputColorSpaceFallback,
  type OutputColorSpaceFallbackObservation,
  type OutputColorSpaceReport,
} from './output-color-space.js';
export type { DynamicResolutionInspection } from './pipeline/dynamic-resolution';
export type { RenderExtent } from './pipeline/render-extent.js';
export type {
  StandardClusterTransportInspection,
  StandardLightingInspection,
  StandardNoLocalLightingInspection,
} from './pipeline/standard-lighting/inspection.js';
export type {
  AutoExposureCapabilityUnavailableDetail,
  AutoExposureError,
  AutoExposureErrorCode,
  AutoExposureErrorDetail,
  AutoExposureErrorDetailByCode,
  AutoExposureErrorRecord,
  AutoExposureInspection,
  AutoExposureInspectionInput,
  AutoExposureInvalidParameterDetail,
  AutoExposureReceipt,
  AutoExposureResetReason,
  AutoExposureStageFailedDetail,
  AutoExposureStaleGenerationDetail,
} from './pipeline/standard-output/auto-exposure/inspection.js';
export {
  AutoExposureCapabilityUnavailableError,
  AutoExposureInvalidParameterError,
  AutoExposureStageFailedError,
  AutoExposureStaleGenerationError,
  createAutoExposureError,
  createAutoExposureInspection,
} from './pipeline/standard-output/auto-exposure/inspection.js';
export type {
  StandardLutFailure,
  StandardLutState,
} from './pipeline/standard-output/lut-state.js';
// The host-facing default is a stable profile value; implementation-only
// pipeline helpers remain behind the package boundary.
export {
  DEFAULT_STANDARD_PROFILE,
  type StandardBakedDiffuseGi,
  type StandardCardCapture,
  type StandardDiffuseGi,
  type StandardExactDiffuseGi,
  type StandardGlobalSdfRegion,
  type StandardIrradianceField,
  type StandardIrradianceFieldGi,
  type StandardProbeClipmap,
  type StandardProbeGlobal,
  type StandardProbePlacement,
  type StandardProbePlacementSeed,
  type StandardScreenProbeGi,
  type StandardScreenProbes,
  type StandardVolumetricFogProfile,
  type StandardVolumetricFogQuality,
} from './pipeline/standard-profile.js';
export {
  OIT_ACCUMULATE_PASS,
  OIT_COMPOSITE_PASS,
} from './pipeline/standard-transparency.js';
export { renderComponentsPlugin } from './plugin.js';
export {
  inspectPointShadow,
  type PointShadowInspection,
} from './point-shadow-inspection.js';
export {
  admitPointsLines,
  type LinesStyleInput,
  type PointsLinesAdmission,
  type PointsLinesAdmissionError,
  type PointsLinesAdmissionInput,
  type PointsLinesAdmissionLimits,
  type PointsStyleInput,
} from './points-lines/admission.js';
export type { PointsLinesInspection } from './points-lines/inspection.js';
export {
  type PreparedPublishedMeshResidency,
  type PublishedMeshPreparation,
  type PublishedRenderFrameInput,
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  renderPublicationAssetTransfers,
  renderPublicationBytes,
  renderPublicationTransfers,
} from './publication/contract';
export { createRenderPublisher, type RenderPublicationCandidate } from './publication/publisher';
export { RenderPublicationTargetOwner, type RenderTargetAuthoring } from './publication/targets';
export {
  DIFFUSE_GI_TIER_BUDGETS,
  DIFFUSE_GI_TIERS,
  type DiffuseGiTier,
  type DiffuseGiTierBudget,
  type DiffuseGiTierFallbackReason,
  type DiffuseGiTierLane,
  type DiffuseGiTierProfile,
  type DiffuseGiTierResolution,
  type DiffuseGiTierScene,
  parseDiffuseGiTier,
  resolveDiffuseGiTier,
} from './raytracing/diffuse-gi-tier.js';
export {
  IRRADIANCE_VOLUME_KIND,
  type IrradianceVolume,
  type IrradianceVolumeError,
  type IrradianceVolumeErrorCode,
  irradianceVolumeContribution,
  irradianceVolumeKind,
  validateIrradianceVolume,
} from './raytracing/irradiance-volume.js';
export type { BakedFieldInspection } from './raytracing/renderer-baked-field.js';
export { resolveVisibleSurface, type VisibleSurfaceIdentity } from './raytracing/visible-surface';
/**
 * Public bounded GPU pass facts. Use the single `gpuPassTiming` opt-in,
 * `draw()` receipt, and `observe(receipt, { include: ['timings'] })` route.
 * Branch on the closed statuses `complete`, `partial`, `unavailable`, and
 * `failed`; each reason/error exposes `code`, `expected`, `hint`, and `detail`.
 * `latestKnownGood` is separate from current status and completeness. These
 * facts describe pass durations, never frame latency. The bounded contract is
 * in `record/gpu-pass-timing/contract.ts`; benchmark acceptance is fail-closed
 * in `bench/gpu-pass-timing/validator.ts`, and recovery follows the producer's
 * structured hint rather than a second timing API.
 */
export type {
  GpuPassTimingCapability,
  GpuPassTimingEntry,
  GpuPassTimingError,
  GpuPassTimingErrorCode,
  GpuPassTimingFrame,
  GpuPassTimingMeasuredEntry,
  GpuPassTimingMeasurementSource,
  GpuPassTimingObservation,
  GpuPassTimingOptions,
  GpuPassTimingPassIdentity,
  GpuPassTimingRef,
  GpuPassTimingUnmeasuredEntry,
} from './record/gpu-pass-timing/index.js';
// Runtime contract: leases, frame receipts, detached inspection, profile,
// lifecycle state, and the single renderer event stream.
export {
  advanceProbeFilter,
  boxProjectReflectionDirection,
  commitProbeFilterStep,
  createProbeFilterState,
  type ProbeFilterState,
  probeFilterIsSteady,
} from './reflection/filter.js';
export {
  buildReflectionProbeTable,
  type ReflectionProbeTable,
  type ReflectionProbeTableRow,
} from './reflection/gpu-table.js';
export {
  inspectReflectionFallback,
  type ReflectionFallbackFailureInput,
} from './reflection/inspection.js';
export {
  admitReflectionProbe,
  DEFAULT_REFLECTION_PROBE_LIMITS,
  estimateReflectionProbeBytes,
  type ReflectionProbeAdmission,
  type ReflectionProbeAdmissionLimits,
  type ReflectionProbeFact,
  type ReflectionProbeInput,
  ReflectionProbeProjection,
  type ReflectionProbeProjectionSnapshot,
  type ReflectionProbeSelection,
  type ReflectionProbeSelectionResult,
  type SkylightSelection,
  selectReflectionProbe,
  validateReflectionProbeInput,
} from './reflection/projection.js';
export type {
  CameraOutputSnapshot,
  CubeCameraSnapshot,
  DrawObservation,
  FrameCamera,
  FrameEnvironment,
  FrameObservationRequest,
  FramePresentation,
  FramePresentationPendingReason,
  FrameReceipt,
  FrameReceiptObservation,
  MaterialDrawObservation,
  RecordedPipelineReference,
  Renderer,
  RendererEvent,
  RendererOptions,
  RendererState,
  RenderFrameInput,
  RenderInspection,
  RenderPreparationSchedule,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
} from './render-contract.js';
export { RENDER_PHASE_CATALOG } from './render-contract.js';
export type { TemporalInspectionStatus } from './renderer-inspect.js';
export type { RenderSceneBounds } from './scene/render-scene-types.js';
export type {
  LodOcclusionInspectionInput,
  LodOcclusionInspectionRow,
  LodOcclusionInspectionSample,
  LodOcclusionInspectionSubmit,
  LodOcclusionWorldAttribution,
  LodOcclusionWorldInspection,
  LodOcclusionWorldInspectionInput,
} from './scene/visibility/inspection.js';
export {
  inspectLodOcclusion,
  LOD_OCCLUSION_INSPECTION_MAX_BYTES,
  LOD_OCCLUSION_INSPECTION_SCHEMA,
  serializeLodOcclusionInspection,
} from './scene/visibility/inspection.js';
export {
  SHADOW_ATLAS_DEFAULT_FACE_SIZE,
  SHADOW_ATLAS_DEFAULT_LAYERS,
  ShadowAtlas,
} from './shadow-atlas.js';
export type {
  SsrAdmissionBudget,
  SsrAdmissionFailure,
  SsrAdmissionIdentity,
  SsrAdmissionInput,
  SsrAdmissionResult,
  SsrAdmissionWork,
  SsrDependenciesInspection,
  SsrFormatReceipt,
  SsrReflectionFallbackReceipt,
  SsrSpatialAdmission,
  SsrSpatialCamera,
  SsrSpatialCapabilities,
  SsrSpatialEnvironment,
  SsrSpatialLane,
  SsrSpatialStatus,
  SsrTemporalReceipt,
} from './ssr/admission.js';
export {
  admitSsrM0,
  admitSsrSpatial,
  projectSsrDependencies,
  resolveSsrAdmissionGeneration,
  SSR_FORMAT_PROFILE,
  SSR_FORMAT_STAGES,
  validateScreenSpaceReflection,
  zeroSsrAdmissionWork,
} from './ssr/admission.js';
export {
  composeSsrReflection,
  type SsrCompositionInput,
  type SsrCompositionInputError,
  type SsrCompositionResult,
  type SsrReflectionColor,
} from './ssr/composition.js';
export type {
  SsrConfigField,
  SsrConfigInvalidError,
  SsrConfigRange,
  SsrSpatialUnavailableReason,
  SsrUnavailableError,
} from './ssr/errors.js';
export type {
  SsrSpatialHistoryInspection,
  SsrSpatialInspection,
  SsrSpatialInspectionFailure,
  SsrSpatialInspectionProjection,
} from './ssr/inspection.js';
export {
  projectSsrSpatialInspection,
  serializeSsrSpatialInspection,
} from './ssr/inspection.js';
export {
  type DynamicInputConsumptionReceipt,
  type DynamicInputDirtyRange,
  DynamicInputError,
  type DynamicInputErrorCode,
  type DynamicInputErrorDetail,
  type DynamicInputRange,
  type DynamicInputResult,
  type DynamicInputUploadReceipt,
  type DynamicInputValue,
  ReadonlyDynamicInputPage,
  type SurfaceDynamicInputFrame,
  type SurfaceDynamicInputMemberIdentity,
} from './surface/dynamic-input.js';
export {
  admitSingleLayerMediumSubmission,
  type SurfaceGpuCapability,
  type SurfaceGpuFallbackReason,
  type SurfaceGpuPassAdmission,
  type SurfaceGpuSubmissionAdmission,
  type SurfaceGpuSubmissionError,
  type SurfaceGpuSubmissionErrorCode,
  type SurfaceGpuSubmissionInput,
} from './surface/gpu-driven.js';
export type { SurfaceGpuIndirectParameters } from './surface/submission-observation.js';
export { getActiveCamera, setActiveCamera } from './systems/active-camera.js';
export type {
  FramebufferSnapshotData,
  FramebufferSnapshotRegion,
  FramebufferSnapshotRequest,
  FramebufferSnapshotTicket,
  RenderTarget,
  RenderTargetAdmissionLimits,
  RenderTargetDepthFormat,
  RenderTargetDescriptor,
  RenderTargetFormat,
  RenderTargetLayeredShape,
  RenderTargetMipLevels,
  RenderTargetReadbackData,
  RenderTargetReadbackRequest,
  RenderTargetReadbackTicket,
  RenderTargetSampleCount,
  RenderTargetShape,
  RenderTargetTextureAspect,
  RenderTargetTextureSource,
  RenderTargetTextureSourceOptions,
} from './targets/contracts.js';
export { renderTargetLayerCount } from './targets/contracts.js';
export type { TemporalInspection, TemporalResourceInspection } from './temporal/inspection.js';
export {
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataLane,
  type SceneDataSchemaId,
  type SceneDataTarget,
  type SceneDataTemporalV1Descriptor,
} from './temporal/scene-data.js';
export {
  createSceneDataCatalog,
  type SceneDataAvailability,
  type SceneDataCatalog,
  type SceneDataCatalogOptions,
  type SceneDataInspection,
} from './temporal/scene-data-catalog.js';
export type { TemporalView } from './temporal/view.js';
export {
  querySubmittedTerrainHeight,
  type SubmittedTerrainHeightRequest,
} from './terrain/submitted.js';
export { CanvasTexture, type CanvasTextureSource } from './textures/canvas-texture';
export {
  type ExternalTexture,
  type ExternalTextureInput,
  type ExternalTextureKind,
  type ExternalTextureSource,
  isExternalTextureSource,
} from './textures/external-texture';
export { tilemapGeometry } from './tilemap-geometry';
export {
  composeSingleLayerMediumColor,
  integrateSingleLayerMedium,
  type MediumVector3,
  resolveSingleLayerMediumBackground,
  type SingleLayerMediumBackgroundCandidate,
  type SingleLayerMediumBackgroundInput,
  type SingleLayerMediumBackgroundReason,
  type SingleLayerMediumBackgroundResolution,
  type SingleLayerMediumCoefficients,
  type SingleLayerMediumOptics,
} from './transmission/single-layer-medium.js';
export {
  hasVolumetricFogCapability,
  type IntegratedVolumeResource,
  resolveIntegratedVolumeConsumer,
  resolveSelectedVolumetricLight,
  resolveVolumetricFogLightPair,
  type VolumeConsumer,
  type VolumetricFogLightKind,
  type VolumetricFogLightPairResolution,
  type VolumetricFogLightResolution,
} from './volume/capability.js';
export {
  MAX_VOLUMETRIC_FOG_OWNERS,
  type ValidatedVolumetricFog,
  type VolumeBounds,
  type VolumeDensityBinding,
  VolumetricFog,
  type VolumetricFogAuthoring,
  VolumetricFogSamplingValue,
  validateVolumetricFog,
} from './volume/component.js';
export { extractVolumetricFog, type VolumetricFogExtract } from './volume/extract.js';
export {
  inspectVolumetricFog,
  type VolumetricFogInspection,
  type VolumetricFogInspectionInput,
  type VolumetricFogInspectionStatus,
  type VolumetricFogResourceStage,
} from './volume/inspection.js';
