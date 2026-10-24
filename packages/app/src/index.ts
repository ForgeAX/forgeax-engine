export type {
  PackDraftField,
  PackDraftReply,
  PackDraftRequest,
  PackDraftSnapshot,
} from './workspace';
// App owns frame progress; callers supply native host facts.
// Browser construction is the explicit @forgeax/engine/app/browser entry.

export type {
  Effect,
  EffectMeta,
  Fiber,
  Inject,
  Plugin,
} from '@forgeax/engine-plugin';
export { Context } from '@forgeax/engine-plugin';
export {
  createFullscreenRenderFeature,
  type FullscreenRenderFeatureOptions,
} from '@forgeax/engine-render/authoring';
// Live load progress: Engine producers and App sessions share one page model.
export {
  addLoadPhases,
  addLoadWork,
  beginLoadSession,
  beginLoadWork,
  collectLoadTimeline,
  DEFAULT_LOAD_PROGRESS_LABELS,
  describeLoadProgress,
  ENGINE_STARTUP_PHASES,
  endLoadSession,
  type LoadPhaseDefinition,
  type LoadPhaseProgress,
  type LoadPhaseState,
  type LoadProgressLabelInput,
  type LoadProgressLabels,
  type LoadProgressSnapshot,
  type LoadProgressView,
  type LoadTimelineInspection,
  type LoadTimelineKind,
  type LoadTimelineRealmSnapshot,
  type LoadTimelineRecord,
  type LoadTimelineSnapshot,
  type LoadWork,
  markLoadTimeline,
  readLoadProgress,
  resolveLoadProgressLabels,
  subscribeLoadProgress,
} from '@forgeax/engine-types';
export type {
  AssetDecoderContributionRef,
  AssetRuntimeAssembly,
  AssetRuntimeAssemblyError,
  AssetRuntimeAssemblyOptions,
} from './assets-runtime-assembly';
export {
  assembleAssetRuntime,
  createAssetRuntimeAssembly,
  createDefaultAssetCatalogSource,
  DEFAULT_ASSET_CATALOG_URL,
} from './assets-runtime-assembly';
export {
  type BrowserFrameCompleted,
  type BrowserFrameProgress,
  type BrowserFrameSubmitted,
  FORGEAX_FRAME_COMPLETED_EVENT,
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
  resetBrowserFrameProgress,
  subscribeBrowserFrameSubmitted,
} from './browser-frame-signal';
export { canvasAspectPlugin } from './canvas-policy';
export { createApp } from './create-app';
export type {
  AppDetailCanvasDetached,
  AppDetailEmpty,
  AppDetailExecutionBootstrapFailed,
  AppDetailExecutionDeadlineExceeded,
  AppDetailExecutionKernelFailed,
  AppDetailExecutionRebuildFailed,
  AppDetailExecutionWorkerUnavailable,
  AppDetailPluginActivationFailed,
  AppDetailRendererInspectionUnavailable,
  AppDetailSystemUpdateFailed,
  AppErrorCode,
  AppErrorDetail,
  AppErrorDetailFor,
  RendererInspectionFailureReason,
} from './errors';
export {
  APP_ERROR_HINTS,
  APP_EXPECTED,
  AppError,
  createRendererInspectionError,
  isAppError,
} from './errors';
export type {
  ExecutionAssetCatalog,
  ExecutionBootstrapEntry,
  ExecutionBootstrapHost,
  ExecutionBootstrapValue,
  ExecutionCapabilities,
  ExecutionCapabilityFact,
  ExecutionCapabilityName,
  ExecutionControl,
  ExecutionEngineHealth,
  ExecutionFault,
  ExecutionFrameInspection,
  ExecutionGeometryObservationResult,
  ExecutionMeasurement,
  ExecutionOptions,
  ExecutionRenderCapabilities,
  ExecutionRendererInspectionContext,
  ExecutionRendererInspectionOptions,
  ExecutionRendererInspectionResult,
  ExecutionRenderLimits,
  ExecutionReport,
  ExecutionSelection,
  ExecutionWorker,
  ExecutionWorkerDecision,
  ExecutionWorkerPolicy,
  ExecutionWorkersOptions,
  KernelDispatchReason,
  PreparedExecutionBootstrap,
} from './execution';
export {
  activateExecutionRoot,
  createExecutionFrameInspection,
  createExecutionReport,
  EXECUTION_CAPABILITY_NAMES,
  EXECUTION_REPORT_SCHEMA_VERSION,
  EXECUTION_WORKERS,
  executionBootstrapHostPlugin,
  isExecutionReport,
  loadBootstrapEntry,
  missingExecutionCapabilities,
  prepareBootstrapEntry,
  probeExecutionCapabilities,
  selectExecutionWorkers,
  unavailableExecutionCapabilities,
  validateExecutionBootstrapData,
} from './execution';
export { ensureFallbackCamera } from './fallback-camera';
export type {
  GameActionArgsSchema,
  GameActionDef,
  GameHost,
  GameProjectionRegistrar,
  GameProjectionValue,
  GameReadDef,
} from './game-context';
export { gameHostPlugin } from './game-context';
export { type AppObservation, createAppObservation } from './observation';
export { inputPlugin } from './plugin-factories';
export type {
  PointShadowCapability,
  PointShadowCapabilityRequirement,
  PointShadowRecipeErrorCode,
  PointShadowRecipeErrorDetail,
  RenderFeatureHost,
} from './renderer-plugin';
export {
  admitPointShadowBudget,
  ownedRendererPlugin,
  POINT_SHADOW_PLUGIN_ID,
  PointShadowRecipeError,
  pointShadowPlugin,
  rendererPlugin,
  renderFeatureHostPlugin,
  renderFeaturePlugin,
} from './renderer-plugin';
export type {
  EngineWorkspaceAsset,
  EngineWorkspaceAssetBinding,
  EngineWorkspaceAssetInput,
  EngineWorkspaceCameraInput,
  EngineWorkspaceCameraResult,
  EngineWorkspacePlay,
  EngineWorkspacePresentation,
  EngineWorkspacePreview,
  EngineWorkspacePreviewDisplay,
  EngineWorkspacePreviewDisplayOptions,
  EngineWorkspaceProject,
  EngineWorkspaceProjectHandle,
  EngineWorkspaceProjectSession,
  EngineWorkspaceProjectSessionFactory,
  EngineWorkspaceProvider,
  EngineWorkspaceResourcePreviewOwner,
  EngineWorkspaceRuntime,
  EngineWorkspaceRuntimePackInput,
  EngineWorkspaceTarget,
} from './workspace';
export {
  captureEngineWorkspaceAssetBinding,
  createEngineWorkspaceAppPreview,
  createEngineWorkspaceAppTarget,
  createEngineWorkspaceProvider,
  createEngineWorkspaceRuntime,
  ENGINE_WORKSPACE_API_VERSION,
  ENGINE_WORKSPACE_COMMAND_TOPIC,
  ENGINE_WORKSPACE_PLUGIN_ID,
  ENGINE_WORKSPACE_PREVIEWABLE_KINDS,
  type EngineWorkspaceAppTargetOptions,
  EngineWorkspaceError,
  engineWorkspacePlugin,
  engineWorkspaceResultService,
  loadEngineWorkspaceMaterialSlots,
  projectEngineWorkspaceAssets,
} from './workspace';
export type {
  EngineWorkspaceAssetFacts,
  WorkspaceMaterialFacts,
  WorkspaceMeshFacts,
  WorkspaceTextureFacts,
} from './workspace-asset-facts';
export type {
  EngineWorkspaceAssetReference,
  EngineWorkspaceAssetReferences,
} from './workspace-asset-references';
export {
  createWorkspaceMeshDisplay,
  workspaceMeshDisplayPlugin,
} from './workspace-preview-display';
export type { EngineWorkspaceRuntimePackRequest } from './workspace-runtime-pack';
export {
  type EngineWorkspaceTargetTools,
  engineWorkspaceTargetToolsPlugin,
} from './workspace-target-tools';

import {
  isLoadGameError,
  LOAD_GAME_ERROR_HINTS,
  LOAD_GAME_EXPECTED,
  LoadGameError,
} from './load-game-errors';

export type {
  TextureViewControl,
  TextureViewInfo,
  TextureViewOptions,
} from '@forgeax/engine-preview';
export {
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
  type RhiTapeArtifactRef,
} from './internal/rhi-capture';
export type { GamePluginResolver } from './load-game';
export { loadGame } from './load-game';
export type {
  LoadGameDetailImportFailed,
  LoadGameDetailInvalidFormat,
  LoadGameDetailModuleNotFound,
  LoadGameErrorCode,
  LoadGameErrorDetail,
  LoadGameErrorDetailFor,
} from './load-game-errors';
export {
  assembleRuntimePacks,
  type RuntimePackAssembly,
  type RuntimePackOptions,
} from './runtime-packs.js';
export { createTextureWorkspacePreview } from './texture-preview';
export {
  createToolPreviewHost,
  replayToolPreviewCapture,
  type ToolPreviewCaptureResult,
  type ToolPreviewHost,
  type ToolPreviewHostError,
  type ToolPreviewHostOptions,
  type ToolPreviewResourceFacts,
  type ToolPreviewResourceKind,
  type ToolPreviewResourceRequest,
  type ToolPreviewRunResult,
  toolPreviewSubjectDrawn,
} from './tool-preview/bootstrap';
export {
  fitToolPreviewCameraToAabb,
  type ToolPreviewCameraFrame,
} from './tool-preview/framing';
export {
  createToolPreviewRecipe,
  type ToolPreviewAction,
  type ToolPreviewPresentation,
  type ToolPreviewRecipe,
  type ToolPreviewRecipeOptions,
  type ToolPreviewTrace,
  type ToolPreviewTraceEvent,
} from './tool-preview/recipe';
export type {
  App,
  AppAssembleArgs,
  AssembleAppError,
  BundlerOptions,
  CanvasAppError,
  CanvasDrawingBufferSize,
  CreateAppOptions,
  DrawSource,
  DrawSourceResult,
  ExecutionApp,
} from './types';
export { APP_PHASE_CATALOG } from './types';
export {
  type EngineWorkspaceBrowserOptions,
  engineWorkspaceBrowserPlugin,
  engineWorkspaceInputPlugin,
} from './workspace-browser';
export type {
  MaterialPreviewControl,
  MaterialPreviewMesh,
  MaterialPreviewState,
} from './workspace-material-preview';
export {
  createWorkspaceMaterialPreview,
  workspaceMaterialPreviewPlugin,
} from './workspace-material-preview';
export {
  createEngineWorkspaceTools,
  ENGINE_WORKSPACE_STATE_TOPIC,
  ENGINE_WORKSPACE_TOOL_SOURCE,
  snapshotEngineWorkspace,
} from './workspace-tools';
export { isLoadGameError, LOAD_GAME_ERROR_HINTS, LOAD_GAME_EXPECTED, LoadGameError };
