import { World } from '@forgeax/engine-ecs';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  collectMaterialTextureSources,
  type MaterialTextureSourceCache,
  materialTextureSourceFields,
} from '../render-system-extract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import {
  createRenderTargetMaterialSource,
  resolveRenderTargetMaterialSource,
} from '../targets/material-source';
import { createRenderTargetOwner } from '../targets/owner';
import { CanvasTexture } from '../textures/canvas-texture';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 8,
  height: 8,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: false,
};

describe('material texture source projection', () => {
  it('admits only schema-declared texture fields for numeric source handles', () => {
    const world = new World();
    const owner = createRenderTargetOwner({
      rendererId: Symbol('material-source'),
      getGeneration: () => 1,
    });
    const target = owner.create(descriptor);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const binding = createRenderTargetMaterialSource(target.value, descriptor, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
      generation: 1,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    const handle = world.internSharedRef('RenderTargetTextureSource', binding.value.source);
    const stats = {
      sourceFieldsVisited: 0,
      numericSharedRefProbes: 0,
      sourceCacheHits: 0,
      sourceCacheMisses: 0,
      producerRoutes: {},
    };
    const cache: MaterialTextureSourceCache = new Map();
    const sources = collectMaterialTextureSources(
      { roughness: Number(handle), baseColorTexture: Number(handle) },
      world,
      new Set(['baseColorTexture']),
      stats,
      cache,
    );
    collectMaterialTextureSources(
      { baseColorTexture: Number(handle) },
      world,
      new Set(['baseColorTexture']),
      stats,
      cache,
    );
    expect(sources.get('baseColorTexture')).toBe(binding.value.source);
    expect(sources.has('roughness')).toBe(false);
    expect(stats).toMatchObject({
      sourceFieldsVisited: 2,
      numericSharedRefProbes: 2,
      sourceCacheMisses: 1,
      sourceCacheHits: 1,
    });
    expect(resolveRenderTargetMaterialSource(binding.value.source)).toBeDefined();
  });

  it('derives source fields from the published param schema', () => {
    const fields = materialTextureSourceFields([
      { name: 'roughness', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
      { name: 'normal', type: 'texture2d_array' },
      { name: 'sampler', type: 'sampler' },
    ]);
    expect([...(fields ?? [])]).toEqual(['albedo', 'normal']);
  });
});

it('binds Canvas to a declared material texture slot through the ordinary shared reference', () => {
  const world = new World();
  const texture = new CanvasTexture({ width: 8, height: 8 } as OffscreenCanvas);
  const handle = world.allocSharedRef('CanvasTextureSource', texture.source);
  const values = { baseColorTexture: { texture: handle }, roughness: Number(handle) };
  const sources = collectMaterialTextureSources(values, world, new Set(['baseColorTexture']));
  expect([...sources]).toEqual([['baseColorTexture', texture.source]]);
  expect(structuredClone(texture.source)).toEqual(texture.source);
  texture.dispose();
  texture.update();
});

it('rejects builtin texture slots without querying the foreign shared-ref owner', () => {
  const world = new World();
  const resolve = vi.spyOn(world.sharedRefs, 'resolve');
  const cache: MaterialTextureSourceCache = new Map();
  const stats = {
    sourceFieldsVisited: 0,
    numericSharedRefProbes: 0,
    sourceCacheHits: 0,
    sourceCacheMisses: 0,
    producerRoutes: {},
  };
  const values = { absent: 0, builtin: { texture: BUILTIN_BASE - 1 } };
  const fields = new Set(['absent', 'builtin']);
  expect([...collectMaterialTextureSources(values, world, fields, stats, cache)]).toEqual([]);
  expect([...collectMaterialTextureSources(values, world, fields, stats, cache)]).toEqual([]);
  expect(resolve).not.toHaveBeenCalled();
  expect([...cache]).toEqual([
    [0, null],
    [BUILTIN_BASE - 1, null],
  ]);
  expect(stats).toMatchObject({
    sourceFieldsVisited: 4,
    numericSharedRefProbes: 4,
    sourceCacheMisses: 2,
    sourceCacheHits: 2,
  });
});

it('keeps cached borrowed sources and ordinary live, released and reused source handles observable', () => {
  const world = new World();
  const texture = new CanvasTexture({ width: 8, height: 8 } as OffscreenCanvas);
  const handle = world.allocSharedRef('CanvasTextureSource', texture.source);
  expect(Number(handle)).toBeGreaterThanOrEqual(BUILTIN_BASE);
  const resolve = vi.spyOn(world.sharedRefs, 'resolve');
  try {
    expect(collectMaterialTextureSources({ map: handle }, world).get('map')).toBe(texture.source);
    const borrowed: MaterialTextureSourceCache = new Map([[0, texture.source]]);
    expect(
      collectMaterialTextureSources({ map: 0 }, world, undefined, undefined, borrowed).get('map'),
    ).toBe(texture.source);
    world.sharedRefs.release(handle).unwrap();
    expect(collectMaterialTextureSources({ map: handle }, world).size).toBe(0);
    const replacement = world.allocSharedRef('CanvasTextureSource', texture.source);
    expect(
      collectMaterialTextureSources({ stale: handle, live: replacement }, world).has('stale'),
    ).toBe(false);
    expect(collectMaterialTextureSources({ map: replacement }, world).get('map')).toBe(
      texture.source,
    );
    expect(resolve).toHaveBeenCalled();
    world.sharedRefs.release(replacement).unwrap();
  } finally {
    texture.dispose();
  }
});
