import type { CookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

it.each([
  [false, 'terrain_surface'],
  [true, 'terrain_surface'],
  [false, 'terrain_id_surface'],
  [true, 'terrain_id_surface'],
])(
  'cooks terrain geometry in every raster path: inherited=%s surface=%s',
  async (inherited, surface) => {
    const source: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters([
        { name: 'terrainHeightTexture', type: 'texture' },
        { name: 'terrainWeightTexture', type: 'texture' },
        ...[
          'terrainColorLayers',
          'terrainNormalHeightLayers',
          'terrainOrmLayers',
          'terrainEmissionLayers',
        ].map((name) => ({ name, type: 'texture_2d_array' as const })),
        { name: 'terrainLayerModes', type: 'vec4', default: [0, 3, 3, 3] },
        { name: 'terrainSection', type: 'vec4', default: [0, 0, 31, 32] },
        { name: 'terrainLod', type: 'vec4', default: [0, 0, 0, 1] },
        { name: 'terrainNeighbors', type: 'vec4', default: [0, 0, 0, 0] },
        { name: 'terrainShadowFamily', type: 'f32', default: 0 },
      ]),
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: `forgeax_material::${surface}` },
          },
        },
        {
          name: 'deferred',
          program: {
            module: 'forgeax_material::standard',
            fragmentEntry: 'fs_gbuffer',
            moduleSlots: { surface: `forgeax_material::${surface}` },
          },
        },
        {
          name: 'shadow-caster',
          program: {
            module: 'forgeax::default-shadow-caster',
            moduleSlots: { surface: `forgeax_material::${surface}` },
          },
        },
      ],
    };
    const cooked = await createMaterialPackCooker().cook({
      guid: 'terrain-geometry',
      source: inherited ? { kind: 'material', parent: 'terrain-parent', values: {} } : source,
      table: inherited ? { 'terrain-parent': source } : undefined,
    });
    const selections = (cooked.payload as { cooked: CookedMaterialRecord }).cooked.programs.flatMap(
      (program) => program.selections,
    );
    const direct = selections.filter((selection) => selection.context.pipeline !== 'ray');
    expect(direct.length).toBeGreaterThan(0);
    for (const selection of direct) {
      expect(selection.address).toBe('direct');
      expect(selection.context.geometry).toBe('terrain');
      expect(selection.abi?.directEntry).toBeDefined();
      expect(selection.abi?.sceneIndexEntry).toBeUndefined();
    }
    const texts = Object.values(cooked.artifacts).map((a) => new TextDecoder().decode(a.bytes));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((text) => text.includes('pairWeights'))).toBe(
      surface === 'terrain_id_surface',
    );
    expect(texts.some((t) => t.includes('terrainVertex'))).toBe(true);
    for (const t of texts.filter((t) => /fn vs_(?:main|temporal|shadow)/.test(t)))
      expect(t).toContain('terrainVertex');
  },
  120_000,
);
