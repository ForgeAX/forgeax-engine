import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  ChildOf,
  GlobalTransform,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { Fog } from '../components/fog';
import { GpuMeshVertexSource } from '../components/gpu-mesh-vertex-source';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { prepareExtractContext } from '../render-system-extract';
import { extractFrame, extractSource } from '../render-system-extract-tail';

function transform(pos: [number, number, number]) {
  return {
    pos,
    quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function makeWorld() {
  const world = new World();
  registerPropagateTransforms(world);
  const parent = world
    .spawn(
      { component: Transform, data: transform([1, 0, 0]) },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: transform([2, 0, 0]) },
      { component: ChildOf, data: { parent } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  return { world, parent, child };
}

describe('visibility extract orchestration', () => {
  it('keeps ordinary meshes out of the optional GPU producer read while publishing an authored producer', () => {
    const assets = new AssetRegistry();
    const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const world = new World({ assets });
    const ordinary = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    const produced = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component: GpuMeshVertexSource, data: { feature: 'ocean', resource: 'vertices' } },
      )
      .unwrap();
    const reads = vi.spyOn(world, 'get');
    const frame = extractSource(world);
    expect(
      frame.renderables.find((row) => row.entityKey === ordinary)?.gpuVertexSource,
    ).toBeUndefined();
    expect(frame.renderables.find((row) => row.entityKey === produced)?.gpuVertexSource).toEqual({
      feature: 'ocean',
      resource: 'vertices',
    });
    expect(
      reads.mock.calls
        .filter(([, component]) => component === GpuMeshVertexSource)
        .map(([entity]) => entity),
    ).toEqual([produced]);
  });

  it('keeps a partially assembled row independent of a nested source extraction', () => {
    const assets = new AssetRegistry();
    const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const world = new World({ assets });
    const components = [
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
    ] as const;
    const inner = world.spawn(...components).unwrap();
    const outer = world
      .spawn(...components, {
        component: GpuMeshVertexSource,
        data: { feature: 'water', resource: 'surface' },
      })
      .unwrap();
    const get = world.get.bind(world);
    const hook = vi.spyOn(world, 'get').mockImplementation((entity, component) => {
      if (component === GpuMeshVertexSource) {
        const nested = extractSource(world, assets, undefined, {
          renderables: { kind: 'partial', entities: new Set([inner]) },
        });
        expect(nested.renderables.map((row) => row.entityKey)).toEqual([inner]);
      }
      return get(entity, component);
    });
    try {
      const frame = extractSource(world, assets, undefined, {
        renderables: { kind: 'partial', entities: new Set([outer]) },
      });
      expect(frame.renderables).toHaveLength(1);
      expect(frame.renderables[0]).toMatchObject({
        entityKey: outer,
        gpuVertexSource: { feature: 'water', resource: 'surface' },
      });
      expect(frame.dispatch.length).toBeGreaterThan(0);
      expect(frame.dispatch.every((entry) => entry.entityIndex === outer)).toBe(true);
    } finally {
      hook.mockRestore();
    }
  });

  it('selects Fog once from the source and never queries an unrelated World', () => {
    const cameraWorld = new World();
    const resourceWorld = new World();
    resourceWorld
      .spawn({
        component: Fog,
        data: { color: [0.1, 0.2, 0.3], density: 0.02, heightFalloff: 0.4, maxOpacity: 0.8 },
      })
      .unwrap();

    const cameraQuery = vi.spyOn(cameraWorld, 'query');
    const resourceQuery = vi.spyOn(resourceWorld, 'query');
    extractSource(resourceWorld);

    const readsFog = (calls: readonly unknown[][]) =>
      calls.filter(([spec]) => {
        if (typeof spec !== 'object' || spec === null || !('read' in spec)) return false;
        const read = (spec as { readonly read?: readonly unknown[] }).read;
        return read?.includes(Fog) ?? false;
      });

    expect(readsFog(cameraQuery.mock.calls)).toHaveLength(0);
    expect(readsFog(resourceQuery.mock.calls)).toHaveLength(1);
  });

  it('refreshes hierarchy and visibility from the final World state', () => {
    const { world, parent, child } = makeWorld();
    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    world.update(0).unwrap();

    const frame = extractSource(world);
    const snapshot = frame.visibilitySnapshot;
    expect(snapshot?.get(parent)?.effective).toBe('visible');
    expect(snapshot?.get(child)?.effective).toBe('visible');
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(3);
  });

  it('keeps renderer extraction read-only over derived GlobalTransform.world', () => {
    const { world, parent, child } = makeWorld();
    world.update(0).unwrap();
    const before = [...world.get(child, GlobalTransform).unwrap().world];
    const beforeInspection = world.inspect();
    const beforeShape = {
      entityCount: beforeInspection.entityCount,
      archetypeCount: beforeInspection.archetypeCount,
      tableCount: beforeInspection.tableCount,
      activeComponents: beforeInspection.activeComponents,
      systemCount: beforeInspection.systemCount,
      resourceKeys: beforeInspection.resourceKeys,
    };

    world.set(parent, Transform, { pos: [9, 0, 0] }).unwrap();
    extractSource(world);

    expect([...world.get(child, GlobalTransform).unwrap().world]).toEqual(before);
    const afterInspection = world.inspect();
    expect({
      entityCount: afterInspection.entityCount,
      archetypeCount: afterInspection.archetypeCount,
      tableCount: afterInspection.tableCount,
      activeComponents: afterInspection.activeComponents,
      systemCount: afterInspection.systemCount,
      resourceKeys: afterInspection.resourceKeys,
    }).toEqual(beforeShape);
    world.update(0).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(11);
  });

  it('keeps direct prepared-kernel output aligned with extractSource output', () => {
    const { world, child } = makeWorld();
    const merged = extractSource(world);
    const prepared = prepareExtractContext(world);
    const direct = extractFrame(world, prepared);

    expect(direct.cameras).toEqual(merged.cameras);
    expect(direct.dispatch).toEqual(merged.dispatch);
    expect(prepared.visibility.get(child)?.effective).toBe('visible');
  });

  it('does not reuse a prior visibility result across repeated extracts', () => {
    const { world, parent } = makeWorld();
    const first = extractSource(world);
    expect(first.visibilitySnapshot?.get(parent)?.effective).toBe('hidden');

    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const second = extractSource(world);
    expect(second.visibilitySnapshot?.get(parent)?.effective).toBe('visible');
  });
});
