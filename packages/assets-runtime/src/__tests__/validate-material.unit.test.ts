// @forgeax/engine-assets-runtime -- material-validation free-function coverage
// (fix issue #709). validateMaterialPasses / validateSpriteSlices /
// materialShaderTextureFieldNames.
//
// The free functions read only `registry.shaderRegistry` / `.metrics` /
// `.assetCatalog`, so a duck-typed stub standing in for AssetRegistry suffices
// (charter F2: test against the surface the code touches, not the whole class).

import {
  type MaterialAsset,
  type ParamSchemaEntry,
  ParamSchemaProjectionOwner,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { AssetRegistry } from '../asset-registry';
import {
  materialShaderTextureFieldNames,
  validateMaterialPasses,
  validateSpriteSlices,
} from '../registry/validate-material';

interface StubShaders {
  [shaderId: string]: readonly ParamSchemaEntry[];
}

function makeRegistry(
  shaders: StubShaders,
  opts: { metrics?: { increment(k: string): void }; catalog?: Map<string, unknown> } = {},
): AssetRegistry {
  const projectionOwner = new ParamSchemaProjectionOwner();
  return {
    shaderRegistry: {
      findMaterialArtifact(id: string) {
        const paramSchema = shaders[id];
        const paramSchemaProjection =
          paramSchema === undefined
            ? undefined
            : projectionOwner.admit({ ownerId: id, revision: 1, schema: paramSchema });
        return paramSchemaProjection !== undefined
          ? {
              ok: true as const,
              value: {
                source: '',
                paramSchema: paramSchemaProjection.schema,
                paramSchemaProjection,
              },
            }
          : { ok: false as const, error: new Error('not found') };
      },
    },
    metrics: opts.metrics ?? null,
    assetCatalog: opts.catalog ?? new Map(),
  } as unknown as AssetRegistry;
}

function mat(over: Record<string, unknown>): MaterialAsset {
  return { kind: 'material', ...over } as unknown as MaterialAsset;
}

describe('validateMaterialPasses', () => {
  it('uses the first asset declaration when parameter names repeat', () => {
    const asset = mat({
      passes: [{ name: 'forward', program: { module: 'game::surface' } }],
      parameters: [
        { name: 'roughness', type: 'f32' },
        { name: 'roughness', type: 'vec4' },
      ],
      values: { roughness: 0.5 },
    });
    expect(validateMaterialPasses(asset)).toBeNull();
    expect(validateMaterialPasses({ ...asset, values: {} })?.detail).toMatchObject({
      missingParams: ['roughness'],
    });
  });
  it('returns null when passes is undefined (inherits from parent)', () => {
    expect(validateMaterialPasses(mat({}))).toBeNull();
  });

  it('errors when passes is an explicit empty array', () => {
    const e = validateMaterialPasses(mat({ passes: [] }));
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { passCount: number }).passCount).toBe(0);
  });

  it('errors when a pass has no program module', () => {
    const e = validateMaterialPasses(mat({ passes: [{ name: 'main', program: { module: '' } }] }));
    expect(e?.code).toBe('asset-invalid-value');
  });

  it('errors when a required (no-default) param is missing from values', () => {
    const e = validateMaterialPasses(
      mat({
        passes: [{ name: 'm', program: { module: 'forgeax_material::standard' } }],
        parameters: [{ name: 'roughness', type: 'f32' }],
      }),
    );
    expect(e?.code).toBe('asset-invalid-value');
    expect((e?.detail as { missingParams: string[] }).missingParams).toContain('roughness');
  });

  it('accepts when a required param is supplied with the right type', () => {
    expect(
      validateMaterialPasses(
        mat({
          passes: [{ name: 'm', program: { module: 'forgeax_material::standard' } }],
          parameters: [{ name: 'roughness', type: 'f32' }],
          values: { roughness: 0.5 },
        }),
      ),
    ).toBeNull();
  });

  it('errors on a supplied param with a mismatched type', () => {
    const e = validateMaterialPasses(
      mat({
        passes: [{ name: 'm', program: { module: 'forgeax_material::standard' } }],
        parameters: [{ name: 'roughness', type: 'f32' }],
        values: { roughness: 'no' },
      }),
    );
    expect((e?.detail as { paramName: string }).paramName).toBe('roughness');
  });

  it('skips params that carry a default', () => {
    expect(
      validateMaterialPasses(
        mat({
          passes: [{ name: 'm', program: { module: 'forgeax_material::standard' } }],
          parameters: [{ name: 'roughness', type: 'f32', default: 0.5 }],
        }),
      ),
    ).toBeNull();
  });

  it('accepts absent and explicitly cleared optional params', () => {
    const material = {
      passes: [{ name: 'm', program: { module: 'forgeax_material::standard' } }],
      parameters: [{ name: 'alphaCutoff', type: 'f32', optional: true }],
    };
    expect(validateMaterialPasses(mat(material))).toBeNull();
    expect(validateMaterialPasses(mat({ ...material, values: { alphaCutoff: null } }))).toBeNull();
  });

  it('still validates a supplied optional param', () => {
    const e = validateMaterialPasses(
      mat({
        passes: [{ name: 'm', program: { module: 'forgeax_material::standard' } }],
        parameters: [{ name: 'alphaCutoff', type: 'f32', optional: true }],
        values: { alphaCutoff: 'no' },
      }),
    );
    expect((e?.detail as { paramName: string }).paramName).toBe('alphaCutoff');
  });
});

describe('validateSpriteSlices', () => {
  const spritePass = { name: 'main', program: { module: 'forgeax_material::sprite' } };

  it('returns null for non-sprite shaders', () => {
    expect(
      validateSpriteSlices(
        mat({ passes: [{ name: 'm', program: { module: 'forgeax::standard' } }] }),
      ),
    ).toBeNull();
  });

  it('returns null when slices is absent', () => {
    expect(validateSpriteSlices(mat({ passes: [spritePass], values: {} }))).toBeNull();
  });

  it('accepts a well-formed slices tuple', () => {
    expect(
      validateSpriteSlices(mat({ passes: [spritePass], values: { slices: [0.1, 0.1, 0.1, 0.1] } })),
    ).toBeNull();
  });

  it('rejects a non-array / wrong-length / non-number slices', () => {
    expect(validateSpriteSlices(mat({ passes: [spritePass], values: { slices: 'x' } }))?.code).toBe(
      'asset-invalid-value',
    );
    expect(
      validateSpriteSlices(mat({ passes: [spritePass], values: { slices: [0, 0, 0] } }))?.code,
    ).toBe('asset-invalid-value');
    expect(
      validateSpriteSlices(mat({ passes: [spritePass], values: { slices: [0, 0, 0, 'x'] } }))?.code,
    ).toBe('asset-invalid-value');
  });

  it('rejects NaN, Infinity, and negative components', () => {
    expect(
      validateSpriteSlices(
        mat({ passes: [spritePass], values: { slices: [Number.NaN, 0, 0, 0] } }),
      ),
    ).not.toBeNull();
    expect(
      validateSpriteSlices(
        mat({ passes: [spritePass], values: { slices: [Number.POSITIVE_INFINITY, 0, 0, 0] } }),
      ),
    ).not.toBeNull();
    expect(
      validateSpriteSlices(mat({ passes: [spritePass], values: { slices: [-0.1, 0, 0, 0] } })),
    ).not.toBeNull();
  });

  it('rejects X-axis / Y-axis overlap against region', () => {
    // default region z/w = 1; left+right = 1.2 >= 1
    expect(
      validateSpriteSlices(mat({ passes: [spritePass], values: { slices: [0.6, 0, 0.6, 0] } })),
    ).not.toBeNull();
    expect(
      validateSpriteSlices(mat({ passes: [spritePass], values: { slices: [0, 0.6, 0, 0.6] } })),
    ).not.toBeNull();
  });
});

describe('materialShaderTextureFieldNames', () => {
  it('returns the texture field-name set derived from paramSchema', () => {
    const reg = makeRegistry({
      'forgeax::x': [
        { name: 'roughness', type: 'f32' },
        { name: 'baseColorTexture', type: 'texture2d' },
      ],
    });
    const names = materialShaderTextureFieldNames(reg, 'forgeax::x');
    expect(names).toBeDefined();
    expect(names?.has('baseColorTexture')).toBe(true);
    expect(names?.has('roughness')).toBe(false);
  });

  it('returns undefined for an unregistered shader', () => {
    expect(materialShaderTextureFieldNames(makeRegistry({}), 'forgeax::nope')).toBeUndefined();
  });
});
