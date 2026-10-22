import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { deriveStandardLayerPlan, type MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectStandardSurfacePasses } from '../assembly/material/surface-projection';
import { samplerContribution } from '../assets/asset-decoders';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { createEngineMetrics } from '../engine-metrics';
import { Materials } from '../materials';
import { worldRenderResources } from '../publication/resource-scope';
import {
  type MaterialSnapshotCache,
  type MaterialSnapshotCachesByWorld,
  readPersistentMaterialSnapshot,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { subsurfaceDemand } from '../subsurface/demand';
import { subsurfaceSelection } from './subsurface-selection.fixture';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

function fixture(material: MaterialAsset = Materials.unlit([1, 0, 0, 1])) {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const handle = assets.create(material).unwrap();
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const cache: MaterialSnapshotCache = new Map();
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  return {
    assets,
    world,
    handle,
    mesh,
    cache,
    read: () =>
      resolveMaterialSnapshot(handle, worldRenderResources(world), assets, undefined, cache),
    extract: () => {
      const row = extractFrames([world], 0, assets, caches).renderables.at(0);
      if (row === undefined) throw new Error('missing extracted mesh');
      return row;
    },
  };
}

describe('material snapshot mutation', () => {
  it('diagnoses a tiled Sprite sampler once per prepared material revision', () => {
    const f = fixture({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' } }],
      values: { slicesAndMode: [0, 0, 0, -1] },
    });
    const metrics = createEngineMetrics();
    f.assets.setMetrics(metrics);
    const texture = f.assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
      .unwrap();
    const clamp = f.assets.create({ kind: 'sampler', addressModeU: 'clamp-to-edge' }).unwrap();
    const repeat = f.assets
      .create({
        kind: 'sampler',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      })
      .unwrap();
    f.assets
      .update(f.handle, { values: { baseColorTexture: { texture, sampler: clamp } } })
      .unwrap();
    const count = () => metrics.snapshot()['nineslice.tile-needs-repeat-sampler'] ?? 0;
    expect(count()).toBe(0);
    f.read();
    expect(count()).toBe(1);
    for (let index = 0; index < 128; index++) f.read();
    expect(count()).toBe(1);
    f.assets
      .update(f.handle, { values: { baseColorTexture: { texture, sampler: repeat } } })
      .unwrap();
    f.read();
    expect(count()).toBe(1);
    f.assets
      .update(f.handle, {
        values: { slicesAndMode: [0, 0, 0, 1], baseColorTexture: { texture, sampler: clamp } },
      })
      .unwrap();
    f.read();
    expect(count()).toBe(1);
    f.assets.update(f.handle, { values: { slicesAndMode: [0.25, 0.25, 0.25, -0.25] } }).unwrap();
    f.read();
    expect(count()).toBe(2);
    f.assets.dispose();
  });

  it('preserves authored texture and sampler readiness across initial and incremental preparation', () => {
    const f = fixture({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
      parameters: [
        { name: 'baseColorTexture', type: 'texture' },
        { name: 'roughness', type: 'f32', default: 0.5 },
      ],
      values: {},
    });
    const texture = f.assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
      .unwrap();
    const sampler = f.assets.create({ kind: 'sampler', magFilter: 'nearest' }).unwrap();
    f.assets.update(f.handle, { values: { baseColorTexture: { texture, sampler } } }).unwrap();
    const first = f.extract().material.snapshot;
    expect(first.authoredTextureFields).toEqual(new Set(['baseColorTexture']));
    expect(first.authoredSamplerFields).toEqual(new Set(['baseColorTexture']));
    expect(f.read().authoredTextureFields).toEqual(first.authoredTextureFields);
    expect(f.read().authoredSamplerFields).toEqual(first.authoredSamplerFields);
    f.assets.update(f.handle, { values: { roughness: 0.25 } }).unwrap();
    expect(f.read().textureHandles?.get('baseColorTexture')).toBe(texture);
    expect(f.read().samplerHandles?.get('baseColorTexture')).toBe(sampler);
    expect(f.read().authoredTextureFields).toEqual(first.authoredTextureFields);
    expect(f.read().authoredSamplerFields).toEqual(first.authoredSamplerFields);
  });

  it('prepares Sprite flips and default slices identically on initial extraction and asset edits', () => {
    const f = fixture({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' } }],
      values: { region: [0.1, 0.2, 0.3, 0.4], flipX: 1 },
    });
    const first = f.extract().material.snapshot;
    expect(first.paramSnapshot?.region).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(first.paramSnapshot?.flipX).toBe(1);
    expect(first.paramSnapshot?.flipY).toBe(0);
    expect(first.paramSnapshot?.slicesAndMode).toEqual([0, 0, 0, 0]);
    expect(f.read().paramSnapshot).toEqual(first.paramSnapshot);
    f.assets.update(f.handle, { values: { flipX: 0, flipY: 1 } }).unwrap();
    expect(f.read().paramSnapshot?.region).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(f.read().paramSnapshot?.flipX).toBe(0);
    expect(f.read().paramSnapshot?.flipY).toBe(1);
    expect(f.read().paramSnapshot?.slicesAndMode).toEqual([0, 0, 0, 0]);
    expect(first.paramSnapshot?.region).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(first.paramSnapshot?.flipX).toBe(1);
    expect(first.paramSnapshot?.flipY).toBe(0);
  });

  it('keeps MRT attachment state in both initial and incremental material preparation', () => {
    const outputs = [
      { name: 'color', format: 'rgba16float' },
      { name: 'id', format: 'r32uint', writeMask: 1 },
    ] as const;
    const f = fixture({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'game::mrt' }, outputs }],
      values: {},
    });
    expect(f.extract().material.snapshot.renderState?.outputs).toEqual(outputs);
    expect(f.read().renderState?.outputs).toEqual(outputs);
    f.assets.update(f.handle, { values: { amount: 0.5 } }).unwrap();
    expect(f.read().renderState?.outputs).toEqual(outputs);
  });

  it('retains a shared material through mesh-only changes and keeps captured values stable', () => {
    const f = fixture();
    const first = f.read();
    expect(first.immutableValues).toBe(true);
    expect(f.read()).toBe(first);
    f.assets
      .writeRange(f.mesh, { attribute: 'position', first: 0, values: Float32Array.of(1, 2, 3) })
      .unwrap();
    expect(f.read()).toBe(first);
    f.assets.update(f.handle, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    const green = f.read();
    expect(green).not.toBe(first);
    expect(Array.from(green.baseColor)).toEqual([0, 1, 0]);
    expect(Array.from(first.baseColor)).toEqual([1, 0, 0]);
  });

  it('ignores unrelated material edits and refuses a retired cache reference', () => {
    const f = fixture();
    const other = f.assets.copy(f.handle).unwrap();
    const first = f.read();
    f.assets.update(other, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    expect(f.read()).toBe(first);
    resolveMaterialSnapshot(other, worldRenderResources(f.world), f.assets, undefined, f.cache);
    runtimeAssets(f.assets).release(other).unwrap();
    expect(
      readPersistentMaterialSnapshot(f.cache, other, worldRenderResources(f.world)),
    ).toBeUndefined();
    expect(f.read()).toBe(first);
  });

  it('retains color mask and bias through primary/submesh extraction and managed pass edits', () => {
    const renderState = {
      tags: { LightMode: 'Forward' },
      colorWriteMask: 0,
      depthBias: -1,
      depthBiasSlopeScale: -2,
      depthBiasClamp: -0.01,
    };
    const f = fixture({
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' }, renderState }],
      values: {},
    });
    const first = f.extract();
    const prior = first.material.snapshot;
    expect(prior.renderState).toMatchObject({
      colorWriteMask: 0,
      depthBias: -1,
      depthBiasSlopeScale: -2,
      depthBiasClamp: -0.01,
    });
    expect(f.read().renderState).toEqual(prior.renderState);
    renderState.colorWriteMask = 5;
    renderState.depthBias = 2;
    expect(f.extract().material.snapshot).toBe(prior);
    const edited = f.assets.read(f.handle).unwrap();
    if (edited.passes === undefined) throw new Error('Expected the root material Passes');
    const [head, ...tail] = edited.passes;
    f.assets
      .update(f.handle, {
        passes: [{ ...head, renderState }, ...tail.map((pass) => ({ ...pass, renderState }))],
      })
      .unwrap();
    const second = f.extract();
    expect(second.material).toBe(first.material);
    expect(second.material.snapshot.renderState).toMatchObject({ colorWriteMask: 5, depthBias: 2 });
    expect(prior.renderState).toMatchObject({ colorWriteMask: 0, depthBias: -1 });
    expect(second.gpuDrivenDraws?.[0]?.pipelineClass).not.toBe(
      first.gpuDrivenDraws?.[0]?.pipelineClass,
    );
  });

  it('projects the same Surface model for primary and reusable submesh snapshots', () => {
    const f = fixture({
      kind: 'material',
      surface: { model: 'single-layer-medium', module: 'game::water-surface' },
      passes: [
        {
          name: 'color',
          program: { module: 'forgeax::single-layer-medium' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 3000 },
        },
      ],
      values: {},
    });
    expect(f.extract().material.snapshot.surfaceModel).toBe('single-layer-medium');
    expect(f.read().surfaceModel).toBe('single-layer-medium');
  });

  it('owns author values and only applies managed writes to the shared resource', () => {
    const values = { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 };
    const f = fixture({ ...Materials.standard({ baseColor: [1, 1, 1, 1] }), values });
    const resource = f.extract().material;
    const first = resource.snapshot;
    values.baseColor = [0, 1, 0, 1];
    expect(f.extract().material.snapshot).toBe(first);
    f.assets.update(f.handle, { values }).unwrap();
    const second = f.extract().material;
    expect(second).toBe(resource);
    expect(second.snapshot.baseColor).toEqual(Float32Array.of(0, 1, 0));
    expect(first.baseColor).toEqual(Float32Array.of(1, 0, 0));
  });

  it('updates subsurface demand from the asset owner while retaining old snapshots', () => {
    const f = fixture(
      Materials.standard({
        baseColor: [1, 0.4, 0.2, 1],
        subsurfaceRadius: [9, 6, 3],
        subsurfaceWeight: 1,
      }),
    );
    const active = f.extract().material.snapshot;
    expect(active.paramSnapshot?.subsurfaceRadius).toEqual([9, 6, 3]);
    expect(subsurfaceDemand(subsurfaceSelection([active]).demand)).toBe(true);
    f.assets.update(f.handle, { values: { subsurfaceRadius: [0, 0, 0] } }).unwrap();
    expect(subsurfaceDemand(subsurfaceSelection([f.extract().material.snapshot]).demand)).toBe(
      false,
    );
    f.assets
      .update(f.handle, { values: { subsurfaceRadius: [9, 6, 3], subsurfaceWeight: 0 } })
      .unwrap();
    const disabled = f.extract().material.snapshot;
    expect(disabled.paramSnapshot?.subsurfaceWeight).toBe(0);
    expect(subsurfaceDemand(subsurfaceSelection([disabled]).demand)).toBe(false);
    f.assets.update(f.handle, { values: { subsurfaceWeight: 1 } }).unwrap();
    expect(subsurfaceDemand(subsurfaceSelection([f.extract().material.snapshot]).demand)).toBe(
      true,
    );
    expect(active.paramSnapshot?.subsurfaceWeight).toBe(1);
  });

  it('keeps pipeline identity stable for a value-only update', () => {
    const f = fixture(Materials.standard({ baseColor: [1, 1, 1, 1] }));
    const first = f.extract();
    f.assets.update(f.handle, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    const second = f.extract();
    expect(second.gpuDrivenDraws?.[0]?.pipelineClass).toBe(
      first.gpuDrivenDraws?.[0]?.pipelineClass,
    );
    expect(first.material).toBe(second.material);
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
