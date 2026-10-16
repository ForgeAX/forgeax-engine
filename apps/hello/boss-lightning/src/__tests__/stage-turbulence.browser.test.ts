import { observeStagePlan, validatedStagePlan } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

describe('Boss Lightning turbulence stage Browser contract', () => {
  it('validates the authored turbulence stage through the browser runtime seam', () => {
    const candidate = validatedStagePlan(
      [
        {
          id: 'turbulence',
          entry: 'vfx_turbulence',
          entryPoint: 'forgeax_vfx_stage_turbulence_main',
          domain: 'particle',
          resources: [
            { name: 'particles', access: 'read-write' },
            { name: 'runtime', access: 'read' },
          ],
          dependsOn: ['update'],
          iterationBudget: 4,
        },
      ],
      1,
    );
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const observation = observeStagePlan(candidate, 1, undefined);
    expect(observation.stageReadiness).toEqual([
      expect.objectContaining({ id: 'turbulence', state: 'ready', generation: 1 }),
    ]);
    expect(observation.stageOutput).toBe('active');
    expect(observation.lastKnownGoodStage?.fingerprint).toContain('turbulence');
  });
});
