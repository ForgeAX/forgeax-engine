import type {} from '@forgeax/engine-host/platform';
import type { PackProgramHostFactory } from '@forgeax/engine-pack/runtime';

export type { PackProgramHostFactory } from '@forgeax/engine-pack/runtime';
export { assetLibrarySourceIdentity } from './asset-libraries.js';
export { createDevKitBackend, type DevKitBackend } from './backend.js';
export { retainBackendLifetime } from './backend-lifetime.js';
export {
  callDevKitBackend,
  devKitBackendStatus,
  ensureDevKitView,
  startDevKitBackend,
  stopDevKitBackend,
} from './backend-process.js';
export type {
  BrowserCapture,
  BrowserCaptureCheckpointOptions,
  BrowserCaptureOpenOptions,
  BrowserCaptureRecord,
  BrowserCaptureRequestReport,
  BrowserCaptureRequestWitness,
  BrowserCaptureRunReport,
  BrowserCaptureRuntimeWitness,
  BrowserCaptureSession,
  BrowserCaptureTarget,
  BrowserLaunchProfile,
  CapturePixelWitness,
} from './browser-capture.js';
export {
  captureBrowserExecutionSurface,
  createBrowserCapture,
} from './browser-capture.js';
export {
  type DesktopRenderKernelAddonHandle,
  desktopRenderKernelAddon,
} from './build/desktop-addon.js';
export {
  createForgeaxDesktopNativeRenderer,
  ForgeaxDesktopNativeRenderer,
  type ForgeaxDesktopNativeRendererOptions,
} from './build/desktop-native-kernel.js';
export { createNodePackProgramHost } from './build/pack-program-host.js';
export { createNodePackProgramImports } from './build/pack-program-imports.js';
export {
  assetAddCommand,
  assetGuidCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
  browserCaptureCommand,
  buildCommand,
  createCliRhiDebugOperationContext,
  devCommand,
  doctorCommand,
  engineDoctorCommand,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
  initCommand,
  newCommand,
  packageCommand,
  pluginCreateCommand,
  pluginInspectCommand,
  pluginRootCommand,
  previewCommand,
  projectLintCommand,
  sdkInstallCommand,
  shaderCheckCommand,
  skillInstallCommand,
  skillVerifyCommand,
  testCommand,
} from './commands.js';
export { verifyDist, writeDistManifest } from './dist.js';
export type {
  EngineBinding,
  EngineBindingCommandOptions,
  EngineBindingMode,
  EnginePackageStatus,
  EngineStatusReport,
  EngineWorkspaceStatus,
} from './engine-binding.js';
export {
  ENGINE_BINDING_SCHEMA_VERSION,
  inspectEngineWorkspace,
  readEngineBinding,
} from './engine-binding.js';
export { createViteConfig } from './host.js';
export {
  composeBoundHostAssembly,
  type DevKitHostBinding,
  hostBindingError,
  validateHostBinding,
} from './host-binding.js';
export { createInitPlan } from './init.js';
export {
  browseProjectDirectories,
  type KnownProject,
  type KnownProjectEntry,
  type KnownProjectError,
  type KnownProjectErrorCode,
  type KnownProjectResult,
  KnownProjectStoreError,
  knownProjectStorePath,
  listKnownProjects,
  type ProjectDirectoryEntry,
  type ProjectDirectoryListing,
  registerKnownProject,
  rememberKnownProject,
} from './known-projects.js';
export type {
  LiveDevBackend,
  LiveDevDaemonOptions,
  LiveDevStatus,
} from './live-dev.js';
export {
  liveDevControl,
  liveDevStatus,
  removeLiveDevSession,
  runLiveDevDaemon,
  runLiveProjectProcess,
  startLiveDev,
} from './live-dev.js';
export {
  createOperationHistoryStore,
  createOperationHistoryTools,
  type OperationHistoryEntry,
  type OperationHistoryPage,
  type OperationHistorySummary,
} from './operation-history.js';
export type {
  PlayAdvanceOptions,
  PlayClockReport,
  PlayContext,
  PlayErrorCode,
  PlayFailure,
  PlayNotReadyReason,
  PlayOptions,
  PlayPoint,
  PlayReport,
  PlayRuntimeCheck,
  PlayScreenshot,
  PlayScript,
  PlayScriptInvalidReason,
  PlayStepFailureReason,
  PlayStepOptions,
  PlayStepRange,
  PlayWaitOptions,
  PlayWarning,
} from './play.js';
export { playCommand } from './play.js';
export { type PluginMigrationOptions, pluginMigrateCommand } from './plugin/migration.js';
export type {
  ProjectLintDiagnostic,
  ProjectLintError,
  ProjectLintReport,
  ProjectLintResult,
  ProjectLintRuleId,
  ProjectOwnershipGraph,
  ProjectOwnershipNode,
} from './project/lint.js';
export { readProjectFacts } from './project.js';
export type {
  ArtifactRef,
  CapturedRhiTape,
  ReplayBackendLease,
  RhiCaptureFrameValue,
  RhiDebugOperationContext,
  RhiDebugOperationDescriptor,
  RhiDebugOperationInput,
  RhiDebugOperationName,
  RhiDebugOperationOutput,
  RhiInspectInput,
  RhiInspectOutput,
  RhiSummaryInput,
  RhiSummaryOutput,
} from './rhi-debug/operations.js';
export {
  createRhiDebugOperationContext,
  discoverRhiDebugOperations,
  RHI_DEBUG_OPERATION_MANIFEST,
  recoverRhiDebugError,
  renderRhiDebugHelp,
  runRhiDebugOperation,
} from './rhi-debug/operations.js';
export type {
  SingleHtmlBundle,
  SingleHtmlBundleArtifact,
  SingleHtmlPackageOptions,
  SingleHtmlPackageResult,
} from './single-html.js';
export {
  bundleSingleHtmlEntry,
  packageFormatError,
  packageOutputError,
  writeSingleHtml,
} from './single-html.js';
export { assetSourceImportCommand, type SourceTransferOptions } from './source-transfer.js';
export * from './tools/index.js';
export type {
  AssetAddOptions,
  AssetInspectOptions,
  AssetListOptions,
  BootstrapRoot,
  BrowserCaptureOptions,
  BuildOptions,
  CaptureBackend,
  CommandError,
  CommandResult,
  InitOptions,
  NewOptions,
  PackageFormat,
  PackageOptions,
  PluginCreateOptions,
  PluginInspectOptions,
  PluginRootOptions,
  PreviewOptions,
  ProjectCommandOptions,
  ProjectFacts,
  ShaderCheckOptions,
  TauriPlatform,
} from './types.js';
export { resolveProjectPort } from './types.js';
export { runUnifiedCli, type UnifiedCliResult } from './unified-cli.js';
export {
  type DevKitWorkspacePluginOptions,
  devKitWorkspacePlugin,
  ENGINE_WORKSPACE_CALL_SERVICE,
  ENGINE_WORKSPACE_CAPABILITIES_SERVICE,
} from './workspace-plugin.js';
export {
  createDevKitWorkspaceProvider,
  DevKitWorkspaceError,
  type DevKitWorkspaceProviderOptions,
  type DevKitWorkspaceTargetOptions,
} from './workspace-provider.js';

declare module '@forgeax/engine-host/platform' {
  interface FrontendPlatform {
    /** Borrowed realm module delivery when a native frontend cannot own a ServiceWorker. */
    readonly createPackProgramHost?: PackProgramHostFactory;
  }
}
