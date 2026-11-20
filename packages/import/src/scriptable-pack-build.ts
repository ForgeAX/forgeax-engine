import { type NativeCooker, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { ok } from '@forgeax/engine-types';
import {
  type ScriptablePackBuildOptions as ExecutionOptions,
  buildScriptablePack as execute,
  buildScriptablePackWorklist as executeWorklist,
  type ScriptablePackBuildWorklistOptions as WorklistOptions,
} from './scriptable-pack-build-core.js';
import { createMaterialDraftSharing } from './shared-material-drafts.js';

export type {
  ScriptablePackBuildProduct,
  ScriptablePackBuildProductCache,
  ScriptablePackBuildResult,
  ScriptablePackBuildWorkItem,
  ScriptablePackBuildWorklistProduct,
} from './scriptable-pack-build-core.js';
export { waterPackReferenceKindFailure } from './scriptable-pack-build-core.js';

export interface ScriptablePackBuildOptions extends Omit<ExecutionOptions, 'cookers'> {
  readonly cookers?: readonly NativeCooker[];
}
export interface ScriptablePackBuildWorklistOptions extends Omit<WorklistOptions, 'cookers'> {
  readonly cookers?: readonly NativeCooker[];
}
function registry(
  cookers: readonly NativeCooker[] | undefined,
): Pick<NativeCookerRegistry, 'get' | 'runDraft'> {
  const result = new NativeCookerRegistry();
  for (const cooker of cookers ?? []) result.register(cooker);
  const shareMaterial = createMaterialDraftSharing();
  return {
    get: (key) => result.get(key),
    async runDraft<P, I>(key: string, input: I) {
      const draft = await result.runDraft<P, I>(key, input);
      return key === 'material' && draft.ok ? ok(shareMaterial(draft.value)) : draft;
    },
  };
}
/** Node producer assembly. Ordinary execution is shared with the runtime producer. */
export function buildScriptablePack(options: ScriptablePackBuildOptions) {
  return execute({ ...options, cookers: registry(options.cookers) });
}
export function buildScriptablePackWorklist(options: ScriptablePackBuildWorklistOptions) {
  return executeWorklist({ ...options, cookers: registry(options.cookers) });
}
