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
import { testAssets } from './helpers/runtime-assets';

function fixture() {
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('unexpected shader compile');
        },
      },
      manifestUrl: undefined,
    }),
  });
  world.bindAssets(assets).unwrap();
  return { world, assets };
}

describe('materialSampledTextureBudget', () => {
  it('leaves custom shaders to own their layout', () => {
    const { world, assets } = fixture();
    const material = testAssets(world)
      .create(Materials.unlit([1, 1, 1, 1]))
      .unwrap();
    expect(materialSampledTextureBudget(world, assets, material)).toBeUndefined();
  });

  it('fits an opaque Standard material in the portable budget', () => {
    const { world, assets } = fixture();
    const material = testAssets(world)
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          metallicTexture: assets
            .create({
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array([255, 255, 255, 255]),
            })
            .unwrap(),
        }),
      )
      .unwrap();
    expect(materialSampledTextureBudget(world, assets, material)).toEqual({
      limit: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      required: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      transmission: 'none',
      conflicts: [],
    });
  });

  it('counts the explicitly requested direct DFG texture above the default portable budget', () => {
    const { world, assets } = fixture();
    const material = testAssets(world)
      .create(Materials.standard({ baseColor: [1, 1, 1, 1], directMultiscattering: 'lut' }))
      .unwrap();
    expect(materialSampledTextureBudget(world, assets, material)).toEqual({
      limit: 16,
      required: 17,
      transmission: 'none',
      conflicts: [],
    });
  });

  it('admits transmission through shared slots at the portable limit', () => {
    const { world, assets } = fixture();
    const material = testAssets(world)
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          transmission: 1,
          transmissionTexture: assets
            .create({
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array([255, 255, 255, 255]),
            })
            .unwrap(),
        }),
      )
      .unwrap();
    expect(materialSampledTextureBudget(world, assets, material)).toMatchObject({
      required: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      transmission: 'shared',
      conflicts: [],
    });
  });

  it('names the split scalar map that blocks shared transmission', () => {
    const { world, assets } = fixture();
    const material = testAssets(world)
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          transmission: 1,
          metallicTexture: assets
            .create({
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array([255, 255, 255, 255]),
            })
            .unwrap(),
        }),
      )
      .unwrap();
    expect(materialSampledTextureBudget(world, assets, material)).toEqual({
      limit: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      required: STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      transmission: 'exceeded',
      conflicts: ['metallicTexture'],
    });
  });

  it('uses the dedicated layout when the limit covers it', () => {
    const { world, assets } = fixture();
    const material = testAssets(world)
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          transmission: 1,
          metallicTexture: assets
            .create({
              kind: 'texture',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array([255, 255, 255, 255]),
            })
            .unwrap(),
        }),
      )
      .unwrap();
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
