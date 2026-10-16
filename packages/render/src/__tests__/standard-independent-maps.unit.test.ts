import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry, STANDARD_SAMPLE_REUSE } from '@forgeax/engine-shader';
import { STANDARD_MATERIAL_PARAM_SCHEMA } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';
import {
  materialStandardTextureMask,
  materialTextureFields,
  resolveMaterialSnapshot,
} from '../render-system-extract';

function requireMask(value: number | undefined): number {
  if (value === undefined) throw new Error('missing Standard texture mask');
  return value;
}

function reuseSelector(mask: number, target: string): number {
  const entry = STANDARD_SAMPLE_REUSE.find((candidate) => candidate.target === target);
  if (entry === undefined) throw new Error(`unknown sample reuse target ${target}`);
  return (mask >>> entry.shift) & (2 ** Math.ceil(Math.log2(entry.sources.length + 1)) - 1);
}

describe('Standard independent scalar maps', () => {
  it('retains independent map handles before the Standard shader registers', () => {
    const fields = materialTextureFields('forgeax::default-standard-pbr', undefined);
    for (const name of [
      'metallicTexture',
      'roughnessTexture',
      'alphaTexture',
      'specularColorTexture',
    ]) {
      expect(fields?.has(name), name).toBe(true);
    }
  });
  it('publishes independent inputs, channels and per-slot coordinates in the default Surface', () => {
    const inputs = {
      metallicTexture: { texture: 1, coordinates: { set: 1, transform: { offset: [0.5, 0] } } },
      roughnessTexture: { texture: 2, coordinates: { set: 0 } },
      alphaTexture: { texture: 3, coordinates: { set: 2 } },
      metallicChannel: 0,
      roughnessChannel: 3,
      alphaChannel: 2,
    } as const;
    const material = Materials.standard({ baseColor: [1, 1, 1, 0.5], ...inputs });
    expect(material.values).toMatchObject(inputs);
    for (const slot of ['metallicTexture', 'roughnessTexture', 'alphaTexture']) {
      expect(material.parameters).toContainEqual(
        expect.objectContaining({ name: slot, type: 'texture' }),
      );
    }
    expect(material.passes?.map((pass) => pass.name)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
    expect(
      materialStandardTextureMask(
        material.parameters,
        'forgeax::default-standard-pbr',
        material.values ?? {},
      ),
    ).toBe(2 ** 18 + 2 ** 19 + 2 ** 20);
  });

  it('defaults to Three-compatible B/G/G scalar channels', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    for (const [name, channel] of [
      ['metallicChannel', 2],
      ['roughnessChannel', 1],
      ['alphaChannel', 1],
    ] as const) {
      expect(material.parameters?.some((entry) => entry.name === name)).toBe(true);
      expect(STANDARD_MATERIAL_PARAM_SCHEMA.find((entry) => entry.name === name)?.default).toBe(
        channel,
      );
    }
  });

  it('specializes repeated scalar-map samples only for the same texture, sampler and UV', () => {
    const fields = ['metallicTexture', 'roughnessTexture', 'alphaTexture'] as const;
    const values = Object.fromEntries(fields.map((field) => [field, 1]));
    const textureHandles = new Map(fields.map((field) => [field, 1]));
    const sampling = {
      textureHandles,
      samplerHandles: new Map(),
      textureCoordinates: new Map(),
    };
    const mask = requireMask(
      materialStandardTextureMask(undefined, 'forgeax::default-standard-pbr', values, sampling),
    );
    expect(reuseSelector(mask, 'roughnessTexture')).toBe(3); // roughness reuses metallic
    expect(reuseSelector(mask, 'alphaTexture')).toBe(3); // alpha reuses metallic

    const differentUv = requireMask(
      materialStandardTextureMask(undefined, 'forgeax::default-standard-pbr', values, {
        ...sampling,
        textureCoordinates: new Map([['roughnessTexture', { set: 1 }]]),
      }),
    );
    expect(reuseSelector(differentUv, 'roughnessTexture')).toBe(0);
    expect(reuseSelector(differentUv, 'alphaTexture')).toBe(3);

    const differentSampler = requireMask(
      materialStandardTextureMask(undefined, 'forgeax::default-standard-pbr', values, {
        ...sampling,
        samplerHandles: new Map([['alphaTexture', 2]]),
      }),
    );
    expect(reuseSelector(differentSampler, 'alphaTexture')).toBe(0);
  });

  it('reuses earlier base-color and packed samples when their inputs agree', () => {
    const values = {
      baseColorTexture: 7,
      metallicRoughnessTexture: 8,
      metallicTexture: 8,
      roughnessTexture: 8,
      alphaTexture: 7,
    };
    const mask = requireMask(
      materialStandardTextureMask(undefined, 'forgeax::default-standard-pbr', values, {
        textureHandles: new Map(Object.entries(values)),
        samplerHandles: new Map(),
        textureCoordinates: new Map(),
      }),
    );
    expect(reuseSelector(mask, 'metallicTexture')).toBe(2); // metallic reuses packed
    expect(reuseSelector(mask, 'roughnessTexture')).toBe(2); // roughness reuses packed
    expect(reuseSelector(mask, 'alphaTexture')).toBe(1); // alpha reuses base color
  });

  it('projects reuse into the renderer material snapshot', () => {
    const world = new World();
    const assets = new AssetRegistry(
      new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('unexpected shader compile');
          },
        },
        manifestUrl: undefined,
      }),
    );
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallicTexture: 1,
        roughnessTexture: 1,
        alphaTexture: 1,
      }),
    );
    const mask = requireMask(resolveMaterialSnapshot(material, world, assets).standardTextureMask);
    expect(reuseSelector(mask, 'roughnessTexture')).toBe(3);
    expect(reuseSelector(mask, 'alphaTexture')).toBe(3);
  });

  it.each([
    -1,
    4,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid alpha channel %s', (alphaChannel) => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], alphaChannel })).toThrow(
      /alphaChannel/,
    );
  });
});
