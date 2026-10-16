import { describe, expect, it } from 'vitest';
import { buildParticleStagePlan } from '../managed-program.js';

const stage = (body: string): string => {
  const entry = body.match(/entry=([^\s]+)/)?.[1] ?? 'vfx_turbulence';
  return `// #vfx stage ${body}\nfn ${entry}(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;
};

describe('managed particle stage plans', () => {
  it('orders stages and projects managed entry points', () => {
    const result = buildParticleStagePlan(
      [
        stage(
          'turbulence entry=vfx_turbulence domain=particle resources=particles:read-write,runtime:read dependsOn=update iterationBudget=4',
        ),
        stage(
          'damping entry=vfx_damping domain=particle resources=particles:read-write dependsOn=turbulence iterationBudget=2',
        ),
      ].join('\n'),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages.map((item) => item.id)).toEqual(['turbulence', 'damping']);
      expect(result.value.stages[0]).toMatchObject({
        entry: 'vfx_turbulence',
        entryPoint: 'forgeax_vfx_stage_turbulence_main',
        domain: 'particle',
        resources: [
          { name: 'particles', access: 'read-write' },
          { name: 'runtime', access: 'read' },
        ],
        dependsOn: ['update'],
        iterationBudget: 4,
      });
      expect(result.value.fingerprint).toContain('vfx_stage_turbulence_main');
    }
  });

  it.each([
    [
      'cycle',
      [
        'a entry=vfx_a domain=particle resources=particles:read-write dependsOn=b iterationBudget=1',
        'b entry=vfx_b domain=particle resources=particles:read-write dependsOn=a iterationBudget=1',
      ],
    ],
    [
      'resource hazard',
      [
        'a entry=vfx_a domain=particle resources=particles:write dependsOn=update iterationBudget=1',
        'b entry=vfx_b domain=particle resources=particles:read dependsOn=update iterationBudget=1',
      ],
    ],
    [
      'unknown resource',
      [
        'a entry=vfx_a domain=particle resources=privateBuffer:read dependsOn=update iterationBudget=1',
      ],
    ],
    [
      'budget',
      [
        'a entry=vfx_a domain=particle resources=particles:read dependsOn=update iterationBudget=65',
      ],
    ],
  ])('rejects %s before producing an executable plan', (_name, declarations) => {
    const result = buildParticleStagePlan(
      declarations
        .map(
          (declaration) =>
            `// #vfx stage ${declaration}\nfn vfx_${declaration.split(' ')[0]}(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`,
        )
        .join('\n'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toMatch(/^vfx-stage-/);
      expect(result.error.expected).toBeTruthy();
      expect(result.error.hint).toContain('stage');
      expect(result.error.detail).toBeTruthy();
    }
  });
});
