import { describe, expect, it } from 'vitest';
import { stageDispatches, validatedStagePlan } from '../feature/stage-plan.js';

const reflection = {
  id: 'turbulence',
  entry: 'vfx_turbulence',
  entryPoint: 'forgeax_vfx_stage_turbulence_main',
  domain: 'particle' as const,
  resources: [
    { name: 'particles', access: 'read-write' as const },
    { name: 'runtime', access: 'read' as const },
  ],
  dependsOn: ['update'],
  iterationBudget: 4,
};

describe('managed stage resource layout', () => {
  it('preserves compiler reflection fields and normalizes particle dispatch', () => {
    const result = validatedStagePlan([reflection], 7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      generation: 7,
      stages: [reflection],
    });
    expect(result.value.stages[0]?.domain).toBe('particle');
    expect(result.value.stages[0]?.resources).toEqual(reflection.resources);
    expect(result.value.stages[0]?.iterationBudget).toBe(4);

    const dispatches = stageDispatches(result.value, 3, undefined as never);
    expect(dispatches).toEqual([
      {
        entryPoint: 'forgeax_vfx_stage_turbulence_main',
        workgroups: [3],
        bindings: undefined,
      },
    ]);
  });
});
