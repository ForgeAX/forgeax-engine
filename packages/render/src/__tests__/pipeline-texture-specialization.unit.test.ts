import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
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
import { worldRenderResources } from '../publication/resource-scope';
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
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('Material extraction must not compile shaders');
          },
        },
        manifestUrl: undefined,
      }),
    });
    const world = new World({ assets });
    const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const texture = assets
      .create({
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        mips: { kind: 'none' },
        data: new Uint8Array(4),
      })
      .unwrap();
    const plain = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
    const mapped = assets
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          normalTexture: { texture },
        }),
      )
      .unwrap();
    // A directly allocated canonical material may omit parameter declarations.
    // The canonical shader still binds these values, so pruning must retain them.
    const direct = assets
      .create({
        kind: 'material',
        passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
        values: { baseColorTexture: texture, metallicRoughnessTexture: texture },
      })
      .unwrap();
    const a = resolveMaterialSnapshot(plain, worldRenderResources(world), assets);
    const b = resolveMaterialSnapshot(mapped, worldRenderResources(world), assets);
    expect(a.materialParamSchema).toEqual(b.materialParamSchema);
    expect(a.standardTextureMask).toBe(0);
    expect(b.standardTextureMask).toBe(4);
    expect(b.normalTexture).toBe(texture);
    const caster = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const casterPass = caster.passes?.find((pass) => pass.name === 'shadow-caster');
    if (casterPass === undefined) throw new Error('missing shadow caster pass');
    const shadowOnly = assets
      .create({
        ...caster,
        passes: [casterPass],
      })
      .unwrap();
    // A caster-only material must not sample the white displacement fallback.
    expect(
      resolveMaterialSnapshot(shadowOnly, worldRenderResources(world), assets).standardTextureMask,
    ).toBe(0);
    expect(
      resolveMaterialSnapshot(direct, worldRenderResources(world), assets).standardTextureMask,
    ).toBe(3);
    registerPropagateTransforms(world);
    for (const material of [plain, mapped, direct]) {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: cube } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    world.update(0).unwrap();
    const frame = extractFrame(world, prepareExtractContext(world, { assets, cull: 'none' }));
    expect(frame.renderables.map((item) => item.material.snapshot.standardTextureMask)).toEqual([
      0, 4, 3,
    ]);
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

  it('preserves common texture specialization in both shader stages', () => {
    const module = {};
    const descriptor = buildPipelineDescriptor(spec({ '64000': 0 }), {
      vertex: module,
      fragment: module,
    });
    expect(descriptor.fragment).toMatchObject({ module, constants: { '64000': 0 } });
    expect(descriptor.vertex).toMatchObject({ module, constants: { '64000': 0 } });
  });

  it('separates vertex overrides from fragment values and includes them in cache identity', () => {
    const base = spec({ '64000': 5, '64001': 0 });
    const scoped = { ...base, shader: { ...base.shader, vertexConstants: { '64000': 5 } } };
    const module = {};
    const descriptor = buildPipelineDescriptor(scoped, { vertex: module, fragment: module });
    expect(descriptor.vertex).toMatchObject({ module, constants: { '64000': 5 } });
    expect(descriptor.vertex).not.toHaveProperty('constants.64001');
    expect(descriptor.fragment).toMatchObject({ constants: { '64000': 5, '64001': 0 } });
    expect(cacheKeyOf(scoped)).not.toBe(cacheKeyOf(base));
    expect(cacheKeyOf(scoped)).not.toBe(
      cacheKeyOf({
        ...scoped,
        shader: { ...scoped.shader, vertexConstants: { '64000': 7 } },
      }),
    );
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
