import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../components';
import { Materials } from '../materials';
import * as projections from '../render-system-projections';
import * as views from '../view-inspection';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('selects status before source inventories while preserving an explicit full detached export', async () => {
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await host.initialization).ok).toBe(true);
  const renderer = exposeRenderer(host);
  const assets = host.assetRegistry;
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = assets.create(Materials.unlit([0.8, 0.5, 0.2, 1])).unwrap();
  for (let index = 0; index < 128; index++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        {
          component: Visibility,
          data: { state: index === 0 ? VisibilityStateValue.visible : VisibilityStateValue.hidden },
        },
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
  const lease = attached.value;
  const spies = [
    vi.spyOn(views, 'viewRenderScene'),
    vi.spyOn(views, 'viewInstanceCollections'),
    vi.spyOn(views, 'viewMeshMaterialBindings'),
    vi.spyOn(projections, 'createLodWorldInspections'),
  ] as const;
  try {
    let ready = false;
    for (let frame = 0; frame < 30 && !ready; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      assert(drawn.ok);
      const receipt = drawn.value;
      expect((await receipt.completed).ok).toBe(true);
      ready = receipt.presentation === 'ready';
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(ready).toBe(true);
    for (const spy of spies) spy.mockClear();
    const status = renderer.inspect({ fields: ['state', 'frame'] });
    expect(Object.keys(status).sort()).toEqual(['frame', 'state']);
    expect(status.state).toBe('alive');
    expect(status.frame.frameId).toBeGreaterThan(0);
    expect(renderer.inspect({ fields: [] })).toEqual({});
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const full = renderer.inspect();
    expect(full.renderScene.projectionRecords).toBe(128);
    expect(full.meshMaterialBindings).toHaveLength(1);
    expect(full.iblBinding).toBeUndefined();
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
    const owner = spies[0]?.mock.calls[0]?.[0];
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error('Missing actual view owner');
    const frustum = owner.recorded.frustum;
    const descriptor = Object.getOwnPropertyDescriptor(frustum, 'culled');
    expect(descriptor).toBeDefined();
    const culled = frustum.culled;
    const readCulled = vi.fn(() => culled);
    Object.defineProperty(frustum, 'culled', { configurable: true, get: readCulled });
    try {
      renderer.inspect({ fields: ['state', 'frame'] });
      expect(readCulled).not.toHaveBeenCalled();
      expect(renderer.inspect({ fields: ['frustumStats'] }).frustumStats.culled).toBe(culled);
      expect(readCulled).toHaveBeenCalledOnce();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(frustum, 'culled', descriptor);
    }
    const selected = renderer.inspect({ fields: ['meshMaterialBindings', 'frame'] });
    expect(Object.keys(selected).sort()).toEqual(['frame', 'meshMaterialBindings']);
    expect(selected.meshMaterialBindings).toEqual(full.meshMaterialBindings);
    expect(selected.meshMaterialBindings).not.toBe(full.meshMaterialBindings);
    expect(selected.frame.frameId).toBe(status.frame.frameId);
    lease.dispose();
    expect(full.meshMaterialBindings).toHaveLength(1);
  } finally {
    for (const spy of spies) spy.mockRestore();
    lease.dispose();
    await renderer.dispose();
  }
});
