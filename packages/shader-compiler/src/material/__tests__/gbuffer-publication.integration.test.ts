import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

it('publishes the native Deferred v2 contract through a cold material cook and fresh JSON load', async () => {
  const cooked = await createMaterialPackCooker([], { profile: 'webgpu-storage' }).cook({
    guid: 'gbuffer-v2-cold-publication',
    source: {
      kind: 'material',
      parameters: standardSurfaceParameters([
        { name: 'baseColor', type: 'color' },
        { name: 'roughness', type: 'f32' },
        { name: 'metallic', type: 'f32' },
      ]),
      passes: [
        {
          name: 'deferred',
          program: { module: 'forgeax_material::standard', fragmentEntry: 'fs_gbuffer' },
        },
      ],
    },
  });
  const payload = JSON.parse(
    JSON.stringify(cooked.payload, (_key, value) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    ),
  ) as { cooked: unknown };
  const record = validateCookedMaterialRecord(payload.cooked).unwrap();
  const selections = record.programs
    .flatMap((program) => program.selections)
    .filter((selection) => selection.pass === 'deferred');
  expect(selections.length).toBeGreaterThan(0);
  for (const selection of selections) {
    expect(selection.abi?.gbuffer).toBe('standard-gbuffer/2');
    expect(selection.abi?.receiptIdentity).toContain('/standard-gbuffer/2');
  }
  expect(
    Object.values(cooked.artifacts).some((artifact) =>
      new TextDecoder().decode(artifact.bytes).includes('dielectric_specular'),
    ),
  ).toBe(true);
}, 30_000);
