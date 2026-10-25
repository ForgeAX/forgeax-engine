/** Plugin compilation and runtime program preparation for custom project hosts. */

export { executionWorkerEntries } from './build/execution-workers.js';
export { preparePackProgramSource, prepareRuntimePackProgram } from './build/pack-program.js';
export { discoverPluginAssets, publishedPluginInventory } from './build/plugin-assets.js';
export { pluginProgramsBuild, pluginRuntimeProjection } from './build/plugin-programs.js';

import type { CreateAppOptions } from '@forgeax/engine-app';
import type { ImporterRegistry } from '@forgeax/engine-import';
import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type { LoadProgressLabelInput } from '@forgeax/engine-types';

/** Serializable project options sampled after the native build root starts. */
export type DevKitAppOptions = Pick<
  CreateAppOptions,
  | 'dynamicGeometryMeshBudgetBytes'
  | 'assetBudgetBytes'
  | 'standardProfile'
  | 'pipelineLibrary'
  | 'backgroundPipelineLibrary'
  | 'time'
> & {
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
   * Startup cover text over the English defaults, including App phase names
   * and `lang`; apps reuse the same labels with `describeLoadProgress`.
   */
  readonly loadingLabels?: LoadProgressLabelInput;
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
