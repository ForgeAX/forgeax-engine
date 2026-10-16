import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import {
  type MaterialAsset,
  type MaterialStaticSwitches,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { lowerStandardContract } from '../lower-standard-contract.js';
import { createMaterialPackCooker } from '../pack-cooker.js';

const parameters = standardSurfaceParameters([
  { name: 'baseColor', type: 'color' },
  { name: 'baseColorTexture', type: 'texture' },
  { name: 'normalTexture', type: 'texture' },
  { name: 'displacementTexture', type: 'texture' },
  { name: 'clearcoat', type: 'f32', default: 0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 0 },
  { name: 'clearcoatTexture', type: 'texture' },
]);
const passes: NonNullable<MaterialAsset['passes']> = [
  { name: 'forward', program: { module: 'forgeax_material::standard' } },
  {
    name: 'shadow-caster',
    program: {
      module: 'forgeax::default-shadow-caster',
      moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
    },
  },
];
async function cook(
  staticSwitches: MaterialStaticSwitches,
  inspectRefs?: (refs: readonly string[]) => void,
) {
  const result = await createMaterialPackCooker().cook({
    guid: 'static-switch-test',
    refs: ['unused-base', 'unused-normal', 'unused-height', 'unused-coat', 'external-keep'],
    source: {
      kind: 'material',
      parameters,
      passes,
      staticSwitches,
      values: {
        baseColorTexture: 'unused-base',
        normalTexture: 'unused-normal',
        displacementTexture: 'unused-height',
        clearcoatTexture: 'unused-coat',
        clearcoat: 0,
      },
    } satisfies MaterialAsset,
  });
  inspectRefs?.(result.refs ?? []);
  return validateCookedMaterialRecord((result.payload as { cooked: unknown }).cooked).unwrap();
}

describe('static Standard feature compilation', { timeout: 30_000 }, () => {
  it('publishes opaque shadow coverage and exact receipts across every raster address', async () => {
    const record = await cook({ alphaClipping: false, alphaHash: false, displacement: false });
    expect(record.resolved.parameters.map((parameter) => parameter.name)).not.toContain(
      'alphaCutoff',
    );
    const shadows = record.programs.filter((program) =>
      program.selections.some((selection) => selection.pass === 'shadow-caster'),
    );
    expect(shadows.length).toBeGreaterThan(0);
    const addresses = new Set<string>();
    const capabilities = new Set<string>();
    for (const program of shadows) {
      const source = new TextDecoder().decode(program.artifact.bytes);
      expect(source).not.toMatch(/\b(?:dpdx|dpdy|surfaceSample|displaceVertex)\s*\(/);
      for (const selection of program.selections) {
        addresses.add(selection.address ?? '');
        capabilities.add(selection.context.capability);
        expect(selection.abi?.vertexInputs.map((input) => input.semantic)).toEqual(['position']);
        expect(selection.abi?.alphaMask).toEqual({ cutoff: '', source: '' });
        expect(selection.abi?.materialRow.fields).not.toContain('alphaCutoff');
      }
    }
    expect(addresses).toEqual(new Set(['direct', 'scene-index']));
    expect(capabilities).toEqual(
      new Set([
        'storage-buffer',
        'storage-buffer-atmosphere',
        'storage-buffer-minimum',
        'storage-buffer-projector',
        'uniform-fallback',
      ]),
    );
  });

  it('prunes bindings, coordinates, samples and decoding in every published path', async () => {
    const record = await cook({ textures: false, clearcoat: false }, (refs) =>
      expect(refs).toEqual(['external-keep']),
    );
    expect(record.resolved.parameters.some((p) => p.type === 'texture')).toBe(false);
    expect(record.refs.textures).toEqual([]);
    expect(record.resolved.values).not.toHaveProperty('clearcoat');
    expect(record.resolved.staticSwitches).toMatchObject({ textures: false, clearcoat: false });
    const selections = record.programs.flatMap((p) => p.selections);
    expect(selections.some((s) => s.pass === 'forward')).toBe(true);
    expect(selections.some((s) => s.pass === 'shadow-caster')).toBe(true);
    expect(selections.some((s) => s.context.pipeline === 'ray')).toBe(true);
    for (const program of record.programs) {
      const source = new TextDecoder().decode(program.artifact.bytes);
      expect(source).not.toMatch(
        /\b(?:materialUvLinear|surfaceUv|surfaceSample|surfaceTriplanarSamples|displaceVertex)\s*\(/,
      );
      expect(source).not.toMatch(
        /\b(?:baseColorTexture|normalTexture|clearcoatTexture|displacementTexture)\b/,
      );
      expect(source).not.toMatch(/\.clearcoat\b/);
    }
  });

  it('omitted layers produce the disabled shader while enabled zero weights remain dynamic', async () => {
    const omitted = await cook({ textures: false, alphaHash: false, alphaClipping: false });
    expect(omitted.resolved.parameters.map((parameter) => parameter.name)).not.toContain(
      'clearcoat',
    );
    for (const program of omitted.programs) {
      const source = new TextDecoder().decode(program.artifact.bytes);
      expect(source).not.toMatch(/evaluateClearcoatLayer|evaluateClearcoatFresnel/);
      for (const selection of program.selections.filter(
        (selection) => selection.pass === 'forward' && selection.context.pipeline !== 'ray',
      )) {
        expect(
          selection.abi?.vertexInputs
            .map((input) => input.semantic)
            .filter((semantic) => semantic !== 'color'),
        ).toEqual(['position', 'normal']);
        expect(selection.abi?.materialRow.byteLength).toBeLessThan(128);
        expect(selection.abi?.materialRow.fields).not.toContain('normalScale');
        expect(source).not.toMatch(
          /applyAlphaHash|alphaHashThreshold|worldTangent|objectBasis|uvPair/,
        );
      }
    }
  });

  it('changes the compiled layout and program identity while retaining enabled code at zero weight', async () => {
    const disabled = await cook({ textures: false, clearcoat: false });
    const enabled = await cook({ textures: true, clearcoat: true }, (refs) =>
      expect(refs).toEqual(
        expect.arrayContaining([
          'unused-base',
          'unused-normal',
          'unused-height',
          'unused-coat',
          'external-keep',
        ]),
      ),
    );
    expect(enabled.receipt.identity.layoutIdentity).not.toBe(
      disabled.receipt.identity.layoutIdentity,
    );
    expect(enabled.specializationKey).not.toBe(disabled.specializationKey);
    expect(
      enabled.programs.some((p) =>
        /\.clearcoat\b/.test(new TextDecoder().decode(p.artifact.bytes)),
      ),
    ).toBe(true);
    expect(
      enabled.programs.some((p) =>
        /textureSample.*\(/.test(new TextDecoder().decode(p.artifact.bytes)),
      ),
    ).toBe(true);
    expect(enabled.resolved.values.clearcoat).toBe(0);
    expect(
      validateCookedMaterialRecord({
        ...enabled,
        resolved: { ...enabled.resolved, staticSwitches: { textures: false, clearcoat: false } },
      }),
    ).toMatchObject({ ok: false, error: { detail: { field: 'resolved.parameters' } } });
  });

  it('derives defines exclusively from the selected schema and layer plan', () => {
    const disabled = lowerStandardContract(parameters, passes, 'test', {
      normalMapping: false,
      displacement: false,
      clearcoat: false,
    }).unwrap();
    expect(disabled.defines.NORMAL_TEXTURE_AVAILABLE).toBeUndefined();
    expect(disabled.defines.DISPLACEMENT_TEXTURE_AVAILABLE).toBeUndefined();
    expect(disabled.defines.CLEARCOAT_AVAILABLE).toBeUndefined();
    expect(disabled.defines.BASE_COLOR_TEXTURE_AVAILABLE).toBe(true);
    expect(disabled.paramSchema.some((p) => p.name === 'clearcoatTexture')).toBe(false);
  });
});
