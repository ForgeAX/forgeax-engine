import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as naga from '@forgeax/engine-naga';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import * as compiler from '../../compile.js';
import { createMaterialPackCooker } from '../pack-cooker.js';

// Compiler spies observe their own realm; the Worker route has its own native contracts.
vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));
afterAll(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());

it('reuses full Standard raster and ray programs across Play cookers while publishing fresh values', async () => {
  const underlying = vi.spyOn(naga, 'composeShader');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const cooker = createMaterialPackCooker();
  const source: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([
      { name: 'baseColor', type: 'color' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallic', type: 'f32' },
    ]),
    passes: [
      {
        name: 'forward',
        program: {
          module: 'forgeax_material::standard',
          fragmentEntry: 'fs_main',
          moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE },
        },
      },
      {
        name: 'deferred',
        program: {
          module: 'forgeax_material::standard',
          fragmentEntry: 'fs_gbuffer',
          moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE },
        },
      },
      {
        name: 'shadow-caster',
        program: {
          module: 'forgeax::default-shadow-caster',
          fragmentEntry: 'fs_shadow',
          moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE },
        },
      },
    ],
    values: { roughness: 0.25 },
  };
  const first = await cooker.cook({ guid: 'material-first', source });
  const firstRecord = validateCookedMaterialRecord(
    (first.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(
    firstRecord.programs
      .flatMap((program) =>
        program.selections
          .filter((selection) => selection.context.pipeline === 'ray')
          .map((selection) => selection.context.pass),
      )
      .sort(),
  ).toEqual(['card-capture', 'ray-hit']);
  const firstCompilations = underlying.mock.calls.length;
  const firstValidations = validation.mock.calls.length;
  expect(firstCompilations).toBeGreaterThan(0);

  const second = await createMaterialPackCooker().cook({
    guid: 'material-second',
    source: { ...source, values: { roughness: 0.75 } },
  });
  const secondRecord = validateCookedMaterialRecord(
    (second.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(second.guid).toBe('material-second');
  expect(secondRecord.resolved.values.roughness).toBe(0.75);
  expect(firstRecord.resolved.values.roughness).toBe(0.25);
  expect(secondRecord.programs).toHaveLength(firstRecord.programs.length);
  for (const [index, program] of secondRecord.programs.entries()) {
    const original = firstRecord.programs[index];
    if (original === undefined) throw new Error('compiled program count changed');
    // Compare every WGSL byte natively; deep equality enumerates the entire
    // Uint8Array under V8 coverage instead of checking its byte identity.
    expect(Buffer.compare(program.artifact.bytes, original.artifact.bytes)).toBe(0);
    expect({ ...program, artifact: { ...program.artifact, bytes: undefined } }).toEqual({
      ...original,
      artifact: { ...original.artifact, bytes: undefined },
    });
  }
  expect(underlying).toHaveBeenCalledTimes(firstCompilations);
  expect(validation).toHaveBeenCalledTimes(firstValidations);
}, 30_000);

it('rejects an eligible Card compile failure and retries without retaining the failed program', async () => {
  const compile = compiler.compileShaderWithComposition;
  const failure = await compiler.compileShader('invalid WGSL', { id: 'card-rejection-control' });
  if (failure.ok) throw new Error('invalid shader control compiled');
  const underlying = vi
    .spyOn(compiler, 'compileShaderWithComposition')
    .mockImplementation((source, options, compose, compileProgram) =>
      options?.id === 'forgeax_material::ray_surface::card-capture'
        ? Promise.resolve(failure)
        : compile(source, options, compose, compileProgram),
    );
  const cooker = createMaterialPackCooker();
  const source: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([{ name: 'baseColor', type: 'color' }]),
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  await expect(cooker.cook({ guid: 'eligible-card', source })).rejects.toBe(failure.error);
  underlying.mockImplementation(compile);
  const retry = await cooker.cook({ guid: 'eligible-card', source });
  const record = validateCookedMaterialRecord(
    (retry.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expect(
    record.programs.some((program) =>
      program.selections.some((selection) => selection.context.pass === 'card-capture'),
    ),
  ).toBe(true);
}, 30_000);

it('does not complete an explicitly declared incomplete Standard layer', async () => {
  await expect(
    createMaterialPackCooker().cook({
      guid: 'material-explicit-incomplete-layer',
      source: {
        kind: 'material',
        staticSwitches: { clearcoat: true },
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
        parameters: standardSurfaceParameters([{ name: 'clearcoat', type: 'f32' }]),
        values: { clearcoat: 0.15 },
      },
    }),
  ).rejects.toMatchObject({
    code: 'material-physical-contract-invalid',
    detail: { layer: 'clearcoat', missing: ['clearcoatRoughness'], reason: 'incomplete-layer' },
  });
});

it('observes edited project WGSL and rejects changed entry selections across Play cookers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'play-material-freshness-'));
  const path = join(root, 'entry.wgsl');
  const wgsl = (value: string) => `#define_import_path play::freshness
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(${value}); }`;
  const source: MaterialAsset = {
    kind: 'material',
    parameters: [],
    passes: [{ name: 'forward', program: { module: 'play::freshness' } }],
  };
  const cook = async () => {
    const draft = await createMaterialPackCooker([root]).cook({ guid: 'play-freshness', source });
    return validateCookedMaterialRecord((draft.payload as { cooked: unknown }).cooked).unwrap();
  };
  try {
    await writeFile(path, wgsl('0.25'));
    const first = await cook();
    await writeFile(path, wgsl('0.75'));
    const second = await cook();
    expect(second.programs[0]?.artifact.digest).not.toBe(first.programs[0]?.artifact.digest);
    await expect(
      createMaterialPackCooker([root]).cook({
        guid: 'play-missing-entry',
        source: {
          ...source,
          passes: [
            {
              name: 'forward',
              program: {
                module: 'play::freshness',
                fragmentEntry: 'missing',
              },
            },
          ],
        },
      }),
    ).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
