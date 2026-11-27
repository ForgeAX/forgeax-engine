import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry, STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive, materialLightingInputBindings } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from '../assembly/device-feature-admission';
import { materialLayoutProjections } from '../assembly/material-pipeline-requests';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  materialSampledTextureBudget,
  WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
} from '../material-sampled-texture-budget';
import { Materials } from '../materials';
import {
  buildBindGroupLayoutDescriptor,
  canProjectOpaqueStandardMaterial,
  projectOpaqueStandardMaterialEntries,
} from '../pbr-pipeline';
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

describe('opaque Standard material layout', () => {
  const entries = (transmissionBackdrop: boolean) =>
    buildBindGroupLayoutDescriptor(
      {
        shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      { kind: 'pbr-material-merged', caps: { storageBuffer: true, transmissionBackdrop } },
    ).entries;
  const fragmentTextures = (bindings: ReturnType<typeof entries>) =>
    bindings.filter(
      (entry) => entry.texture && (entry.visibility & GPU_SHADER_STAGE_FRAGMENT) !== 0,
    );
  const { brdfLut, irradianceSampler } = materialLightingInputBindings(
    derive(STANDARD_PIPELINE_PARAM_SCHEMA).userRegionBindingEnd,
  );
  it('omits dedicated transmission maps without shifting surface bindings', () => {
    const full = entries(true);
    const opaque = projectOpaqueStandardMaterialEntries(full);
    expect(opaque).toEqual(
      entries(false).filter(
        (entry) => entry.binding !== brdfLut && entry.binding !== irradianceSampler,
      ),
    );
    const opaqueTextureSlots = new Set(fragmentTextures(opaque).map((entry) => entry.binding));
    expect(
      fragmentTextures(full)
        .filter((entry) => !opaqueTextureSlots.has(entry.binding))
        .map((entry) => entry.binding),
    ).toEqual([12, 14]);
  });

  it('reuses entry projections across pipeline requests and distinguishes a new publication', () => {
    const vertex = {
      name: 'vs_scene_index',
      stage: 'vertex',
      bindings: [
        { group: 0, binding: 0 },
        { group: 3, binding: 2 },
      ],
    } as const;
    const fragment = {
      name: 'fs_gbuffer',
      stage: 'fragment',
      bindings: [{ group: 1, binding: 1 }],
    } as const;
    const reads = Object.freeze([vertex, fragment]);
    const project = () => materialLayoutProjections(reads, vertex.name, fragment.name, true);
    const first = project();
    expect(project()).toBe(first);
    expect(first.opaqueStandard).toBe(true);
    expect(first.rasterWindow).toEqual(new Map([[2, 1]]));
    expect(first.material).toEqual(new Set([1]));
    expect(
      materialLayoutProjections(reads, vertex.name, fragment.name, false).material,
    ).toBeUndefined();
    const next = Object.freeze([vertex, { ...fragment, bindings: [{ group: 3, binding: 1 }] }]);
    const after = materialLayoutProjections(next, vertex.name, fragment.name, true);
    expect(after.rasterWindow).toEqual(
      new Map([
        [2, 1],
        [1, 2],
      ]),
    );
    expect(after.probeBlend).toBe(true);
  });

  it('projects physical binding groups from the selected stage pair', () => {
    const vertex = {
      name: 'vs_main',
      stage: 'vertex',
      bindings: [
        { group: 0, binding: 5 },
        { group: 1, binding: 2 },
      ],
    } as const;
    const fragment = {
      name: 'fs_main',
      stage: 'fragment',
      bindings: [
        { group: 0, binding: 5 },
        { group: 1, binding: 7 },
        { group: 2, binding: 33 },
      ],
    } as const;
    const legacy = { ...fragment, bindings: [{ group: 3, binding: 1 }] } as const;
    expect(
      materialLayoutProjections([vertex, fragment, legacy], undefined, 'fs_main', true),
    ).toEqual({
      opaqueStandard: false,
      view: new Map([[5, 3]]),
      material: new Set([2, 7]),
      rasterWindow: undefined,
      primitiveReflection: 2,
      probeBlend: true,
    });
    expect(materialLayoutProjections([fragment], undefined, 'fs_main', true)).toEqual({
      opaqueStandard: false,
      view: undefined,
      material: undefined,
      rasterWindow: undefined,
      primitiveReflection: 2,
      probeBlend: false,
    });
  });

  it('requires the selected vertex and opaque fragment to prove disuse of every removed slot', () => {
    const vertex = { name: 'vs_main', stage: 'vertex', bindings: [] } as const;
    const fragment = { name: 'fs_opaque', stage: 'fragment', bindings: [] } as const;
    expect(canProjectOpaqueStandardMaterial([vertex, fragment], undefined, 'fs_opaque')).toBe(true);
    expect(canProjectOpaqueStandardMaterial([fragment], undefined, 'fs_opaque')).toBe(false);
    expect(canProjectOpaqueStandardMaterial([vertex, fragment], undefined, 'fs_main')).toBe(false);
    const omitted = entries(true).filter(
      (entry) =>
        !projectOpaqueStandardMaterialEntries(entries(true)).some(
          (remaining) => remaining.binding === entry.binding,
        ),
    );
    for (const entry of omitted) {
      const reads = [{ group: 1, binding: entry.binding }] as const;
      expect(
        canProjectOpaqueStandardMaterial(
          [vertex, { ...fragment, bindings: reads }],
          undefined,
          'fs_opaque',
        ),
      ).toBe(false);
      expect(
        canProjectOpaqueStandardMaterial(
          [{ ...vertex, bindings: reads }, fragment],
          undefined,
          'fs_opaque',
        ),
      ).toBe(false);
    }
  });
});

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
      parallax: 'none',
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
      parallax: 'none',
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

  it('reports parallax falling back to normal mapping under shared transmission', () => {
    const { world, assets } = fixture();
    const map = assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array([255, 255, 255, 255]),
      })
      .unwrap();
    const material = (transmission?: number) =>
      testAssets(world)
        .create(
          Materials.standard({
            baseColor: [1, 1, 1, 1],
            ...(transmission === undefined ? {} : { transmission }),
            normalTexture: map,
            displacementTexture: map,
            displacementMode: 'parallax',
          }),
        )
        .unwrap();
    expect(materialSampledTextureBudget(world, assets, material(1))).toMatchObject({
      limit: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      transmission: 'shared',
      parallax: 'normal-mapping',
    });
    expect(
      materialSampledTextureBudget(
        world,
        assets,
        material(1),
        STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      ),
    ).toMatchObject({ transmission: 'dedicated', parallax: 'parallax' });
    expect(materialSampledTextureBudget(world, assets, material())).toMatchObject({
      required: WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
      transmission: 'none',
      parallax: 'parallax',
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
      parallax: 'none',
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
      parallax: 'none',
    });
  });
});
