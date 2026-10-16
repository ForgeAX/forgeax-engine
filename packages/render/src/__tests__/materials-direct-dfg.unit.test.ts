import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import {
  type AssetGuid,
  resolveMaterialAsset,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials.js';

describe('Standard direct multiscattering quality', () => {
  it('keeps the default and explicit fit free of an optional LUT contract', () => {
    for (const directMultiscattering of [undefined, 'fit'] as const) {
      const material = Materials.standard({
        baseColor: [1, 1, 1, 1],
        ...(directMultiscattering === undefined ? {} : { directMultiscattering }),
      });
      expect(material.parameters?.some((p) => p.name === 'directMultiscatteringLut')).toBe(false);
      expect(material.values).not.toHaveProperty('directMultiscatteringLut');
    }
    for (const schema of [
      DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      STANDARD_PIPELINE_PARAM_SCHEMA,
      standardSurfaceParameters([]),
    ]) {
      expect(schema.some((p) => p.name === 'directMultiscatteringLut')).toBe(false);
    }
  });

  it('publishes one real u32 field across Forward and Deferred without a user texture slot', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      directMultiscattering: 'lut',
    });
    expect(material.parameters).toContainEqual({
      name: 'directMultiscatteringLut',
      type: 'u32',
      default: 1,
      optional: true,
    });
    expect(material.values?.directMultiscatteringLut).toBe(1);
    expect(material.parameters?.some((p) => p.name === 'directDfgLut')).toBe(false);
    expect(material.passes?.map((p) => p.name)).toContain('deferred');
    expect(material.passes?.map((p) => p.name)).toContain('forward');
  });

  it('keeps LUT capability when a child switches its real uniform value to fit', () => {
    const parent = Materials.standard({ baseColor: [1, 1, 1, 1], directMultiscattering: 'lut' });
    const resolved = resolveMaterialAsset('child', {
      parent,
      child: {
        kind: 'material',
        parent: 'parent' as unknown as AssetGuid,
        values: { directMultiscatteringLut: 0 },
      },
    }).unwrap();
    expect(resolved.asset.parameters).toEqual(parent.parameters);
    expect(resolved.asset.values?.directMultiscatteringLut).toBe(0);
  });

  it('admits the same explicit field on a custom Surface and preserves nonzero values', () => {
    const material = Materials.standard({
      surfaceModule: 'game::surface',
      parameters: [{ name: 'directMultiscatteringLut', type: 'u32', default: 1 }],
      values: { directMultiscatteringLut: 2 },
    });
    expect(material.parameters?.filter((p) => p.name === 'directMultiscatteringLut')).toEqual([
      { name: 'directMultiscatteringLut', type: 'u32', default: 1 },
    ]);
    expect(material.values?.directMultiscatteringLut).toBe(2);
  });

  it('rejects an unknown public quality instead of silently choosing the fit', () => {
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        // @ts-expect-error Exercise the JavaScript boundary, not only the type union.
        directMultiscattering: 'high',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'material-authoring-contract-invalid',
        detail: expect.objectContaining({ parameter: 'directMultiscattering' }),
      }),
    );
  });
});
