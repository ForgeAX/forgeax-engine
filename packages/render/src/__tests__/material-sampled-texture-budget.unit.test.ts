import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from '../assembly/device-feature-admission';
import {
  materialSampledTextureBudget,
  WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
} from '../material-sampled-texture-budget';
import { Materials } from '../materials';

function fixture() {
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
  return { world, assets };
}

describe('materialSampledTextureBudget', () => {
  it('leaves custom shaders to own their layout', () => {
    const { world, assets } = fixture();
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 1, 1, 1]));
    expect(materialSampledTextureBudget(world, assets, material)).toBeUndefined();
  });

  it('fits an opaque Standard material in the portable budget', () => {
    const { world, assets } = fixture();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], metallicTexture: 1 }),
    );
    expect(materialSampledTextureBudget(world, assets, material)).toEqual({
      limit: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      required: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      transmission: 'none',
      conflicts: [],
    });
  });

  it('counts the explicitly requested direct DFG texture above the default portable budget', () => {
    const { world, assets } = fixture();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], directMultiscattering: 'lut' }),
    );
    expect(materialSampledTextureBudget(world, assets, material)).toEqual({
      limit: 16,
      required: 17,
      transmission: 'none',
      conflicts: [],
    });
  });

  it('admits transmission through shared slots at the portable limit', () => {
    const { world, assets } = fixture();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 1,
        transmissionTexture: 1,
      }),
    );
    expect(materialSampledTextureBudget(world, assets, material)).toMatchObject({
      required: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      transmission: 'shared',
      conflicts: [],
    });
  });

  it('names the split scalar map that blocks shared transmission', () => {
    const { world, assets } = fixture();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 1,
        metallicTexture: 1,
      }),
    );
    expect(materialSampledTextureBudget(world, assets, material)).toEqual({
      limit: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      required: STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      transmission: 'exceeded',
      conflicts: ['metallicTexture'],
    });
  });

  it('uses the dedicated layout when the limit covers it', () => {
    const { world, assets } = fixture();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 1,
        metallicTexture: 1,
      }),
    );
    expect(
      materialSampledTextureBudget(world, assets, material, STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES),
    ).toEqual({
      limit: STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      required: STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      transmission: 'dedicated',
      conflicts: [],
    });
  });
});
