import { describe, expect, it } from 'vitest';
import { parseVfxStageDeclarations } from '../code-source.js';

describe('VFX stage source declarations', () => {
  it('discovers a bounded particle stage with explicit resource access', () => {
    const result = parseVfxStageDeclarations(
      '// #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write,runtime:read dependsOn=update iterationBudget=4',
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 'turbulence',
          entry: 'vfx_turbulence',
          domain: 'particle',
          resources: [
            { name: 'particles', access: 'read-write' },
            { name: 'runtime', access: 'read' },
          ],
          dependsOn: ['update'],
          iterationBudget: 4,
        },
      ],
    });
  });

  it.each([
    ['domain', 'domain=render'],
    ['resource', 'resources=privateBuffer:read'],
    ['entry', 'entry=forgeax_vfx_update_main'],
    ['budget', 'iterationBudget=0'],
  ])('rejects an invalid stage %s with a recovery hint', (_name, replacement) => {
    const result = parseVfxStageDeclarations(
      `// #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write dependsOn=none iterationBudget=4`.replace(
        replacement.startsWith('domain=')
          ? 'domain=particle'
          : replacement.startsWith('resources=')
            ? 'resources=particles:read-write'
            : replacement.startsWith('entry=')
              ? 'entry=vfx_turbulence'
              : 'iterationBudget=4',
        replacement,
      ),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-source-stage-invalid');
      expect(result.error.hint).toContain('recook');
      expect(result.error.detail.path).toContain('turbulence');
    }
  });

  it('rejects unknown directive fields and duplicate stage ids', () => {
    const result = parseVfxStageDeclarations(`
      // #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write dependsOn=none iterationBudget=4 extra=yes
      // #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write dependsOn=none iterationBudget=4
    `);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.expected).toContain('supported stage declaration');
  });
});
