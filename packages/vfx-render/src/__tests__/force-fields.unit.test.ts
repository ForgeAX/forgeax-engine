import {
  isVfxFieldTransform,
  type VfxForceField,
  validateVfxForceFields,
} from '@forgeax/engine-vfx';
import { createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';
import { createVfxForceFieldPreparation } from '../feature/force-fields.js';

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
    const prepare = createVfxForceFieldPreparation();
    const original = texture();
    const first = prepare(fields, new Map([[guid, original]])).unwrap();
    const same = prepare(fields, new Map([[guid, original]])).unwrap();
    expect(same).toBe(first);
    expect(Array.from(first.data.slice(44, 48))).toEqual([0.5, 0.25, -0.125, 0]);
    const replacement = texture();
    new DataView(replacement.data.buffer).setFloat32(0, 2, true);
    const next = prepare(fields, new Map([[guid, replacement]])).unwrap();
    expect(next.revision).not.toBe(first.revision);
    expect(next.data[44]).toBe(2);
    expect(first.data[44]).toBe(0.5);
  });

  it('preserves structured missing, malformed, nonfinite and capacity failures', () => {
    const prepare = createVfxForceFieldPreparation();
    expect(prepare(fields, new Map())).toMatchObject({
      ok: false,
      error: { code: 'vfx-field-asset-missing', detail: { guid } },
    });
    const invalid = texture();
    new DataView(invalid.data.buffer).setFloat32(4, Number.NaN, true);
    expect(prepare(fields, new Map([[guid, invalid]]))).toMatchObject({
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
