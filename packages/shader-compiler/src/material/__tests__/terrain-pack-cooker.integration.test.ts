import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, TERRAIN_MATERIAL_PARAMETERS } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

it.each([
  false,
  true,
])('cooks the fixed Terrain color and shadow roots through NativeCooker (ids=%s)', async (ids) => {
  const module = `forgeax::standard-terrain${ids ? '-ids' : ''}`;
  const source: MaterialAsset = {
    kind: 'material',
    colorSpace: 'linear',
    parameters: TERRAIN_MATERIAL_PARAMETERS,
    passes: [
      { name: 'forward', program: { module }, renderState: { tags: { LightMode: 'Forward' } } },
      {
        name: 'deferred',
        program: { module, fragmentEntry: 'fs_gbuffer' },
        renderState: { tags: { LightMode: 'Deferred' } },
      },
      {
        name: 'shadow-caster',
        program: { module: `${module}-shadow` },
        renderState: { cullMode: 'none', tags: { LightMode: 'ShadowCaster' } },
      },
    ],
  };
  const draft = await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook({
    guid: `terrain-material-${ids}`,
    source,
  });
  const record = validateCookedMaterialRecord(
    (draft.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(record.authored?.passes).toEqual(source.passes);
  expect(record.resolved.passes).toEqual(source.passes);
  expect(record.resolved.passes.map((pass) => pass.program.module)).toEqual([
    module,
    module,
    `${module}-shadow`,
  ]);
  expect(record.programs.length).toBeGreaterThan(0);
  const selected = record.programs.flatMap((program) =>
    program.selections.map((selection) => selection.context),
  );
  expect(new Set(selected.map((context) => context.geometry))).toEqual(new Set(['terrain']));
  expect(new Set(selected.map((context) => context.pass))).toEqual(new Set(['forward', 'shadow']));
  expect(record.resolved.passes.map((pass) => pass.name)).toEqual([
    'forward',
    'deferred',
    'shadow-caster',
  ]);
  const wgsl = record.programs
    .map((program) => new TextDecoder().decode(program.artifact.bytes))
    .join('\n');
  expect(wgsl).toContain('terrainVertex');
  expect(wgsl.includes('pairWeights')).toBe(ids);
}, 60_000);
