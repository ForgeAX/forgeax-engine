import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';
import { STANDARD_MATERIAL_PARAM_SCHEMA, standardSurfaceParameters } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { assembleMaterialWithSkylightEntries } from '../ibl/skylight-bind-group.js';
import { Materials } from '../materials.js';
import {
  materialNormalScale,
  materialProgramKeysForMaterial,
  materialStandardTextureMask,
} from '../render-system-extract';

describe('Materials.standard clearcoat public contract', () => {
  it('samples only authored textures while preserving the shared Surface slot contract', () => {
    const maps = STANDARD_MATERIAL_PARAM_SCHEMA.filter(
      (parameter) => parameter.type === 'texture2d',
    );
    const base = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const surfaceSlots = standardSurfaceParameters([]).filter(
      (parameter) => parameter.type === 'texture',
    );
    expect(base.parameters?.filter((parameter) => parameter.type === 'texture')).toEqual(
      surfaceSlots,
    );
    expect(
      materialStandardTextureMask(
        base.parameters,
        'forgeax::default-standard-pbr',
        base.values ?? {},
      ),
    ).toBe(0);
    for (const [index, map] of maps.entries()) {
      const material = Materials.standard({ baseColor: [1, 1, 1, 1], [map.name]: 1 });
      expect(
        material.parameters
          ?.filter((parameter) => parameter.type === 'texture')
          .map((parameter) => parameter.name)
          .sort(),
      ).toEqual([...new Set([...surfaceSlots.map((slot) => slot.name), map.name])].sort());
      expect(material.values?.[map.name]).toBe(1);
      expect(
        materialStandardTextureMask(
          material.parameters,
          'forgeax::default-standard-pbr',
          material.values ?? {},
        ),
      ).toBe(2 ** index);
      for (const parameters of [undefined, []]) {
        expect(
          materialStandardTextureMask(parameters, 'forgeax::default-standard-pbr', {
            [map.name]: 1,
          }),
        ).toBe(2 ** index);
      }
    }
  });
  it('publishes canonical defaults for omitted Standard numeric values', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], normalTexture: 'normal' });
    expect(material.parameters?.find((p) => p.name === 'normalScale')?.default).toEqual([1, 1]);
    expect(material.parameters?.find((p) => p.name === 'occlusionStrength')?.default).toBe(1);
    expect(material.parameters?.find((p) => p.name === 'ior')?.default).toBe(1.5);
    const explicit = Materials.standard({ baseColor: [1, 1, 1, 1], normalScale: [0.5, -1] });
    expect(explicit.values?.normalScale).toEqual([0.5, -1]);
    expect(explicit.parameters?.find((p) => p.name === 'normalScale')?.default).toEqual([1, 1]);
  });

  it('makes emissive color effective and shares the Three r184 roughness defaults', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      emissive: [0.5, 0.2, 0.1],
      sheenColor: [0.2, 0.3, 0.4],
      staticSwitches: { sheen: true },
    });
    expect(material.values?.roughness).toBe(1);
    for (const name of ['roughness', 'emissiveIntensity', 'sheenRoughness']) {
      expect(material.parameters?.find((p) => p.name === name)?.default).toBe(1);
    }
    const dark = Materials.standard({
      baseColor: [1, 1, 1, 1],
      emissive: [1, 1, 1],
      emissiveIntensity: 0,
      roughness: 0,
    });
    expect(dark.values).toMatchObject({ emissiveIntensity: 0, roughness: 0 });
  });

  it('retains parameter defaults without specializing custom shader roots', () => {
    const parameters = [{ name: 'normalTexture', type: 'texture' as const, default: 1 }];
    expect(materialStandardTextureMask(parameters, 'forgeax::default-standard-pbr', {})).toBe(4);
    expect(materialStandardTextureMask(parameters, 'app::custom-pbr', {})).toBeUndefined();
  });
  it('keeps authored clearcoat declarations but enables the physical pass only by opt-in', () => {
    const base = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const zero = Materials.standard({ baseColor: [1, 1, 1, 1], clearcoat: 0 });
    expect(base.parameters?.map((parameter) => parameter.name)).not.toContain('clearcoat');
    expect(zero.parameters?.map((parameter) => parameter.name)).toContain('clearcoat');
    expect(zero.passes?.map((pass) => pass.name)).toEqual(['forward', 'deferred', 'shadow-caster']);
    const enabled = Materials.standard({
      baseColor: [1, 1, 1, 1],
      clearcoat: 0,
      staticSwitches: { clearcoat: true },
    });
    expect(enabled.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
  });

  it('uses the R, G, and RG channel matrix without a guessed UV set', () => {
    const options = {
      baseColor: [1, 1, 1, 1] as const,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      clearcoatTexture: 1,
      clearcoatRoughnessTexture: 2,
      clearcoatNormalTexture: 3,
      clearcoatNormalScale: 0.75,
    } as Parameters<typeof Materials.standard>[0] & Record<string, unknown>;
    const material = Materials.standard(options);
    expect(material.values).toMatchObject(options);
    expect(material.values).not.toHaveProperty('clearcoatTexCoord');
  });

  it('keeps scalar clearcoat identity without charging unauthored map slots', () => {
    const scalar = Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [1, 1, 1, 1],
      clearcoat: 0,
      clearcoatRoughness: 0.5,
      clearcoatNormalScale: 1,
    });
    const names = scalar.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['clearcoat', 'clearcoatRoughness']));
    expect(names).not.toEqual(
      expect.arrayContaining([
        'clearcoatTexture',
        'clearcoatRoughnessTexture',
        'clearcoatNormalTexture',
      ]),
    );
  });

  it('declares each clearcoat map slot only when its root value is authored', () => {
    const material = Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [1, 1, 1, 1],
      clearcoat: 1,
      clearcoatTexture: 1,
      clearcoatNormalTexture: 2,
    });
    const names = material.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['clearcoatTexture', 'clearcoatNormalTexture']));
    expect(names).not.toContain('clearcoatRoughnessTexture');
  });

  it('keeps physical scalar fields before texture coordinate records', () => {
    const material = Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [1, 1, 1, 1],
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      clearcoatTexture: 1,
    });
    const names = material.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names.indexOf('clearcoat')).toBeLessThan(names.indexOf('clearcoatTexture'));
    expect(names.indexOf('clearcoatRoughness')).toBeLessThan(names.indexOf('clearcoatTexture'));
  });

  it('keeps authored clearcoat map pairs contiguous after the material ABI', () => {
    const sampler = {} as Sampler;
    const view = {} as TextureView;
    const entries = Array.from({ length: 17 }, (_, binding) => ({
      binding,
      resource:
        binding === 0
          ? { kind: 'buffer' as const, value: { buffer: {} as Buffer } }
          : binding % 2 === 1
            ? { kind: 'sampler' as const, value: sampler }
            : { kind: 'textureView' as const, value: view },
    }));
    const merged = assembleMaterialWithSkylightEntries(
      entries,
      {
        irradianceView: view,
        irradianceSampler: sampler,
        prefilterView: view,
        prefilterSampler: sampler,
        brdfLutView: view,
        intensityBuffer: {} as Buffer,
      },
      undefined,
      [
        { slot: 0, sampler, view },
        { slot: 1, sampler, view },
        { slot: 2, sampler, view },
      ],
    );
    expect(
      merged
        .filter((entry) => entry.binding >= 48 && entry.binding < 68)
        .map((entry) => entry.binding),
    ).toEqual([48, 49, 50, 51, 52, 53]);
  });
});

describe('Materials.standard normal and bump inputs', () => {
  it.each([
    [0, 0],
    [0.25, 2],
    [-1, 1],
    [2, -0.5],
  ])('carries [%s, %s] through authoring and extraction', (x, y) => {
    const normalScale = [x, y] as const;
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], normalScale });
    expect(material.values?.normalScale).toEqual(normalScale);
    expect(materialNormalScale(material.values ?? {})).toEqual(normalScale);
    expect(material.parameters).toContainEqual(
      expect.objectContaining({ name: 'normalScale', type: 'vec2' }),
    );
  });
  it.each([
    [Number.NaN, 1],
    [1, Infinity],
    [-Infinity, 1],
  ])('rejects non-finite [%s, %s]', (x, y) => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], normalScale: [x, y] })).toThrowError(
      expect.objectContaining({
        code: 'material-authoring-contract-invalid',
        hint: expect.stringContaining('normalScale'),
        detail: expect.objectContaining({ parameter: 'normalScale', reason: 'non-finite' }),
      }),
    );
  });
  it('uses the two-axis default and rejects legacy scalar input', () => {
    expect(materialNormalScale({})).toEqual([1, 1]);
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        // @ts-expect-error Standard normal strength has two independent axes.
        normalScale: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ reason: 'shape' }) }),
    );
  });
  it('keeps bump texture coordinates and signed strength in the ordinary material contract', () => {
    const bumpTexture = {
      texture: '11111111-1111-1111-1111-111111111111',
      coordinates: { set: 1, transform: { scale: [2, -3], rotation: 0.4 } },
    } as const;
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], bumpTexture, bumpScale: -0.5 });
    expect(material.values?.bumpTexture).toEqual(bumpTexture);
    expect(material.values?.bumpScale).toBe(-0.5);
    expect(material.parameters).toContainEqual(
      expect.objectContaining({ name: 'bumpTexture', type: 'texture' }),
    );
    expect(material.parameters?.some((p) => p.name === 'normalTexture')).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])('rejects non-finite bump strength %s', (bumpScale) => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], bumpScale })).toThrowError(
      expect.objectContaining({
        detail: expect.objectContaining({ parameter: 'bumpScale', reason: 'non-finite' }),
      }),
    );
  });
});

describe('Standard static authoring', () => {
  it('requires a published specialization instead of silently drawing an uncooked switch', () => {
    const assets = { getMaterialProjectionForPayload: () => undefined } as unknown as AssetRegistry;
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      staticSwitches: { textures: false },
    });
    expect(() => materialProgramKeysForMaterial(material, assets, undefined)).toThrowError(
      expect.objectContaining({ code: 'material-specialization-not-cooked' }),
    );
    expect(
      materialProgramKeysForMaterial(
        Materials.standard({ baseColor: [1, 1, 1, 1] }),
        assets,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('keeps the root pass contract and values authorable across static variants', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      transmission: 0.5,
      baseColorTexture: 'unused',
      staticSwitches: { clearcoat: false, transmission: false, textures: false },
    });
    expect(material.staticSwitches).toEqual({
      clearcoat: false,
      transmission: false,
      textures: false,
    });
    expect(material.values?.clearcoat).toBe(0.8);
    expect(material.values?.transmission).toBe(0.5);
    expect(material.values?.baseColorTexture).toBe('unused');
    expect(material.passes?.map((p) => p.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.passes?.[0]?.renderState?.depthWriteEnabled).toBe(false);
  });
});
