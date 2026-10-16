import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { compileShader } from '../../index';
import { createMaterialPackCooker } from '../pack-cooker';

it('publishes eight-target visible surfaces alongside ordinary cooked Standard passes', async () => {
  const cooked = await createMaterialPackCooker().cook({
    guid: 'visible-surface-standard',
    source: {
      kind: 'material',
      parameters: standardSurfaceParameters([
        { name: 'baseColor', type: 'color' },
        { name: 'roughness', type: 'f32' },
        { name: 'metallic', type: 'f32' },
      ]),
      passes: [
        { name: 'forward', program: { module: 'forgeax_material::standard' } },
        { name: 'deferred', program: { module: 'forgeax_material::standard' } },
      ],
      values: { alphaCutoff: 0.5 },
    },
  });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const visible = record.programs.flatMap((program) =>
    program.selections
      .filter(
        (selection) =>
          selection.context.pipeline !== 'ray' && selection.context.visibleSurface === true,
      )
      .map((selection) => ({ program, selection })),
  );
  for (const capability of [
    'storage-buffer-minimum',
    'storage-buffer-projector',
    'storage-buffer',
    'storage-buffer-atmosphere',
  ]) {
    for (const color of [false, true]) {
      expect(
        visible
          .filter(
            ({ selection }) =>
              selection.context.capability === capability &&
              selection.abi?.vertexInputs.some((input) => input.semantic === 'color') === color,
          )
          .map(({ selection }) => [selection.pass, selection.address])
          .sort(),
      ).toEqual([
        ['deferred', 'direct'],
        ['deferred', 'scene-index'],
        ['forward', 'direct'],
        ['forward', 'scene-index'],
      ]);
    }
  }
  for (const { program, selection } of visible) {
    const source = new TextDecoder().decode(program.artifact.bytes);
    expect(source).toContain('enable primitive_index;');
    const compiled = await compileShader(source, {
      id: 'visible-surface-cooked-validation',
      renderEntries: {
        vertex: selection.entry ?? 'vs_main',
        fragment: 'fs_gbuffer',
        colorFormats: [
          'rgba16float',
          'r32uint',
          'r32uint',
          'r32uint',
          'r32uint',
          'r32uint',
          'rgba32uint',
          'rgba16float',
        ],
      },
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error.message).toBe(true);
  }
  const ordinary = record.programs.filter((program) =>
    program.selections.some(
      (selection) =>
        selection.context.pipeline !== 'ray' && selection.context.visibleSurface !== true,
    ),
  );
  expect(ordinary.length).toBeGreaterThan(0);
  for (const program of ordinary) {
    expect(new TextDecoder().decode(program.artifact.bytes)).not.toContain(
      'enable primitive_index;',
    );
  }
}, 30_000);
