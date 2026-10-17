/** Plugin compilation and runtime program preparation for custom project hosts. */

export { executionWorkerEntries } from './build/execution-workers.js';
export { preparePackProgramSource, prepareRuntimePackProgram } from './build/pack-program.js';
export { discoverPluginAssets, publishedPluginInventory } from './build/plugin-assets.js';
export { pluginProgramsBuild, pluginRuntimeProjection } from './build/plugin-programs.js';

import type { CreateAppOptions } from '@forgeax/engine-app';
import type { ImporterRegistry } from '@forgeax/engine-import';
import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';

/** Serializable project options sampled after the native build root starts. */
export type DevKitAppOptions = Pick<
  CreateAppOptions,
  'dynamicGeometryMeshBudgetBytes' | 'standardProfile' | 'pipelineLibrary'
>;

/** Build-only Context vocabulary. Import this subpath for authored build plugins. */
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    nativeCookers?: NativeCookerRegistry;
    devkitAppOptions?: DevKitAppOptions;
    importers?: ImporterRegistry;
  }
}
