import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createNodeMaterialProgramCompiler, mapMaterialVariants } from '../node-program-compiler';
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
  const allVisible = record.programs.flatMap((program) =>
    program.selections
      .filter(
        (selection) =>
          selection.context.pipeline !== 'ray' && selection.context.visibleSurface === true,
      )
      .map((selection) => ({ program, selection })),
  );
  const visible = allVisible.filter(
    ({ selection }) =>
      selection.context.pipeline !== 'ray' && selection.context.lodCoverage !== true,
  );
  for (const capability of [
    'storage-buffer-minimum',
    'storage-buffer-projector',
    'storage-buffer',
    'storage-buffer-atmosphere',
  ]) {
    for (const viewClipping of [false, true])
      for (const color of [false, true]) {
        expect(
          visible
            .filter(
              ({ selection }) =>
                selection.context.capability === capability &&
                selection.context.pipeline !== 'ray' &&
                selection.context.lodCoverage !== true &&
                (selection.context.viewClipping === true) === viewClipping &&
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
  const validationInputs = new Map<string, (typeof allVisible)[number]>();
  for (const { program, selection } of allVisible) {
    // Pass labels may share identical bytes and entry contracts. Validate each
    // distinct native input once, retaining every LOD/clipping/output case.
    const key = JSON.stringify([program.artifact.digest, selection.entry]);
    if (!validationInputs.has(key)) validationInputs.set(key, { program, selection });
  }
  // The cook has drained its jobs. Use the admitted Node compiler workers
  // for independent native entry checks, with an inline fallback for one CPU.
  const compiler = createNodeMaterialProgramCompiler();
  try {
    await mapMaterialVariants(
      [...validationInputs.values()],
      compiler.concurrency,
      async ({ program, selection }) => {
        const source = new TextDecoder().decode(program.artifact.bytes);
        expect(source).toContain('enable primitive_index;');
        const compiled = await compiler.compile(source, {
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
      },
    );
  } finally {
    await compiler.close();
  }
  const ordinary = record.programs.filter((program) =>
    program.selections.some(
      (selection) =>
        selection.context.pipeline !== 'ray' &&
        selection.context.lodCoverage !== true &&
        selection.context.visibleSurface !== true,
    ),
  );
  expect(ordinary.length).toBeGreaterThan(0);
  for (const program of ordinary) {
    expect(new TextDecoder().decode(program.artifact.bytes)).not.toContain(
      'enable primitive_index;',
    );
  }
}, 30_000);
