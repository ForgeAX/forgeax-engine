import { describe, expect, it } from 'vitest';
import {
  projectStandardSurfacePasses,
  type StandardSurfaceProjectionOptions,
} from '../assembly/material/surface-projection';

type FullCustomFixture = StandardSurfaceProjectionOptions & {
  readonly surfaceKind: 'full-custom';
  readonly declaredPasses: readonly ('forward' | 'deferred' | 'shadow-caster')[];
};

describe('full-custom Surface provenance', () => {
  it('does not synthesize an undeclared Deferred pass or fallback identity', () => {
    const options: FullCustomFixture = {
      surfaceModule: 'game_3d::full_custom_surface',
      values: { tint: [1, 0.1, 0.05, 1] },
      surfaceKind: 'full-custom',
      declaredPasses: ['forward', 'shadow-caster'],
    };

    const passes = projectStandardSurfacePasses(options);

    expect(passes.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(passes.map((pass) => pass.program.module)).toEqual([
      'forgeax_material::standard',
      'forgeax::default-shadow-caster',
    ]);
    for (const pass of passes) {
      expect(pass.program.moduleSlots?.surface).toBe(options.surfaceModule);
      expect((pass.renderState?.tags as Record<string, string>).SurfaceKind).toBe('full-custom');
    }
  });
});
