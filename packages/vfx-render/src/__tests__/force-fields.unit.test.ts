import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  isVfxFieldTransform,
  type VfxForceField,
  validateVfxForceFields,
} from '@forgeax/engine-vfx';
import { createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { afterEach, describe, expect, it } from 'vitest';
import { createVfxForceFieldPreparation } from '../feature/force-fields';

const leases: { dispose(): void }[] = [];
afterEach(() => {
  for (const lease of leases) lease.dispose();
  leases.length = 0;
});
const guid = '01a11250-0000-7000-8000-000000000001';
const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fields: readonly VfxForceField[] = [
  { kind: 'vector', texture: guid, sampling: 'trilinear', transform, strength: 1, attenuation: 0 },
];
const texture = () =>
  createVfxVectorFieldTexture({
    resolution: [8, 8, 8],
    field: { kind: 'constant', value: [0.5, 0.25, -0.125] },
  }).unwrap();

describe('managed force-field preparation', () => {
  it('retains unchanged ordinary payloads and replaces content at the same GUID', () => {
    const assets = new AssetRegistry();
    const kernel = createVfxForceFieldPreparation();
    const prepare = (fields: readonly VfxForceField[], reference?: AssetHandle<'texture'>) => {
      const pinned =
        reference === undefined
          ? undefined
          : runtimeAssets(assets)
              .pin<import('@forgeax/engine-types').TextureAsset>(reference)
              .unwrap();
      if (pinned !== undefined) leases.push(pinned);
      return kernel(fields, pinned === undefined ? [] : [pinned]);
    };
    const original = assets.create(texture()).unwrap();
    const bound = fields.map((field) => ({ ...field, texture: original }));
    const first = prepare(bound, original).unwrap();
    const same = prepare(bound, original).unwrap();
    expect(same).toBe(first);
    expect(Array.from(first.data.slice(44, 48))).toEqual([0.5, 0.25, -0.125, 0]);
    const replacement = texture();
    new DataView(replacement.data.buffer).setFloat32(0, 2, true);
    assets.update(original, { data: replacement.data }).unwrap();
    const next = prepare(bound, original).unwrap();
    expect(next.revision).not.toBe(first.revision);
    expect(next.data[44]).toBe(2);
    expect(first.data[44]).toBe(0.5);
    assets.dispose();
  });

  it('preserves structured missing, malformed, nonfinite and capacity failures', () => {
    const assets = new AssetRegistry();
    const kernel = createVfxForceFieldPreparation();
    const prepare = (fields: readonly VfxForceField[], reference?: AssetHandle<'texture'>) => {
      const pinned =
        reference === undefined
          ? undefined
          : runtimeAssets(assets)
              .pin<import('@forgeax/engine-types').TextureAsset>(reference)
              .unwrap();
      if (pinned !== undefined) leases.push(pinned);
      return kernel(fields, pinned === undefined ? [] : [pinned]);
    };
    expect(prepare(fields)).toMatchObject({
      ok: false,
      error: { code: 'vfx-field-asset-missing', detail: { guid } },
    });
    const invalid = texture();
    new DataView(invalid.data.buffer).setFloat32(4, Number.NaN, true);
    expect(prepare(fields, assets.create(invalid).unwrap())).toMatchObject({
      ok: false,
      error: { code: 'vfx-field-payload-invalid' },
    });
    expect(validateVfxForceFields(Array(9).fill(fields[0]))).toMatchObject({
      ok: false,
      error: { code: 'vfx-field-capacity-exceeded' },
    });
    expect(validateVfxForceFields([{ ...fields[0], transform: Array(16).fill(0) }])).toMatchObject({
      ok: false,
      error: { code: 'vfx-field-invalid' },
    });
    for (const patch of [
      { transform: new Float32Array(transform) },
      { strength: '1' },
      { attenuation: 9 },
      { sampling: 'linear' },
      { texture: 'bad-guid' },
    ]) {
      expect(validateVfxForceFields([{ ...fields[0], ...patch }])).toMatchObject({
        ok: false,
        error: { code: 'vfx-field-invalid' },
      });
    }
    assets.dispose();
  });

  it('rejects a JSON array in the ordinary texture GUID slot without coercion', () => {
    expect(validateVfxForceFields([{ ...fields[0], texture: [guid] }])).toMatchObject({
      ok: false,
      error: { code: 'vfx-field-invalid' },
    });
  });

  it('rejects nonportable f32 inverse and shader-cofactor arithmetic before field planning', () => {
    for (const scale of [
      [1e20, 1e20, 1e-40],
      [1e20, 1e20, 1e-10],
      [1e38, 1e-20, 1e-20],
    ]) {
      const matrix = [...transform];
      matrix[0] = scale[0] ?? 1;
      matrix[5] = scale[1] ?? 1;
      matrix[10] = scale[2] ?? 1;
      expect(isVfxFieldTransform(new Float32Array(matrix))).toBe(false);
      expect(validateVfxForceFields([{ ...fields[0], transform: matrix }])).toMatchObject({
        ok: false,
        error: { code: 'vfx-field-invalid' },
      });
    }
    const translated = [...transform];
    translated[0] = translated[5] = 1e10;
    translated[10] = 1e-10;
    translated[14] = 1e30;
    expect(isVfxFieldTransform(translated)).toBe(false);
    expect(isVfxFieldTransform([0, 2, 0, 0, -1, 0, 0, 0, 0, 0, 0.5, 0, 0.125, -0.25, 0, 1])).toBe(
      true,
    );
  });
});

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
