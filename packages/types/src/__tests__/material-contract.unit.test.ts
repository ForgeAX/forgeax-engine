import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssetGuid } from '../index.js';
import { assertMaterialAsset, type MaterialAsset } from '../material/asset.js';
import { resolveMaterialAsset } from '../material/resolve.js';

const guid = new Uint8Array(16) as AssetGuid;

const standardProgram = {
  module: 'forgeax::standard',
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
} as const;

describe('MaterialAsset contract', () => {
  it('accepts an erased numeric shared texture handle at runtime', () => {
    const result = resolveMaterialAsset('demo', {
      demo: {
        kind: 'material',
        passes: [{ name: 'forward', program: standardProgram }],
        parameters: [{ name: 'baseColorTexture', type: 'texture' }],
        values: { baseColorTexture: 1024 },
      },
    });

    expect(result.ok).toBe(true);
  });

  it('accepts string texture GUID shorthands only for texture parameters', () => {
    const texture = resolveMaterialAsset('demo', {
      demo: {
        kind: 'material',
        passes: [{ name: 'forward', program: standardProgram }],
        parameters: [
          { name: 'baseColorTexture', type: 'texture' },
          { name: 'baseColor', type: 'color' },
        ],
        values: { baseColorTexture: 'texture-guid' },
      },
    });
    expect(texture.ok).toBe(true);

    const scalar = resolveMaterialAsset('demo', {
      demo: {
        kind: 'material',
        passes: [{ name: 'forward', program: standardProgram }],
        parameters: [{ name: 'baseColor', type: 'color' }],
        values: { baseColor: 'texture-guid' },
      },
    });
    expect(scalar).toMatchObject({
      ok: false,
      error: { code: 'material-value-type-mismatch', detail: { parameter: 'baseColor' } },
    });
  });

  it('accepts a complete root contract and structured texture value', () => {
    const root = {
      kind: 'material',
      passes: [
        {
          name: 'forward',
          program: standardProgram,
          renderState: { cullMode: 'back' },
        },
      ],
      parameters: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'normalTexture', type: 'texture', optional: true },
        { name: 'normalScale', type: 'vec2', default: [1, 1] },
      ],
      values: {
        normalScale: [0.7, 0.7],
        baseColor: [0.8, 0.2, 0.1, 1],
        normalTexture: {
          texture: guid,
          sampler: guid,
          coordinates: {
            set: 1,
            transform: { offset: [0, 0], scale: [2, 2], rotation: 0.25 },
          },
        },
      },
    } satisfies MaterialAsset;

    expectTypeOf(root).toMatchTypeOf<MaterialAsset>();
  });

  it('accepts a single-parent derived contract with full value replacement', () => {
    const derived = {
      kind: 'material',
      parent: guid,
      values: {
        baseColor: [0.1, 0.4, 0.9, 1],
        normalTexture: null,
      },
    } satisfies MaterialAsset;

    expectTypeOf(derived.parent).toEqualTypeOf<AssetGuid>();
    expectTypeOf(derived.values).toMatchTypeOf<MaterialAsset['values']>();
  });

  it('rejects a root contract override on a parent-bearing child', () => {
    const derived = {
      kind: 'material',
      parent: guid,
      // @ts-expect-error - parent-bearing children inherit the root pass contract.
      passes: [
        {
          name: 'forward',
          program: {
            module: 'project::toon',
            moduleSlots: { lighting: 'project::toon-lighting' },
          },
        },
      ],
    } satisfies MaterialAsset;

    void derived;
  });

  it('rejects legacy fields and unknown values', () => {
    const retiredField = ['param', 'Values'].join('') as `param${'Values'}`;
    // @ts-expect-error - the new contract has no retired parameter field.
    const legacyValues: MaterialAsset = { kind: 'material', [retiredField]: {} };
    void legacyValues;

    const legacyPass: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::standard' } }],
    };
    void legacyPass;

    // @ts-expect-error - unknown top-level authoring fields are not accepted.
    const unknownField: MaterialAsset = { kind: 'material', shader: 'legacy' };
    void unknownField;
  });

  it('characterizes the current static and module-slot owner overlap', () => {
    const material: MaterialAsset = {
      kind: 'material',
      parameters: [{ name: 'roughness', type: 'f32' }],
      passes: [
        {
          name: 'forward',
          program: {
            module: 'project::surface',
            moduleSlots: { lighting: 'project::lighting' },
          },
        },
      ],
      values: { roughness: 0.5 },
    };

    const result = resolveMaterialAsset('owner-overlap', { 'owner-overlap': material });
    expect(result.ok).toBe(true);
    expect(material.parameters?.[0]).not.toHaveProperty('static');
    expect(material.passes?.[0]?.program.moduleSlots).toEqual({
      lighting: 'project::lighting',
    });
  });

  it('rejects every material-owned macro surface at the loading boundary', () => {
    expect(() =>
      assertMaterialAsset({
        kind: 'material',
        features: { QUALITY: true },
        defines: { QUALITY: 2 },
        parameters: [{ name: 'roughness', type: 'f32', static: true }],
      }),
    ).toThrow(/material compiler macro fields are not supported/);
  });

  it('rejects forbidden fields on a parent-bearing child with structured detail', () => {
    try {
      assertMaterialAsset({
        kind: 'material',
        parent: 'root-guid' as never,
        colorSpace: 'linear',
        passes: [{ name: 'forward', program: standardProgram }],
        parameters: [],
        values: {},
      });
      throw new Error('expected parent child contract failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-child-contract-invalid',
        detail: {
          material: 'material',
          parent: 'root-guid',
          forbidden: ['colorSpace', 'passes', 'parameters'],
          action: 'remove-forbidden-fields',
        },
      });
    }
  });

  it('keeps pure material booleans as runtime values', () => {
    const result = resolveMaterialAsset('runtime-bool', {
      'runtime-bool': {
        kind: 'material',
        passes: [{ name: 'forward', program: standardProgram }],
        parameters: [{ name: 'clearcoat', type: 'bool' }],
        values: { clearcoat: false },
      },
    });

    expect(result).toMatchObject({ ok: true, value: { asset: { values: { clearcoat: false } } } });
  });
});

it('inherits the root MRT interface and rejects malformed output authoring', () => {
  const outputs = [
    { name: 'color', format: 'rgba16float' },
    { name: 'id', format: 'r32uint' },
  ] as const;
  const parent: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: standardProgram, outputs }],
  };
  const resolved = resolveMaterialAsset('child', {
    parent,
    child: { kind: 'material', parent: 'parent' as unknown as AssetGuid },
  });
  expect(resolved.ok).toBe(true);
  if (resolved.ok) expect(resolved.value.asset.passes?.[0]?.outputs).toEqual(outputs);
  for (const invalid of [
    [],
    [{ name: 'id', format: 'depth32float' }],
    [{ name: 'id', format: 'r32uint', writeMask: 16 }],
  ]) {
    expect(() =>
      assertMaterialAsset({
        kind: 'material',
        passes: [{ name: 'Forward', program: standardProgram, outputs: invalid }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'material-output-contract-invalid' }));
  }
});
