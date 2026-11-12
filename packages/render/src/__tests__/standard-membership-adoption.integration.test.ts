import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { StandardClusterMembershipOwner } from '../pipeline/standard-lighting/membership-owner';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it.each([
  'stock',
  'custom',
  'borrowed-grid',
  'frozen-borrowed-grid',
])('retains membership only for the admitted stock pipeline and grid, %s', async (mode) => {
  const derive = vi.spyOn(StandardClusterMembershipOwner.prototype, 'derive');
  const clear = vi.spyOn(StandardClusterMembershipOwner.prototype, 'clear');
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, ...(mode === 'custom' ? { pipeline: { ...standardPipeline } } : {}) },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await host.initialization).ok).toBe(true);
  if (mode === 'borrowed-grid' || mode === 'frozen-borrowed-grid') {
    const grid = { x: 16, y: 9, z: 24 };
    host.configureStandard({
      clusterGrid: mode === 'frozen-borrowed-grid' ? Object.freeze(grid) : grid,
    });
  }
  const renderer = exposeRenderer(host);
  const assets = host.assetRegistry;
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = assets.create(Materials.unlit([0.2, 0.4, 0.8, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8] } },
      {
        component: Camera,
        data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100, antialias: 0, bloom: 0 },
      },
    )
    .unwrap();
  const attached = renderer.attach(world);
  assert(attached.ok);
  try {
    let ready = 0;
    for (let frame = 0; frame < 30 && ready < 3; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      assert(drawn.ok);
      expect((await drawn.value.completed).ok).toBe(true);
      if (drawn.value.presentation === 'ready') ready++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(ready).toBe(3);
    if (mode !== 'stock') expect(derive).not.toHaveBeenCalled();
    else {
      const results = derive.mock.results
        .map((result) => result.value)
        .filter((result) => result?.ok);
      expect(results.length).toBeGreaterThanOrEqual(3);
      const first = results[0].value;
      for (const result of results) expect(result.value.clusterGrid).toBe(first.clusterGrid);
    }
  } finally {
    attached.value.dispose();
    await renderer.dispose();
    expect(clear).toHaveBeenCalled();
    derive.mockRestore();
    clear.mockRestore();
  }
});
