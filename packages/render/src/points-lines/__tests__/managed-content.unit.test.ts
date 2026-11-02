import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  createWireframeGeometry,
} from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { Materials } from '../../materials';
import { worldRenderResources } from '../../publication/resource-scope';
import type { ValidatedRenderable } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import { RenderView } from '../../world/render-views';
import { createRenderWorld } from '../../world/render-world';
import { adoptViewPointsLines } from '../../world/view-points-lines';
import { createPointsLinesSnapshot } from '../snapshot';

it('consumes edits at draw time without replacing the source row, and fences resized geometry', async () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  const created = vi.spyOn(device, 'createBuffer');
  const geometry = createWireframeGeometry(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = assets.create(geometry).unwrap();
  const material = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  const renderWorld = createRenderWorld();
  const view = renderWorld.spawn({ component: RenderView, data: { primary: true } }).unwrap();
  const owner = adoptViewPointsLines(renderWorld, view, { device } as RenderSystemInternals);
  const source = createPointsLinesSnapshot({
    worldId: 0,
    entityKey: 1,
    component: 'Lines',
    meshHandle: mesh,
    materialHandle: material,
    style: { kind: 'lines', width: 2 },
    layer: 0,
    visible: true,
    sourceBounds: geometry.aabb ?? [],
    viewport: { width: 32, height: 32, dpr: 1 },
    projection: new Float32Array(16),
  });
  const entry = {
    source: { assetHandle: mesh, pointsLines: source },
    world: worldRenderResources(world),
  } as unknown as ValidatedRenderable;
  try {
    const first = owner.prepare(entry, false);
    expect(first).toBeDefined();
    const original = first?.vertexBuffer;
    owner.commit(undefined);
    const meshRevision = owner.inspections()[0]?.meshGeneration;
    assets.update(material, { values: { baseColor: [1, 0, 0, 1] } }).unwrap();
    expect(owner.prepare(entry, false)?.vertexBuffer).toBe(original);
    owner.commit(undefined);
    expect(owner.inspections()[0]?.meshGeneration).toBe(meshRevision);
    const allocations = created.mock.calls.length;
    for (let i = 0; i < 260; i++) {
      assets.replace(mesh, geometry).unwrap();
      // Same-sized generations (per-frame JS writes) rewrite the resident pair.
      expect(owner.prepare(entry, false)?.vertexBuffer).toBe(original);
    }
    expect(created.mock.calls.length).toBe(allocations);
    owner.commit(undefined);
    expect(owner.inspections()[0]?.meshGeneration).not.toBe(meshRevision);
    expect(entry.source.pointsLines).toBe(source);
    expect(source).not.toHaveProperty('meshGeneration');
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    owner.commit(done);
    // A resized source allocates a new pair; the old one retires behind its fence.
    const resized = createWireframeGeometry(createPlaneGeometry(1, 1).unwrap()).unwrap();
    assets.replace(mesh, resized).unwrap();
    expect(owner.prepare(entry, false)?.vertexBuffer).not.toBe(original);
    expect(destroyed.mock.calls.some(([buffer]) => buffer === original)).toBe(false);
    complete();
    await done;
    await Promise.resolve();
    expect(destroyed.mock.calls.some(([buffer]) => buffer === original)).toBe(true);
  } finally {
    owner.dispose();
    assets.dispose();
  }
});
