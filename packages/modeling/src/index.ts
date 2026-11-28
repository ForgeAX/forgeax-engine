export type { Affine, Angles } from './affine';
export type { ArrayOptions } from './array';
export {
  ASSET_OUTPUT_PROFILES,
  type AssetBudgetCode,
  type AssetMaterialUv,
  type AssetOutputProfile,
  type AssetOutputProfileId,
  type AssetPart,
  type AssetStats,
  type AssetStatsOptions,
  assetStats,
  checkAssetBudget,
} from './asset-budget';
export {
  type AnalyticOptions,
  type AtlasBleedReport,
  type AtlasGrid,
  atlasBleedReport,
  BAKE_COOK_KIND,
  type BakeCageGroupPlan,
  type BakeCageOptions,
  type BakeCagePlan,
  type BakeCageStrayPart,
  type BakeCookInput,
  type BakeCookSource,
  type BakeCorrespondence,
  type BakeCorrespondOptions,
  type BakeEvalOptions,
  type BakeExecutor,
  type BakeFailure,
  type BakeLowpolyOptions,
  type BakeLowpolyResult,
  type BakeOptions,
  type BakeResult,
  type BakeSettings,
  type BakeSourceOptions,
  type BakeTarget,
  bakeCorrespond,
  bakeCorrespondWithGpu,
  bakeLowpoly,
  bakeLowpolyWithGpu,
  bakeMaps,
  bakeMapsParallel,
  bakeMapsWithGpu,
  bakeSources,
  createBakeCooker,
  type DilateAtlasOptions,
  type DilateAtlasResult,
  dilateAtlas,
  dilateAtlasWithGpu,
  evaluateBakeMaps,
  evaluateBakeMapsWithGpu,
  resolveBakeCages,
} from './bake';
export { BAKE_CHECKS, type BakeCheck, type BakeValidateOptions } from './bake-checks';
export type { BevelOptions } from './bevel';
export {
  type BlendOptions,
  type BlendResult,
  blendSurfaces,
  type SurfaceBlend,
  type SurfaceCorner,
} from './blend';
export {
  type BomCode,
  type BomGeometry,
  type BomItem,
  type BomMaterial,
  type BomReport,
  type BomRow,
  bom,
  bomTable,
} from './bom';
export type { BooleanOptions } from './boolean';
export {
  type CaptureOptions,
  captureModels,
  MAX_CHECKPOINTS,
  MAX_STEP_BYTES,
  type SourceSite,
} from './capture';
export type {
  Beat,
  Choreography,
  ChoreographyOptions,
  ChoreographyPhase,
  ReadPoint,
} from './choreograph';
export {
  BAKE_MAP_KINDS,
  BAKE_TILE,
  type BakeRows,
  type BakeSurface,
  bakePhases,
  bakeSurface,
  MATERIAL_ID_PALETTE,
  type PreparedBake,
  tsBakeBackend,
} from './compute/bake-ts';
export { jobTriangles, TS_BACKEND_IDENTITY, tsBackend } from './compute/boolean-ts';
export { type NearestPoint, type RayHit, TriangleBvh } from './compute/bvh';
export type {
  AnalyticFallback,
  AnalyticMap,
  AnalyticPatch,
  AnalyticVerify,
  BakeAnalyticParams,
  BakeAnalyticReport,
  BakeBounds,
  BakeCage,
  BakeClipCluster,
  BakeDirection,
  BakeGroupReport,
  BakeGroupSettings,
  BakeJobNormals,
  BakeJobParams,
  BakeMapKind,
  BakeMissCluster,
  BakeProvenance,
  BakeSlot,
  BakeStrayCluster,
  UvChartJobParams,
  UvChartMetrics,
  UvChartProvenance,
} from './compute/job';
export {
  type BackendOutput,
  type BooleanJobParams,
  type BooleanOperation,
  COMPUTE_JOB_KINDS,
  type ComputeBackend,
  type ComputeBackendName,
  type ComputeJobKind,
  type ComputeJobParams,
  type ComputeJobProvenance,
  type ComputeJobReport,
  type ComputeJobRequest,
  type ComputeJobResult,
  type ComputeLocation,
  type ComputeLocationReason,
  type ComputeOptions,
  type ComputePolicy,
  type ComputeQuality,
  type ConstraintLevel,
  computeCacheKey,
  DEFAULT_WORK_BUDGET,
  type EdgeProvenance,
  type FaceProvenance,
  type QuadricKind,
  type RegionJobParams,
  type RegionOperation,
  type RemeshConstraints,
  type RemeshJobParams,
  type RemeshOperation,
  resolveBackend,
  runComputeJob,
  type SkinBindJobParams,
  type SkinBone,
  type SolveMethod,
  type SolveSparseParams,
  type SourceFaceProvenance,
  type SubdivideJobParams,
  type SubdivisionBoundary,
  type SubdivisionScheme,
  type UnwrapMethod,
  type UvIslandMetrics,
  type UvIslandProvenance,
  type UvPackJobParams,
  type UvPackProvenance,
  type UvPinRule,
  type UvPlacement,
  type UvRefineStatus,
  type UvStraightenIsland,
  type UvStraightenJobParams,
  type UvStraightenProvenance,
  type UvStraightenStatus,
  type UvUnwrapJobParams,
  type VoxelJobParams,
  type VoxelOperation,
  type VoxelSign,
  WorkMeter,
} from './compute/job';
export type { Flow, FlowGuide } from './compute/line-field';
export { tsProcessBackend } from './compute/process-backend';
export { SKIN_INFLUENCES, tsSkinBackend } from './compute/skin-ts';
export {
  type CsrMatrix,
  decodeVector,
  encodeCsr,
  encodeVector,
  solveSparse,
  TripletList,
} from './compute/sparse';
export { tsSubdivideBackend } from './compute/subdivide-ts';
export { mipChainWithGpu, packTextureWithGpuMips } from './compute/texture-webgpu';
export { tsUvBackend } from './compute/uv-backend';
export { measureUv, type UvMeasurement } from './compute/uv-ts';
export { decodeSdf, encodeSdf, type SdfData } from './compute/voxel-ts';
export { growOutline, outlineDeviation } from './contour';
export { CREASE_INFINITE, CREASE_STEPS, edgeSharpness, flagSharpness } from './crease';
export {
  type FrameMode,
  type PathBend,
  type PathInput,
  type PathSpec,
  path,
} from './curve';
export type { CutPlane, LoopCutOptions, PlaneCutOptions, SupportLoopOptions } from './cut';
export type {
  AxisRange,
  BendOptions,
  CageOptions,
  CurveDeformOptions,
  DeformBounds,
  LatticeOptions,
  SmoothOptions,
  TaperOptions,
  TwistOptions,
} from './deform';
export {
  type ArapHandle,
  type ArapOptions,
  type DeformSolverOptions,
  type HandleRotation,
  type ImplicitSmoothOptions,
  meanCurvatures,
  type PinRule,
} from './deform-solve';
export {
  DELIVERY_ERROR_HINTS,
  type DeliverBake,
  type DeliveredAsset,
  type DeliverOptions,
  type DeliveryAttempt,
  type DeliveryBakeReport,
  type DeliveryError,
  type DeliveryErrorCode,
  type DeliveryPart,
  type DeliveryReport,
  type DeliverySource,
  type DeliveryStep,
  type DeliveryStepReport,
  deliverAsset,
} from './deliver';
export {
  OVERLAY_KINDS,
  type Overlay,
  type OverlayKind,
  type OverlayLegendEntry,
  overlayMesh,
  projectOverlay,
} from './diagnostics';
export {
  type Delta,
  type DiffElement,
  type DiffOptions,
  diffMeshes,
  type MeshDiff,
  type MeshDifference,
  type MeshDiffReason,
  type ProvenanceDiff,
} from './diff';
export {
  type ApplyDraftOptions,
  type DraftClass,
  type DraftFace,
  type DraftOptions,
  type DraftReport,
  draft,
} from './draft';
export {
  type BaseView,
  type Contour,
  type CurveSpec,
  type DetailView,
  DRAWING_ROLES,
  type Drawing,
  type DrawingCurve3Options,
  type DrawingItem,
  type DrawingRole,
  type DrawingSource,
  type DrawingView,
  type DrawnDimension,
  type DrawnLine,
  type DrawnNote,
  type DrawnPoint,
  type DrawnTable,
  drawingBaseView,
  drawingCurve3,
  drawingViewFrame,
  type ExplodedPart,
  type ExplodeGrouping,
  type ExplodeOptions,
  type ExplodeView,
  evenOddFill,
  evenOddHatch,
  explodeMesh,
  FILL_WORK_LIMIT,
  fromPlane,
  hatchSpacing,
  planeFrame,
  type ResolvedCurve,
  type ResolvedDrawing,
  resolveCurveSpec,
  resolveDrawing,
  type Segment2,
  sectionSegments,
  TABLE_CELL_LIMIT,
} from './drawing';
export {
  type DrawingCheck,
  type DrawingCheckOptions,
  type DrawingFinding,
  type MaskIoU,
  maskIoU,
  silhouetteIoU,
} from './drawing-check';
export { explodeDrawing, meshViewEdges } from './drawing-explode';
export {
  drawingDxf,
  drawingSvg,
  type SheetOptions,
  type SheetSize,
  type SheetSpec,
  type SheetTitle,
} from './drawing-export';
export {
  HLR_CREASE_ANGLE,
  HLR_WORK_LIMIT,
  meshViewLines,
  type ViewLinesOptions,
} from './drawing-hlr';
export {
  drawingPng,
  drawingRaster,
  RASTER_PIXEL_LIMIT,
  type RasterImage,
  type RasterOptions,
} from './drawing-raster';
export { drawingTable, type TableSource } from './drawing-table';
export {
  checkEdgeFlow,
  type Distribution,
  type EdgeFlowCode,
  type EdgeFlowOptions,
  type EdgeFlowReport,
  type FeatureLoop,
  faceAspect,
} from './edge-flow';
export {
  MODELING_ERROR_HINTS,
  ModelingError,
  type ModelingErrorCode,
  type ModelingErrorDetail,
  type ModelingSite,
} from './errors';
export type { ExportTopology } from './export-topology';
export type { Falloff, FalloffCurve, FalloffDistance } from './falloff';
export {
  type ClipReport,
  EDGE_KIND,
  type ExportOptions,
  type ExportReport,
  type ExportResult,
  type ExportSidecar,
  edgeKinds,
  exportMesh,
  type NormalMode,
} from './finish';
export {
  type FontErrorReason,
  type FontRegionOptions,
  type FontRegionResult,
  fontRegion,
  type GlyphInfo,
  parseTrueTypeFont,
  type TrueTypeFont,
} from './font';
export { decodeSnapshot, encodeSnapshot, FXEM_VERSION } from './fxem';
export { type Axis, meshVolume, type SignedAxis, type Tuple3 } from './geom';
export { type HighlightLine, type HighlightOptions, highlightLines } from './highlight-lines';
export type { HoleCutOptions, HoleKind } from './hole';
export type {
  ConnectivityOptions,
  ConnectivityPose,
  ConnectivityReport,
  DesignedContact,
  FitCheck,
  FloatingPart,
  InterferenceBasis,
  InterferenceOptions,
  InterferencePair,
  InterferenceReason,
  InterferenceReport,
  InterferenceStatus,
  ScanOptions,
  ScanPair,
  ScanReport,
  ScanSample,
  ScanStatus,
} from './interference';
export {
  checkInvariants,
  debugValidate,
  type Generations,
  generationsOf,
  type InvariantCode,
  type InvariantViolation,
} from './invariants';
export type { KnifeOptions } from './knife';
export type { LayerOptions } from './layer';
export {
  checkLayout,
  type LayoutCheckOptions,
  type LayoutCode,
  type LayoutEdge,
  type LayoutFit,
  type LayoutPatch,
  type LayoutSide,
  type LayoutState,
  type PatchLayoutSpec,
  type PatchRole,
  type ResolvedLayout,
  resolveLayout,
  type SideRef,
} from './layout';
export { type LodTopology, lodTopologyReport } from './lod-topology';
export type { LowpolyIssueCode, LowpolyLost, LowpolyOptions, LowpolySlivers } from './lowpoly';
export { type MassProperties, massProperties } from './mass';
export {
  type CarbonFiberOptions,
  type CarPaintOptions,
  type EmissiveOptions,
  type GlassOptions,
  type MetalOptions,
  proceduralMaterials,
  type StandardMaterialOptions,
  type TexturePlacement,
  type TextureReference,
  type TextureSink,
  type TireOptions,
} from './materials';
export {
  CORNER_CHANNEL_DIMENSIONS,
  type CornerChannelName,
  EDGE_SEAM,
  EDGE_SHARP,
  EditMesh,
  FACE_EDGE_ROUND,
  FACE_FLOAT,
  FACE_MIRRORED,
  FACE_SURFACE_TRIM,
  NONE,
  PART_ROLES,
  type PartRole,
  partRole,
} from './mesh';
export {
  type AssetsJob,
  type AssetsJobError,
  assetsJobOutputs,
  assetsJobSources,
  buildMeshJobSet,
  createMeshJobCooker,
  type JsonValue as MeshJobFingerprint,
  MESH_JOB_COOK_KIND,
  type MeshJob,
  type MeshJobCookInput,
  type MeshJobCookSource,
  type MeshJobExecutor,
  type MeshJobRequest,
  type MeshJobSetResult,
  meshJobSources,
  type RigJob,
  rigJobOutputs,
  rigJobSources,
} from './mesh-job';
export {
  MESH_QUALITY_LIMITS,
  type MeshQualityLimits,
  type MeshQualityReport,
  meshQuality,
} from './mesh-quality';
export {
  type CornerChannelView,
  type EditMeshSoaViews,
  type EditMeshStore,
  type KernelPolicy,
  type MeshSnapshotToken,
  TsEditMeshStore,
} from './mesh-store';
export {
  createEditMeshStore,
  kernelErrorToModelingError,
  RustEditMeshStore,
  syncRustToTs,
  syncTsToRust,
} from './mesh-store-rust';
export {
  type Checkpoint,
  type ExtrudeContourOptions,
  type FinishOptions,
  InvariantError,
  type JournalEntry,
  Model,
  type ModelDiagnostics,
  type ModelInspection,
  type ModelOptions,
  model,
  type OpReport,
  type OpStatus,
  type SmoothOperation,
  type StepSnapshot,
  type ThreeViewOptions,
} from './model';
export { type SweepOverlap, SweptVolume, sweepOverlap } from './motion-space';
export {
  type ApproximateOptions,
  type InterpolateOptions,
  type LoftSurfaceOptions,
  type NetworkOptions,
  type NurbsCurve,
  type NurbsSurface,
  nurbs,
  type Parametrization,
  type SurfaceCurvature,
} from './nurbs';
export type { FairSurfaceOptions, FitSurfaceOptions, FitSurfaceResult } from './nurbs-fit';
export type { MatchLevel, MatchOptions, MatchResult } from './nurbs-match';
export type { OffsetSurfaceOptions, OffsetSurfaceResult } from './nurbs-offset';
export type { ExtendOptions, SurfaceDirection } from './nurbs-surface';
export type {
  BirailOptions,
  BirailResult,
  RailSweepOptions,
  RailSweepResult,
} from './nurbs-sweep';
export type {
  OpDiagnostic,
  ProjectionMode,
  ProjectOptions,
  RegionMode,
  RepairReport,
  RepairSite,
  RoleCounts,
} from './ops';
export { REGION_MODES } from './ops';
export type { PanelLineOptions, PanelProfile } from './panel';
export {
  type BakeGroupsOptions,
  type IdMap,
  type IdMapGroup,
  type IdMapOptions,
  idMap,
  type PartGroup,
} from './part-groups';
export type { PathExtrudeOptions } from './path-extrude';
export type { PipeBendOptions } from './pipe-bend';
export type { PipeNetworkOptions } from './pipe-network';
export type { PipeWeldOptions } from './pipe-weld';
export type { QuadMetrics, QuadOptions } from './planar';
export type { PoseCode, PoseReport, PoseReportOptions } from './pose-report';
export type {
  BoxOptions,
  ConeOptions,
  CylinderOptions,
  ExtrudePolygonOptions,
  PlaneOptions,
  Point2,
  PolygonOptions,
  RevolveOptions,
  SphereOptions,
  TorusOptions,
} from './primitives';
export * from './recipes';
export {
  type RegenFinding,
  type RegenOptions,
  type RegenReason,
  type RegenReport,
  type RegenRun,
  regen,
} from './regen';
export {
  type OffsetOptions,
  type Region2,
  type RegionInput,
  type RegionOptions,
  type RegionResult,
  region2d,
  type Shape2,
  toRegion,
} from './region2d';
export type {
  PreserveLevel,
  PreserveOptions,
  RemeshOptions,
  SimplifyOptions,
  TilingOptions,
} from './remesh';
export type { Issue, Severity } from './report';
export {
  type AutoWeightOptions,
  type BindReport,
  type ClaimConflict,
  type Clamp,
  type JointEffort,
  type JointKind,
  type JointPose,
  type JointSpec,
  type JointStop,
  type JointValue,
  type LimitMode,
  type LoopSolution,
  type MobilityReport,
  type MotionCode,
  type MotionReport,
  type MotionReportOptions,
  type PathInterpolation,
  type PhaseClaim,
  type PhaseClaimsCode,
  type PhaseClaimsOptions,
  type PhaseClaimsReport,
  type Pose,
  type PoseKey,
  type PoseOptions,
  type PosePath,
  type PoseResult,
  type Range,
  type ReleaseFace,
  type ReleaseOptions,
  type ReleaseReport,
  Rig,
  type RigClipSpec,
  type RigExportForm,
  type RigFinishOptions,
  type RigPart,
  type RigSpec,
  type RigSweepOptions,
  rig,
  type SkinWeights,
  STEEL_DENSITY,
  type StopCheck,
  type StopFinding,
  type StopReport,
  type StopReportOptions,
} from './rig';
export type {
  HardwareElement,
  MountedJoint,
  MountHardwareOptions,
  MountHardwareReport,
  UnroutableMount,
} from './rig-hardware';
export type { LoopClosure, LoopSpec } from './rig-loops';
export type {
  RigLeader,
  RigManifest,
  RigManifestIssue,
  RigManifestIssueCode,
  RigManifestJoint,
  RigManifestPart,
  RigPose,
  RigPoseClamp,
  RigPoseError,
  RigPoseErrorCode,
  RigPoseOptions,
  RigPoseValue,
  RigQuat,
  RigRange,
  RigSphericalLimits,
  RigStopEnd,
  RigTransform,
} from './rig-manifest';
export {
  poseRigManifest,
  RIG_MANIFEST_HINT,
  RIG_MANIFEST_SCHEMA,
  RIG_POSE_ERROR_HINTS,
  readRigManifest,
  rigManifestJson,
} from './rig-manifest';
export {
  type Bounds3,
  type Quat,
  SCENE_MANIFEST_ERROR_HINTS,
  SCENE_OUTPUT_PROFILES,
  type SceneAsset,
  type SceneBudgetCode,
  type SceneManifest,
  type SceneManifestAsset,
  type SceneManifestError,
  type SceneManifestErrorCode,
  type SceneManifestInstance,
  type SceneManifestLod,
  type SceneManifestTexture,
  type SceneManifestTotals,
  type SceneOutputProfile,
  type SceneOutputProfileId,
  type ScenePlacement,
  type SceneWarningCode,
  sceneManifest,
  sceneTrianglesAt,
} from './scene-manifest';
export {
  measureSeamVisibility,
  type SeamChain,
  type SeamIslandScore,
  type SeamVisibilityOptions,
  type SeamVisibilityReport,
} from './seam-visibility';
export {
  type Cardinality,
  type Domain,
  decodeSelectorAst,
  type EdgeSelector,
  edgeSel,
  encodeSelectorAst,
  evaluateSelectorAst,
  type FaceSelector,
  faceSel,
  type HitRule,
  type Inclusion,
  isPureSelectorAst,
  Selector,
  type SelectorAst,
  type SelectorUse,
  sel,
  type VertSelector,
} from './selectors';
export { type SheetBend, type SheetMetalSpec, sheet } from './sheet';
export {
  type BendForming,
  type FormingCode,
  type FormingReport,
  SHEET_MATERIALS,
  type SheetFormingOptions,
  type SheetMaterial,
  sheetForming,
} from './sheet-forming';
export type { ShellDirection, ShellFlange, ShellOptions } from './shell';
export { SHELL_WALL_ROLES } from './shell';
export {
  type ShrinkwrapMode,
  type ShrinkwrapOptions,
  type SurfacePoint,
  SurfaceQuery,
} from './shrinkwrap';
export {
  DTS_ZONES,
  type DtsRow,
  measureShutLines,
  type ShutLineCheck,
  type ShutLineException,
  type ShutLineLimits,
  type ShutLineOptions,
  type ShutLineReport,
  type ShutLineRow,
  type ShutLineStats,
  type ShutLineStatus,
  type ShutLineZone,
} from './shut-lines';
export type {
  SketchConstraint,
  SketchCurve,
  SketchOptions,
  SketchSolution,
  SketchSpec,
} from './sketch';
export { sketch } from './sketch';
export {
  jointTreeOfPaths,
  reduceSkinForLod,
  type SkinLodInput,
  type SkinLodMerge,
  type SkinLodOptions,
  type SkinLodReport,
  type SkinLodResult,
  type SkinLodSkeleton,
} from './skin-lod';
export type { SoftOptions } from './soft';
export type { SpherizeOptions } from './spherize';
export {
  type BoltHexOptions,
  type GrooveOptions,
  type HoleOptions,
  type KnurlOptions,
  type OutlineStampOptions,
  type PerforationOptions,
  type RivetOptions,
  type SlotOptions,
  type Stamp,
  stamp,
  type TextStampOptions,
  type TreadPlateOptions,
  type WeldBeadOptions,
} from './stamp';
export type { StrandsOptions } from './strands';
export type { LimitKind, LimitOptions, LimitSurface } from './subd-limit';
export { subdivisionLimit } from './subd-limit';
export type { SubdivideOptions } from './subdivide';
export {
  type DomainRegion,
  type SplitAlongOptions,
  type SplitAlongResult,
  type SplitCut,
  type SurfaceImprint,
  type SurfaceOptions,
  type SurfacePatch,
  splitAlong,
} from './surface';
export {
  type ColoredTriangles,
  type CombOptions,
  type CurvatureComb,
  type CurvatureKind,
  type CurvatureShadingOptions,
  coloredMesh,
  curvatureComb,
  curvatureShading,
  divergingColor,
  type SurfaceField,
  type SurfaceFieldOptions,
  surfaceField,
  type ZebraOptions,
  zebraStripes,
} from './surface-analysis';
export {
  SURFACE_CHECKS,
  type SurfaceChannel,
  type SurfaceCheck,
  type SurfaceContract,
} from './surface-contract';
export {
  type DeviationCode,
  type DeviationOptions,
  type DeviationReport,
  type DeviationSide,
  type DeviationTarget,
  surfaceDeviation,
} from './surface-deviation';
export type { FillBoundary, FillResidual } from './surface-fill';
export {
  createModelPbrSurface,
  exportPbrTextureAssets,
  generateBrick,
  generateBrushed,
  generatePerlinFbm,
  generateWood,
  generateWorley,
  type PbrLayerOptions,
  type PbrTextureAssets,
  type RustImageBuffer,
  type RustPbrSurface,
  rustImageToTextureAsset,
  type StandardPbrTextureSet,
  type SurfaceBlendModeName,
  textureAssetToRustImage,
  type WebGpuDeviceLike,
  WebGpuSurfaceAccelerator,
  type WorleyModeName,
} from './surface-kernel';
export {
  type Continuity,
  type ContinuityEdge,
  type CurveFairness,
  type CurvePlace,
  checkSurfaceQuality,
  curveFairness,
  D09_CLASSES,
  type EdgeClass,
  type EdgeLimits,
  type EdgeResidual,
  type FairnessOptions,
  type FeatureLine,
  isoparm,
  measureEdge,
  type NamedSurface,
  type PatchSide,
  type PatchTransition,
  type SurfaceDensity,
  type SurfaceQualityCode,
  type SurfaceQualityInput,
  type SurfaceQualityOptions,
  type SurfaceQualityReport,
  type SurfaceSeam,
  type Worst,
} from './surface-quality';
export type { LoftMatch, LoftOptions, SweepOptions } from './sweep';
export {
  type FacePick,
  jaccard,
  liftedFaceTriangles,
  type PickBox,
  type PickRay,
  pickFaces,
  type SelectorSynthesis,
  type SynthesisAtom,
  type SynthesisAtomKind,
  type SynthesisOptions,
  synthesizeSelector,
  transferSelection,
} from './synthesize';
export { TEXT_CHARACTERS, type TextOptions, textRegion, textStrokes } from './text';
export {
  coverage,
  type DecalLayer,
  type DecalTextureOptions,
  type DeliveryLayout,
  decalTexture,
  fractalNoise,
  hash2,
  type MipChain,
  type MipChainOptions,
  mipChain,
  normalFromHeight,
  normalTexture,
  packFloat32Texture,
  type Rgba,
  type StudioEnvironmentOptions,
  studioEnvironment,
  type TextureOptions,
  textureFrom,
  valueNoise,
} from './texture';
export type { ThinHoleOptions, ThinHolePlan, ThinHoleReport } from './thin-hole';
export { thinHole, thinHoleCheck } from './thin-hole';
export { type ThreadDesignation, type ThreadFamily, type ThreadSpec, threads } from './threads';
export {
  bakeTrimSheet,
  TRIM_MAP_KINDS,
  type TrimAnalyticSource,
  type TrimBakeReport,
  type TrimBakeResult,
  type TrimBakeSettings,
  type TrimCode,
  type TrimFamilyUse,
  type TrimFlatSource,
  type TrimMapKind,
  type TrimMember,
  type TrimMeshSource,
  type TrimModule,
  type TrimRegion,
  type TrimRegionUse,
  type TrimReport,
  type TrimReportOptions,
  type TrimSheet,
  type TrimSheetMetrics,
  type TrimSheetOptions,
  type TrimSignature,
  type TrimSource,
  type TrimSourceContext,
  type TrimTiling,
  trimReport,
  trimSheet,
} from './trim';
export {
  type AutoUvOptions,
  crossedEdges,
  type PackOptions,
  paddingTexels,
  type SeamSource,
  type StraightenOptions,
  type SwatchUvOptions,
  type TrimFit,
  type TrimUvOptions,
  type TrimVariation,
  type UnwrapOptions,
  type UvChannel,
  type UvPadding,
} from './uv';
export {
  CHANNEL_OPS,
  type ChannelOp,
  type ChannelOptions,
  type LightmapOptions,
} from './uv-channel';
export { uvOverlapPairs } from './uv-overlap';
export { type FromPatchOptions, PATCH_UV_MODES, type PatchUvMode } from './uv-patch';
export {
  type UvCheckerOptions,
  type UvHeatmapOptions,
  uvCheckerTexture,
  uvHeatmapTexture,
} from './uv-textures';
export {
  type ValidateOptions,
  type ValidationCode,
  type ValidationReport,
  validateMesh,
} from './validate';
export {
  fromView,
  isOrthoView,
  lookFrame,
  ORTHO_VIEW_NAMES,
  ORTHO_VIEWS,
  type OrthoView,
  type PerspectiveView,
  toView,
  type ViewFrame,
} from './views';
export {
  type PartVisibility,
  VISIBILITY_FINDINGS,
  type VisibilityAudit,
  type VisibilityFinding,
  type VisibilityFindingCode,
  type VisibilityOptions,
} from './visibility-audit';
export {
  SdfGrid,
  type VoxelFillOptions,
  type VoxelizeOptions,
  type VoxelMeshOptions,
  type VoxelOffsetOptions,
  type VoxelSurfaceOptions,
  type VoxelUnionOptions,
} from './voxel';
export type {
  BoundaryChain,
  ChainCounts,
  ChainKind,
  CrossPart,
  DesignedBoundary,
  WatertightOptions,
  WatertightPart,
  WatertightReport,
} from './watertight';
export type { CoverageReference, CoverageReport } from './watertight-coverage';
