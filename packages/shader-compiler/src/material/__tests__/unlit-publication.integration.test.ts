import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { type MaterialAsset, unlitMaterialParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it('cooks the public built-in unlit factory through strict reflection and publication', async () => {
  const cooked = await createMaterialPackCooker().cook({
    guid: 'builtin-unlit-publication',
    source: createBuiltinMaterialAsset('unlit'),
  });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(record.programs.length).toBeGreaterThan(0);
  expect(
    record.programs
      .flatMap((program) => program.selections)
      .some((selection) => selection.pass === 'forward' && selection.context.geometry === 'mesh'),
  ).toBe(true);
}, 30_000);

it('publishes real direct unlit color and skin inputs without claiming a scene-index entry', async () => {
  const source: MaterialAsset = {
    kind: 'material',
    parameters: unlitMaterialParameters('linear'),
    passes: [
      { name: 'Forward', program: { module: 'forgeax_material::unlit' } },
      {
        name: 'ShadowCaster',
        program: { module: 'forgeax_material::unlit', vertexEntry: 'vs_shadow' },
      },
    ],
    values: { baseColor: [0.2, 0.6, 0.1, 1] },
  };
  const cooked = await createMaterialPackCooker().cook({ guid: 'unlit-fidelity', source });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  for (const pass of ['Forward', 'ShadowCaster'])
    for (const capability of [
      'storage-buffer-minimum',
      'storage-buffer-projector',
      'storage-buffer',
      'storage-buffer-atmosphere',
    ]) {
      for (const geometry of ['mesh', 'skinned'])
        for (const color of [false, true]) {
          const matches = record.programs.filter((program) =>
            program.selections.some(
              (selection) =>
                selection.pass === pass &&
                selection.context.capability === capability &&
                selection.context.geometry === geometry &&
                selection.address === 'direct' &&
                selection.abi?.vertexInputs.some((input) => input.semantic === 'color') === color,
            ),
          );
          expect(matches).toHaveLength(1);
          const program = matches[0];
          const selection = program?.selections.find((selection) => selection.pass === pass);
          if (program === undefined || selection === undefined)
            throw new Error('missing compiled selection');
          expect(selection.abi?.sceneIndexEntry).toBeUndefined();
          const wgsl = new TextDecoder().decode(program.artifact.bytes);
          expect(/@location\(13\)/.test(wgsl)).toBe(color);
          expect(selection.abi?.vertexInputs.some((input) => input.semantic === 'skinIndex')).toBe(
            geometry === 'skinned',
          );
          expect(selection.abi?.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(
            geometry === 'skinned',
          );
          expect(selection.abi?.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(
            geometry === 'skinned',
          );
          expect(
            /var<storage(?:,\s*read)?>\s+skinTaskOutput/.test(wgsl),
            wgsl
              .split('\n')
              .filter((line) => line.includes('skinTask'))
              .join('\n'),
          ).toBe(geometry === 'skinned');
        }
    }
  expect(
    record.programs
      .flatMap((program) => program.selections)
      .some((selection) => selection.address === 'scene-index'),
  ).toBe(false);
}, 30_000);
