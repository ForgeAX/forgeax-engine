import {
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import {
  resolveMaterialAsset,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  validateMaterialValues,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';
import { buildPbrMaterialUserRegionEntries } from '../pbr-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';
import { materialStandardTextureMask } from '../render-system-extract';
import { materialDisplacementRadius } from '../standard-displacement-bounds';

describe('Standard vertex displacement', () => {
  it('keeps height sampling vertex-only within the portable sampler budget', () => {
    const entries = buildPbrMaterialUserRegionEntries(
      [{ name: 'displacementTexture', type: 'texture2d' }],
      [],
      ['displacementTexture'],
    );
    expect(entries.filter((e) => e.texture || e.sampler).map((e) => e.visibility)).toEqual([1, 1]);
  });
  it('preserves both stages for a custom shader with the same texture name', () => {
    const entries = buildPbrMaterialUserRegionEntries([
      { name: 'displacementTexture', type: 'texture2d' },
    ]);
    expect(entries.filter((e) => e.texture || e.sampler).map((e) => e.visibility)).toEqual([3, 3]);
  });
  it('publishes the height texture and signed scale/bias through the material contract', () => {
    const texture = {
      texture: 19 as import('@forgeax/engine-types').AssetHandle<'texture'>,
      coordinates: { set: 1 as const, transform: { scale: [2, 3] as const } },
    };
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      displacementTexture: texture,
      displacementScale: -2,
      displacementBias: 0.5,
    });
    expect(material.values).toMatchObject({
      displacementTexture: texture,
      displacementScale: -2,
      displacementBias: 0.5,
    });
    expect(material.parameters?.map((p) => p.name)).toContain('displacementTexture');
    expect(material.passes?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['forward', 'deferred', 'shadow-caster']),
    );
  });
  it.each(['displacementScale', 'displacementBias'])('rejects non-finite %s', (parameter) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], [parameter]: value })).toThrow(
        expect.objectContaining({
          code: 'material-authoring-contract-invalid',
          detail: expect.objectContaining({ parameter, reason: 'non-finite' }),
        }),
      );
    }
  });
  it('authors the closed displacementMode union as the schema u32', () => {
    expect(STANDARD_MATERIAL_PARAM_SCHEMA.find((p) => p.name === 'displacementMode')).toEqual({
      name: 'displacementMode',
      type: 'u32',
      default: 0,
    });
    expect(STANDARD_PIPELINE_PARAM_SCHEMA.some((p) => p.name === 'displacementMode')).toBe(true);
    const texture = 7 as import('@forgeax/engine-types').AssetHandle<'texture'>;
    for (const [mode, value] of [
      [undefined, 0],
      ['vertex', 0],
      ['parallax', 1],
    ] as const) {
      const material = Materials.standard({
        baseColor: [1, 1, 1, 1],
        normalTexture: texture,
        displacementTexture: texture,
        ...(mode === undefined ? {} : { displacementMode: mode }),
      });
      expect(material.values?.displacementMode).toBe(value);
      expect(material.parameters?.map((p) => p.name)).toContain('displacementMode');
    }
  });
  it('rejects an unknown displacementMode at authoring and value admission', () => {
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        displacementMode: 'both' as 'vertex',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'material-authoring-contract-invalid',
        detail: expect.objectContaining({ parameter: 'displacementMode', reason: 'range' }),
      }),
    );
    const declarations = new Map([
      ['displacementMode', { name: 'displacementMode', type: 'u32', default: 0 } as const],
    ]);
    expect(validateMaterialValues('m', { displacementMode: 1 }, declarations).ok).toBe(true);
    const rejected = validateMaterialValues('m', { displacementMode: 2 }, declarations);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(rejected.error).toMatchObject({
        code: 'material-value-type-mismatch',
        detail: { parameter: 'displacementMode' },
      });
    const authored = Materials.standard({
      baseColor: [1, 1, 1, 1],
      displacementTexture: 3 as import('@forgeax/engine-types').AssetHandle<'texture'>,
    });
    const resolved = resolveMaterialAsset('root', {
      root: { ...authored, values: { ...authored.values, displacementMode: 3 } },
    });
    expect(resolved.ok).toBe(false);
  });
  it('requires normalTexture for parallax at authoring and value admission', () => {
    const height = 4 as import('@forgeax/engine-types').AssetHandle<'texture'>;
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        bumpTexture: height,
        displacementTexture: height,
        displacementMode: 'parallax',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'material-authoring-contract-invalid',
        hint: 'parallax needs normalTexture; bumpTexture is ignored in parallax mode',
        detail: expect.objectContaining({
          parameter: 'displacementMode',
          reason: 'conflict',
          actual: 'normalTexture',
        }),
      }),
    );
    const authored = Materials.standard({
      baseColor: [1, 1, 1, 1],
      normalTexture: height,
      displacementTexture: height,
      displacementMode: 'parallax',
    });
    expect(resolveMaterialAsset('root', { root: authored }).ok).toBe(true);
    const values = { ...authored.values };
    delete values.normalTexture;
    const resolved = resolveMaterialAsset('root', { root: { ...authored, values } });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(resolved.error).toMatchObject({
        code: 'material-parallax-contract-invalid',
        hint: 'parallax needs normalTexture; bumpTexture is ignored in parallax mode',
        detail: { parameter: 'displacementMode', field: 'normalTexture' },
      });
  });
  it('rejects parallax with an independent metallicTexture at authoring and value admission', () => {
    const map = 6 as import('@forgeax/engine-types').AssetHandle<'texture'>;
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        normalTexture: map,
        metallicTexture: map,
        displacementTexture: map,
        displacementMode: 'parallax',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'material-authoring-contract-invalid',
        hint: expect.stringContaining('packed metallicRoughnessTexture'),
        detail: expect.objectContaining({
          parameter: 'displacementMode',
          reason: 'conflict',
          actual: 'metallicTexture',
        }),
      }),
    );
    const authored = Materials.standard({
      baseColor: [1, 1, 1, 1],
      normalTexture: map,
      metallicRoughnessTexture: map,
      displacementTexture: map,
      displacementMode: 'parallax',
    });
    expect(resolveMaterialAsset('root', { root: authored }).ok).toBe(true);
    const resolved = resolveMaterialAsset('root', {
      root: {
        ...authored,
        parameters: [
          ...(authored.parameters ?? []),
          { name: 'metallicTexture', type: 'texture', optional: true },
        ],
        values: { ...authored.values, metallicTexture: map },
      },
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(resolved.error).toMatchObject({
        code: 'material-parallax-contract-invalid',
        hint: expect.stringContaining('packed metallicRoughnessTexture'),
        detail: { parameter: 'displacementMode', field: 'metallicTexture' },
      });
  });
  it('selects the parallax pipeline bit and keeps base-mesh bounds', () => {
    const texture = 5 as import('@forgeax/engine-types').AssetHandle<'texture'>;
    const snapshot = (displacementMode: 'vertex' | 'parallax'): MaterialSnapshot => {
      const material = Materials.standard({
        baseColor: [1, 1, 1, 1],
        normalTexture: texture,
        displacementTexture: texture,
        displacementScale: -2,
        displacementBias: 0.5,
        displacementMode,
      });
      const values = material.values as Record<string, unknown>;
      const mask = materialStandardTextureMask(
        material.parameters,
        'forgeax::default-standard-pbr',
        values,
      );
      return {
        standardTextureMask: mask,
        paramSnapshot: { displacementScale: -2, displacementBias: 0.5 },
      } as unknown as MaterialSnapshot;
    };
    const vertex = snapshot('vertex');
    const parallax = snapshot('parallax');
    expect((vertex.standardTextureMask ?? 0) >= STANDARD_PARALLAX_DISPLACEMENT_BIT).toBe(false);
    expect((parallax.standardTextureMask ?? 0) - (vertex.standardTextureMask ?? 0)).toBe(
      STANDARD_PARALLAX_DISPLACEMENT_BIT,
    );
    expect(materialDisplacementRadius(vertex)).toBe(1.5);
    expect(materialDisplacementRadius(parallax)).toBe(0);
    // Sparse cooked roots carry no mask; the published u32 selects the same policy.
    const cooked = (displacementMode: number) =>
      ({
        materialParamSchema: [{ name: 'displacementTexture', type: 'texture2d' }],
        paramSnapshot: { displacementScale: -2, displacementBias: 0.5, displacementMode },
      }) as unknown as MaterialSnapshot;
    expect(materialDisplacementRadius(cooked(0))).toBe(1.5);
    expect(materialDisplacementRadius(cooked(1))).toBe(0);
  });
});
