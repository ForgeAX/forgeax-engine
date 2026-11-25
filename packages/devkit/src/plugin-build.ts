/** Plugin compilation and runtime program preparation for custom project hosts. */

export {
  authoredRuntimePackImports,
  prepareAuthoredRuntimePacks,
} from './build/authored-runtime-packs.js';
export { loadProjectCookers, type ProjectCookers } from './build/cookers.js';
export { executionWorkerEntries } from './build/execution-workers.js';
export { withBuildGpuDevice } from './build/gpu-device.js';
export { preparePackProgramSource, prepareRuntimePackProgram } from './build/pack-program.js';
export { discoverPluginAssets, publishedPluginInventory } from './build/plugin-assets.js';
export { pluginProgramsBuild, pluginRuntimeProjection } from './build/plugin-programs.js';

export type {
  StartupUiOptions,
  StartupUiScreen,
  StartupUiState,
  StartupUiTemplate,
} from './host/startup-ui.js';

import type { CreateAppOptions, ExecutionWorkersOptions } from '@forgeax/engine-app';
import type { ImporterRegistry } from '@forgeax/engine-import';
import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type { LoadProgressLabelInput } from '@forgeax/engine-types';
import type { StartupUiOptions } from './host/startup-ui.js';

/** Serializable project options sampled after the native build root starts. */
export type DevKitAppOptions = Pick<
  CreateAppOptions,
  | 'configuration'
  | 'dynamicGeometryMeshBudgetBytes'
  | 'textureMipSkip'
  | 'assetBudgetBytes'
  | 'standardProfile'
  | 'pipelineLibrary'
  | 'backgroundPipelineLibrary'
  | 'backgroundPipelineLibraryConcurrency'
  | 'time'
> & {
  /** Authored App placement; explicit CLI worker keys override these project defaults. */
  readonly execution?: { readonly workers?: ExecutionWorkersOptions };
  /** Project-owned factories constructed before Renderer in every execution realm.
   * Each named export returns { features, plugin? }; config is data-only. */
  readonly renderFeatures?: readonly {
    readonly id: string;
    readonly module: string;
    readonly export: string;
    readonly config?: Readonly<Record<string, unknown>>;
  }[];
  /** Selected feature identities whose managed outputs particles sample. */
  readonly vfxDependencies?: readonly string[];
  /** Browser drawing-buffer pixels per CSS pixel. Omission keeps App's 1x default.
   * 'device' samples the browser DPR; a device policy can cap that scale explicitly. */
  readonly canvasPixelRatio?: number | 'device' | { readonly mode: 'device'; readonly max: number };
  /** WeChat-target Host defaults, independent of the shared game scene and other targets. */
  readonly wechat?: {
    /** Fixed scene short-axis budget; default 720, 0 selects native resolution. UI stays native. */
    readonly maxRenderShortSide?: number;
  };
  /**
   * Default sealed publications in flight between simulation, preparation and
   * GPU completion. Deeper pipelines overlap Workers at one frame of latency.
   * The `forgeax-render-pipeline-capacity` query still overrides it.
   */
  readonly renderPipelineCapacity?: 2 | 3 | 4;
  /**
   * Default Render Worker draw scheduling. `'features'` prepares each draw
   * cooperatively: while an older frame is unretired, the Worker yields one
   * task turn after Feature preparation and again before swap-chain
   * acquisition, so that frame's queue completion (delivered only between
   * tasks) returns its credit while this frame records. `'none'` draws in one
   * synchronous task. The `forgeax-render-task-yield` query still overrides it.
   */
  readonly renderTaskYield?: 'none' | 'features';
  /**
   * Startup, Host status and failure text over the English defaults, including
   * App phase names and `lang`. Partial `host` overrides retain other defaults;
   * apps reuse the same labels with `describeLoadProgress`.
   */
  readonly loadingLabels?: LoadProgressLabelInput;
  /** Independently replace or disable the loading and failure presentation. */
  readonly startupUi?: StartupUiOptions;
};

/**
 * Player packaging groups Pack artifacts into Asset Bundles. Each named Bundle
 * lists project-relative source path prefixes; matching Packs ship together.
 */
export interface DevKitDeliveryOptions {
  readonly bundles?: Readonly<Record<string, readonly string[]>>;
}

/** Build-only Context vocabulary. Import this subpath for authored build plugins. */
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    nativeCookers?: NativeCookerRegistry;
    devkitAppOptions?: DevKitAppOptions;
    devkitDelivery?: DevKitDeliveryOptions;
    importers?: ImporterRegistry;
  }
}
