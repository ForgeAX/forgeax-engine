import {
  AssetRegistry,
  HANDLE_CUBE,
  RuntimeMaterialValue,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectStandardSurfacePasses } from '../assembly/material/surface-projection';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Materials } from '../materials';
import {
  type MaterialSnapshotCache,
  type MaterialSnapshotCachesByWorld,
  readStablePersistentMaterialSnapshot,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { subsurfaceDemand } from '../subsurface/demand';

describe('material snapshot mutation', () => {
  it('retains a frozen material through mesh-only content changes and observes material edits', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const material: MaterialAsset = Object.freeze({
      kind: 'material',
      passes: Object.freeze([
        Object.freeze({
          name: 'forward',
          program: Object.freeze({ module: 'forgeax::default-unlit' }),
          renderState: Object.freeze({ tags: Object.freeze({ LightMode: 'Forward' }) }),
        }),
      ] as const),
      values: Object.freeze({ baseColor: Object.freeze([1, 0, 0, 1]) }),
    });
    const handle = world.allocSharedRef('MaterialAsset', material);
    const cache: MaterialSnapshotCache = new Map();
    const read = () => resolveMaterialSnapshot(handle, world, assets, undefined, cache);
    const first = read();
    expect(cache.get(handle)?.crossFrameSafe).toBe(true);
    expect(first.immutableValues).toBe(true);
    expect(read()).toBe(first);
    const mesh = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE).unwrap();
    const entity = world
      .spawn({
        component: RuntimeMeshVertices,
        data: { asset: HANDLE_CUBE, vertices: mesh.vertices, indices: [] },
      })
      .unwrap();
    expect(read()).toBe(first);
    const vertices = mesh.vertices.slice();
    vertices[0] = (vertices[0] ?? 0) + 0.25;
    world.set(entity, RuntimeMeshVertices, { vertices }).unwrap();
    expect(read()).toBe(first);
    world.despawn(entity).unwrap();
    expect(read()).toBe(first);
    const value = world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: handle, parameter: 'baseColor', kind: 2, value: [0, 1, 0, 1] },
      })
      .unwrap();
    const green = read();
    expect(green).not.toBe(first);
    expect(green.immutableValues).toBe(true);
    expect(Array.from(green.baseColor)).toEqual([0, 1, 0]);
    expect(Array.from(first.baseColor)).toEqual([1, 0, 0]);
    world.despawn(value).unwrap();
    expect(Array.from(read().baseColor)).toEqual([1, 0, 0]);
  });

  it('retains unrelated frozen material snapshots through another assets runtime edits', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: Error('not registered') }),
    } as unknown as ShaderRegistry);
    const material: MaterialAsset = Object.freeze({
      kind: 'material',
      passes: Object.freeze([
        Object.freeze({
          name: 'forward',
          program: Object.freeze({ module: 'forgeax::default-unlit' }),
          renderState: Object.freeze({ tags: Object.freeze({ LightMode: 'Forward' }) }),
        }),
      ] as const),
      values: Object.freeze({ baseColor: Object.freeze([1, 0, 0, 1]) }),
    });
    const unchanged = world.allocSharedRef('MaterialAsset', material);
    const changing = world.allocSharedRef('MaterialAsset', material);
    const cache: MaterialSnapshotCache = new Map();
    const read = (handle: typeof unchanged) =>
      resolveMaterialSnapshot(handle, world, assets, undefined, cache);
    const first = read(unchanged),
      before = read(changing);
    const value = world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: changing, parameter: 'baseColor', kind: 2, value: [0, 1, 0, 1] },
      })
      .unwrap();
    expect(read(unchanged)).toBe(first);
    const green = read(changing);
    expect(green).not.toBe(before);
    expect(Array.from(green.baseColor)).toEqual([0, 1, 0]);
    world.set(value, RuntimeMaterialValue, { value: [0, 0, 1, 1] }).unwrap();
    expect(read(unchanged)).toBe(first);
    expect(Array.from(read(changing).baseColor)).toEqual([0, 0, 1]);
    world.despawn(value).unwrap();
    expect(read(unchanged)).toBe(first);
    expect(Array.from(read(changing).baseColor)).toEqual([1, 0, 0]);
    world.sharedRefs.release(unchanged).unwrap();
    const epoch = world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: changing, parameter: 'baseColor', kind: 2, value: [0, 1, 0, 1] },
      })
      .unwrap();
    expect(readStablePersistentMaterialSnapshot(cache, unchanged, assets, world)).toBeUndefined();
    expect(read(unchanged)).not.toBe(first);
    world.despawn(epoch).unwrap();
  });

  it('retains color mask and bias through primary/submesh extraction and state edits', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const renderState = {
      tags: { LightMode: 'Forward' },
      colorWriteMask: 0,
      depthBias: -1,
      depthBiasSlopeScale: -2,
      depthBiasClamp: -0.01,
    };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' }, renderState }],
      values: {},
    };
    const handle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    );
    const cache: MaterialSnapshotCachesByWorld = new WeakMap();
    const first = extractFrames([world], 0, assets, undefined, cache).renderables[0];
    expect(first?.material.renderState).toMatchObject({
      colorWriteMask: 0,
      depthBias: -1,
      depthBiasSlopeScale: -2,
      depthBiasClamp: -0.01,
    });
    expect(resolveMaterialSnapshot(handle, world, assets).renderState).toEqual(
      first?.material.renderState,
    );
    renderState.colorWriteMask = 5;
    renderState.depthBias = 2;
    const second = extractFrames([world], 0, assets, undefined, cache).renderables[0];
    expect(second?.material.renderState).toMatchObject({ colorWriteMask: 5, depthBias: 2 });
    expect(first?.material.renderState).toMatchObject({ colorWriteMask: 0, depthBias: -1 });
    expect(second?.gpuDrivenDraws?.[0]?.pipelineClass).not.toBe(
      first?.gpuDrivenDraws?.[0]?.pipelineClass,
    );
  });

  it('projects the same Surface model for primary and reusable submesh snapshots', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const material: MaterialAsset = {
      kind: 'material',
      surface: {
        model: 'single-layer-medium',
        module: 'game::water-surface',
      },
      passes: [
        {
          name: 'color',
          program: { module: 'forgeax::single-layer-medium' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 3000 },
        },
      ],
      values: {},
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );

    const primary = extractFrames([world], 0, assets).renderables[0]?.material;
    const reusable = resolveMaterialSnapshot(materialHandle, world, assets);

    expect(primary?.surfaceModel).toBe('single-layer-medium');
    expect(reusable.surfaceModel).toBe('single-layer-medium');
  });

  it('projects in-place material value updates into the next extracted frame', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const values: Record<string, unknown> = {
      baseColor: [1, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
    };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: values as NonNullable<MaterialAsset['values']>,
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);

    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    const materialCaches: MaterialSnapshotCachesByWorld = new WeakMap();

    const first = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0]
      ?.material;
    expect(first?.baseColor).toEqual(new Float32Array([1, 0, 0]));

    values.baseColor = [0, 1, 0, 1];

    const second = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0]
      ?.material;
    expect(second?.baseColor).toEqual(new Float32Array([0, 1, 0]));
    expect(second).not.toBe(first);
  });

  it('invalidates a retained Standard snapshot when World-owned subsurface values change', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const material = Materials.standard({
      baseColor: [1, 0.4, 0.2, 1],
      subsurfaceRadius: [9, 6, 3],
      subsurfaceWeight: 1,
    });
    const handle = world.allocSharedRef('MaterialAsset', material);
    const radius = world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: handle, parameter: 'subsurfaceRadius', kind: 2, value: [9, 6, 3] },
      })
      .unwrap();
    const weight = world
      .spawn({
        component: RuntimeMaterialValue,
        data: { asset: handle, parameter: 'subsurfaceWeight', kind: 0, value: [1] },
      })
      .unwrap();
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    );
    const caches: MaterialSnapshotCachesByWorld = new WeakMap();
    const extract = () => {
      const snapshot = extractFrames([world], 0, assets, undefined, caches).renderables[0]
        ?.material;
      if (snapshot === undefined) throw new Error('Expected one extracted Standard material');
      return snapshot;
    };

    const active = extract();
    expect(active?.paramSnapshot?.subsurfaceRadius).toEqual([9, 6, 3]);
    expect(subsurfaceDemand([active])).toBe(true);

    world.set(radius, RuntimeMaterialValue, { value: [0, 0, 0] }).unwrap();
    const zeroRadius = extract();
    expect(zeroRadius?.paramSnapshot?.subsurfaceRadius).toEqual([0, 0, 0]);
    expect(subsurfaceDemand([zeroRadius])).toBe(false);

    world.set(radius, RuntimeMaterialValue, { value: [9, 6, 3] }).unwrap();
    world.set(weight, RuntimeMaterialValue, { value: [0] }).unwrap();
    const disabled = extract();
    expect(disabled?.paramSnapshot?.subsurfaceRadius).toEqual([9, 6, 3]);
    expect(disabled?.paramSnapshot?.subsurfaceWeight).toBe(0);
    expect(subsurfaceDemand([disabled])).toBe(false);

    world.set(weight, RuntimeMaterialValue, { value: [1] }).unwrap();
    const restored = extract();
    expect(restored?.paramSnapshot?.subsurfaceRadius).toEqual([9, 6, 3]);
    expect(restored?.paramSnapshot?.subsurfaceWeight).toBe(1);
    expect(subsurfaceDemand([restored])).toBe(true);
  });

  it('keeps the pipeline identity stable for a value-only child update', () => {
    const world = new World();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const values: Record<string, unknown> = { baseColor: [1, 0, 0, 1] };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax_material::standard' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: values as NonNullable<MaterialAsset['values']>,
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    const materialCaches: MaterialSnapshotCachesByWorld = new WeakMap();
    const first = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0];
    values.baseColor = [0, 1, 0, 1];
    const second = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0];

    expect(first?.gpuDrivenDraws?.[0]?.pipelineClass).toBe(
      second?.gpuDrivenDraws?.[0]?.pipelineClass,
    );
    expect(first?.material?.materialShaderId).toBe(second?.material?.materialShaderId);
  });

  it('falsifies legacy surface, physical deferred, and forward fallback projections', () => {
    const basePlan = deriveStandardLayerPlan([]);
    const physicalPlan = deriveStandardLayerPlan([
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);

    const base = projectStandardSurfacePasses({
      surfaceModule: 'game_3d::rusted_iron_surface',
      values: {},
      layerPlan: basePlan,
      geometryVariant: 'rigid',
      lightingLane: 'direct',
    });
    const physical = projectStandardSurfacePasses({
      surfaceModule: 'game_3d::rusted_iron_surface',
      values: {},
      layerPlan: physicalPlan,
      geometryVariant: 'rigid',
      lightingLane: 'direct',
    });
    const legacy = base.map((entry) => ({
      ...entry,
      program: { ...entry.program, moduleSlots: { surface: 'legacy::surface_data' } },
    }));
    const physicalDeferred = physical.some((entry) => entry.name === 'deferred');
    const forwardFallback = base.some((entry) => entry.name === 'forward');

    expect(legacy[0]?.program.moduleSlots?.surface).not.toBe('game_3d::rusted_iron_surface');
    expect(physicalDeferred).toBe(false);
    expect(forwardFallback).toBe(true);
  });
});
