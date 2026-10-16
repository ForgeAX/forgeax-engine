import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  projectStandardSurfacePasses,
  type StandardSurfaceProjectionOptions,
} from '../surface-projection';

type SurfaceFixture = StandardSurfaceProjectionOptions & {
  readonly geometryVariant: 'rigid' | 'skinned' | 'instanced';
  readonly lightingLane: 'direct' | 'clustered';
  readonly alphaClip: boolean;
};

const fixture = (geometryVariant: SurfaceFixture['geometryVariant']): SurfaceFixture => ({
  surfaceModule: 'game_3d::rusted_iron_surface',
  values: { ironColor: [0.42, 0.47, 0.5, 1] },
  geometryVariant,
  lightingLane: geometryVariant === 'instanced' ? 'clustered' : 'direct',
  alphaClip: geometryVariant === 'skinned',
});

function tagsFor(pass: ReturnType<typeof projectStandardSurfacePasses>[number]) {
  return pass.renderState?.tags as Record<string, string>;
}

describe('Standard Surface pass projection', () => {
  it.each([
    'rigid',
    'skinned',
    'instanced',
  ] as const)('projects one %s Surface closure into every Standard pass', (geometryVariant) => {
    const options = fixture(geometryVariant);
    const passes = projectStandardSurfacePasses(options);

    expect(passes.map((pass) => pass.name)).toEqual(['forward', 'deferred', 'shadow-caster']);
    for (const pass of passes) {
      expect(pass.program.moduleSlots?.surface).toBe(options.surfaceModule);
      expect(tagsFor(pass)).toMatchObject({
        SurfaceModule: options.surfaceModule,
        GeometryVariant: geometryVariant,
        LightingLane: options.lightingLane,
        AlphaClip: options.alphaClip ? 'enabled' : 'disabled',
      });
    }
  });

  it('keeps base Standard on Deferred while physical Standard stays Forward-only', () => {
    const base = projectStandardSurfacePasses({
      ...fixture('rigid'),
      layerPlan: deriveStandardLayerPlan([]),
    });
    const physical = projectStandardSurfacePasses({
      ...fixture('rigid'),
      layerPlan: deriveStandardLayerPlan([
        { name: 'clearcoat', type: 'f32' },
        { name: 'clearcoatRoughness', type: 'f32' },
      ]),
    });
    expect(base.map((pass) => pass.name)).toEqual(['forward', 'deferred', 'shadow-caster']);
    expect(physical.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
  });
});
