import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import {
  GPU_SHADER_STAGE_COMPUTE,
  GPU_SHADER_STAGE_FRAGMENT,
  GPU_SHADER_STAGE_VERTEX,
} from './gpu-stage';

const stageVisibility = {
  vertex: GPU_SHADER_STAGE_VERTEX,
  fragment: GPU_SHADER_STAGE_FRAGMENT,
  compute: GPU_SHADER_STAGE_COMPUTE,
};

/** Only present entries contribute bindings. A missing selected entry has unknown requirements. */
export function shaderBindingVisibility(
  entries: readonly ShaderEntryPointReads[] | undefined,
  group: number,
  stages: Readonly<Partial<Record<ShaderEntryPointReads['stage'], string>>>,
): ReadonlyMap<number, number> | undefined {
  if (entries === undefined) return undefined;
  const usage = new Map<number, number>();
  for (const stage of ['vertex', 'fragment', 'compute'] as const) {
    const name = stages[stage];
    if (name === undefined) continue;
    const entry = entries.find((candidate) => candidate.stage === stage && candidate.name === name);
    if (entry === undefined) return undefined;
    for (const binding of entry.bindings) {
      if (binding.group === group)
        usage.set(binding.binding, (usage.get(binding.binding) ?? 0) | stageVisibility[stage]);
    }
  }
  return usage;
}
