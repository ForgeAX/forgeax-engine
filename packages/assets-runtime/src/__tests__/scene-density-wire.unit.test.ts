import { defineComponent } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { describe, expect, it } from 'vitest';
import { resolveSceneComponentFields } from '../scene-payload';

const numeric = defineComponent('DensityNumberFixture', { density: 'f32' });
const sampled = defineComponent('DensityTextureFixture', { density: 'asset<texture>' });

describe('schema-owned density interpretation', () => {
  it('distinguishes identical field names from schema rather than component names', () => {
    const refs = ['texture-guid'];
    expect(
      resolveSceneComponentFields(
        'root',
        numeric.name,
        { density: 0 },
        refs,
        componentSchema(numeric),
      ).unwrap(),
    ).toEqual({ density: 0 });
    expect(
      resolveSceneComponentFields(
        'root',
        sampled.name,
        { density: 0 },
        refs,
        componentSchema(sampled),
      ).unwrap(),
    ).toEqual({ density: 'texture-guid' });
  });
});
