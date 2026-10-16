import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  standardTextureMask,
} from '../../../shader/src/material-schemas';
import { MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { buildPipelineDescriptor, cacheKeyOf, type PipelineSpec } from '../pipeline-spec';
import { prepareExtractContext, resolveMaterialSnapshot } from '../render-system-extract';
import { extractFrame } from '../render-system-extract-tail';

function spec(constants?: Readonly<Record<string, number>>): PipelineSpec {
  return {
    shader: {
      id: 'standard',
      passKind: 'forward',
      variantSet: undefined,
      constants: constants,
    },
    attachments: { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
}

describe('material pipeline texture specialization', () => {
  it('preserves authored texture presence separately from the canonical UBO layout', async () => {
    const assets = new AssetRegistry(
      new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('Material extraction must not compile shaders');
          },
        },
        manifestUrl: undefined,
      }),
    );
    const world = new World();
    const plain = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1] }),
    );
    const mapped = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        normalTexture: { texture: '11111111-1111-1111-1111-111111111111' },
      }),
    );
    // A directly allocated canonical material may omit parameter declarations.
    // The canonical shader still binds these values, so pruning must retain them.
    const direct = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
      values: { baseColorTexture: 1, metallicRoughnessTexture: 2 },
    });
    const a = resolveMaterialSnapshot(plain, world, assets);
    const b = resolveMaterialSnapshot(mapped, world, assets);
    expect(a.materialParamSchema).toEqual(b.materialParamSchema);
    expect(a.standardTextureMask).toBe(0);
    expect(b.standardTextureMask).toBe(4);
    expect(b.normalTexture).toBeUndefined();
    expect(resolveMaterialSnapshot(direct, world, assets).standardTextureMask).toBe(3);
    registerPropagateTransforms(world);
    for (const material of [plain, mapped, direct]) {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    world.update(0).unwrap();
    const frame = extractFrame(world, prepareExtractContext(world, { assets, cull: 'none' }));
    expect(frame.renderables.map((item) => item.material.standardTextureMask)).toEqual([0, 4, 3]);
  });
  it('derives each map bit from declarations, independent of resource readiness', () => {
    const textures = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
      (entry) => entry.type === 'texture2d',
    );
    expect(textures).toHaveLength(24);
    expect(standardTextureMask([])).toBe(0);
    expect(standardTextureMask(DEFAULT_STANDARD_PBR_PARAM_SCHEMA)).toBe(2 ** textures.length - 1);
    for (const [index, texture] of textures.entries()) {
      expect(standardTextureMask([texture])).toBe(2 ** index);
    }
  });
  it('separates absent, enabled and default texture specializations in the PSO cache', () => {
    expect(new Set([spec(), spec({ '64000': 0 }), spec({ '64000': 1 })].map(cacheKeyOf)).size).toBe(
      3,
    );
    expect(cacheKeyOf(spec({ '64001': 2, '64000': 1 }))).toBe(
      cacheKeyOf(spec({ '64000': 1, '64001': 2 })),
    );
  });

  it('forwards specialization values to both shader stages without changing the module', () => {
    const module = {};
    const descriptor = buildPipelineDescriptor(spec({ '64000': 0 }), {
      vertex: module,
      fragment: module,
    });
    expect(descriptor.fragment).toMatchObject({ module, constants: { '64000': 0 } });
    expect(descriptor.vertex).toMatchObject({ module, constants: { '64000': 0 } });
  });

  it('keeps authored entry points and texture overrides orthogonal in descriptors and cache keys', () => {
    const base = spec({ '64000': 0 });
    const authored: PipelineSpec = {
      ...base,
      shader: { ...base.shader, vertexEntry: 'custom_vs', fragmentEntry: 'custom_fs' },
    };
    const mapped: PipelineSpec = {
      ...authored,
      shader: { ...authored.shader, constants: { '64000': 4 } },
    };
    expect(new Set([base, authored, mapped].map(cacheKeyOf)).size).toBe(3);
    const module = {};
    const descriptor = buildPipelineDescriptor(authored, {
      vertex: module,
      fragment: module,
      fragmentEntryPoint: 'fs_main_hdr',
    });
    expect(descriptor.vertex).toMatchObject({ entryPoint: 'custom_vs' });
    expect(descriptor.fragment).toMatchObject({
      entryPoint: 'custom_fs',
      constants: { '64000': 0 },
    });
  });
});
