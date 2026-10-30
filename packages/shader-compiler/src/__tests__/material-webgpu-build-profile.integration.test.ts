import { readFile } from 'node:fs/promises';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { createMaterialPackCooker } from '../material/pack-cooker.js';

it('keeps identical actual WebGPU programs while omitting only unsupported validation targets', async () => {
  const document = JSON.parse(
    await readFile(
      new URL('../../../../apps/game-capability-lab/assets/scene.pack.json', import.meta.url),
      'utf8',
    ),
  );
  const authored = document.assets['material/blue-ball'];
  const source = { kind: authored.kind, ...authored.payload } as MaterialAsset;
  const portable = createMaterialPackCooker();
  const desktop = createMaterialPackCooker([], { profile: 'webgpu-storage' });
  expect(await portable.cacheIdentity?.()).not.toBe(await desktop.cacheIdentity?.());
  const input = { guid: 'validation-profile-blue-ball', source };
  const original = await portable.cook(input);
  const selected = await desktop.cook(input);
  const record = (draft: typeof original) =>
    validateCookedMaterialRecord((draft.payload as { cooked: unknown }).cooked).unwrap();
  const all = record(original),
    target = record(selected);
  const required = all.programs
    .map((program) => ({
      ...program,
      selections: program.selections.filter(
        ({ context }) =>
          context.pipeline !== 'ray' &&
          context.backend === 'webgpu' &&
          context.capability !== 'uniform-fallback',
      ),
    }))
    .filter((program) => program.selections.length > 0);
  expect(target.programs.length).toBeGreaterThan(0);
  expect(target.programs.length).toBeLessThan(all.programs.length);
  expect(target.programs.map((program) => program.specializationKey).sort()).toEqual(
    required.map((program) => program.specializationKey).sort(),
  );
  for (const program of target.programs) {
    const prior = required.find((row) => row.specializationKey === program.specializationKey);
    expect(prior).toBeDefined();
    expect(equalBytes(program.artifact.bytes, prior?.artifact.bytes)).toBe(true);
    expect(program.selections).toEqual(prior?.selections);
  }
  expect(selected.inputFingerprint).not.toBe(original.inputFingerprint);
  expect(target.resolved).toEqual(all.resolved);
  console.info(
    JSON.stringify({
      portablePrograms: all.programs.length,
      webgpuStoragePrograms: target.programs.length,
      portableSelections: all.programs.reduce((n, p) => n + p.selections.length, 0),
      webgpuStorageSelections: target.programs.reduce((n, p) => n + p.selections.length, 0),
    }),
  );
}, 60_000);

it('retains both actual ray and Card programs in the storage ray producer', async () => {
  expect(() => createMaterialPackCooker([], { profile: 'unknown' as never })).toThrow(
    'material profile',
  );
  const source: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const input = { guid: 'storage-ray-profile-standard', source };
  const full = createMaterialPackCooker();
  const raysTarget = createMaterialPackCooker([], { profile: 'webgpu-storage-ray' });
  const rasterTarget = createMaterialPackCooker([], { profile: 'webgpu-storage' });
  const identities = await Promise.all(
    [full, raysTarget, rasterTarget].map((cooker) => cooker.cacheIdentity?.()),
  );
  expect(new Set(identities).size).toBe(3);
  const portable = await full.cook(input);
  const selected = await raysTarget.cook(input);
  const record = (draft: typeof portable) =>
    validateCookedMaterialRecord((draft.payload as { cooked: unknown }).cooked).unwrap();
  const original = record(portable);
  const target = record(selected);
  expect(target.programs.map((program) => program.specializationKey).sort()).toEqual(
    original.programs
      .filter((program) =>
        program.selections.some(
          ({ context }) =>
            context.backend === 'webgpu' && context.capability !== 'uniform-fallback',
        ),
      )
      .map((program) => program.specializationKey)
      .sort(),
  );
  const rays = target.programs.filter((program) =>
    program.selections.some(({ context }) => context.pipeline === 'ray'),
  );
  expect(
    rays.flatMap((program) => program.selections.map(({ context }) => context.pass)).sort(),
  ).toEqual(['card-capture', 'ray-hit']);
  for (const program of target.programs) {
    const prior = original.programs.find(
      (value) => value.specializationKey === program.specializationKey,
    );
    expect(prior).toBeDefined();
    expect(equalBytes(program.artifact.bytes, prior?.artifact.bytes)).toBe(true);
    expect(program.selections).toEqual(prior?.selections);
  }
  expect(target.resolved).toEqual(original.resolved);
}, 60_000);
