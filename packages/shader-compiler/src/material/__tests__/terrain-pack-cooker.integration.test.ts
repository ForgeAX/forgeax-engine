import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import {
  type MaterialAsset,
  TERRAIN_MATERIAL_PARAMETERS,
  TERRAIN_WEIGHT_DETAIL_PARAMETERS,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

it.each([
  '',
  '-ids',
  '-detail',
])('cooks the fixed Terrain color and shadow roots through NativeCooker (suffix=%s)', async (suffix) => {
  const module = `forgeax::standard-terrain${suffix}`;
  const detail = suffix === '-detail';
  const source: MaterialAsset = {
    kind: 'material',
    colorSpace: 'linear',
    parameters: detail ? TERRAIN_WEIGHT_DETAIL_PARAMETERS : TERRAIN_MATERIAL_PARAMETERS,
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
    guid: `terrain-material${suffix || '-weights'}`,
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
  expect(wgsl.includes('pairWeights')).toBe(suffix === '-ids');
  expect(wgsl.includes('terrainWeightDetail_sampler')).toBe(detail);
  expect(wgsl).not.toContain('waterBodyData');
  expect(wgsl).not.toContain('evaluateWaterWavesForward');
}, 60_000);
