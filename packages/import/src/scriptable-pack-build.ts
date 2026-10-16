import { type NativeCooker, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import {
  type ScriptablePackBuildOptions as ExecutionOptions,
  buildScriptablePack as execute,
  buildScriptablePackWorklist as executeWorklist,
  type ScriptablePackBuildWorklistOptions as WorklistOptions,
} from './scriptable-pack-build-core.js';

export type {
  ScriptablePackBuildProduct,
  ScriptablePackBuildProductCache,
  ScriptablePackBuildResult,
  ScriptablePackBuildWorkItem,
  ScriptablePackBuildWorklistProduct,
} from './scriptable-pack-build-core.js';

export interface ScriptablePackBuildOptions extends Omit<ExecutionOptions, 'cookers'> {
  readonly cookers?: readonly NativeCooker[];
}
export interface ScriptablePackBuildWorklistOptions extends Omit<WorklistOptions, 'cookers'> {
  readonly cookers?: readonly NativeCooker[];
}
function registry(cookers: readonly NativeCooker[] | undefined): NativeCookerRegistry {
  const result = new NativeCookerRegistry();
  for (const cooker of cookers ?? []) result.register(cooker);
  return result;
}
/** Node producer assembly. Ordinary execution is shared with the runtime producer. */
export function buildScriptablePack(options: ScriptablePackBuildOptions) {
  return execute({ ...options, cookers: registry(options.cookers) });
}
export function buildScriptablePackWorklist(options: ScriptablePackBuildWorklistOptions) {
  return executeWorklist({ ...options, cookers: registry(options.cookers) });
}
