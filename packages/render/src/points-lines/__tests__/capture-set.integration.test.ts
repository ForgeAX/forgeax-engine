import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, Points } from '../../components';
import { extractFrames } from '../../render-system-extract-tail';
import { PersistentRenderScene } from '../../scene/render-scene';
import { StandardPointsLinesOwner } from '../standard-owner';

it('prepares a Points row the main camera culled, which a capture pass still draws', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'test::capture-set' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: {},
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 20] } },
      { component: Camera, data: { fov: Math.PI / 3, near: 0.1, far: 200, aspect: 1 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [500, 0, 0] } },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createPrimitiveMesh('cube').unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: Points, data: {} },
    )
    .unwrap();
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene();
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  try {
    world.update(1 / 60).unwrap();
    const culled = scene.extractComposition(
      [world],
      owner,
      assets,
      (request) =>
        extractFrames([world], owner, assets, scene.materialSnapshotCacheStore(), {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        }),
      [lease],
    );
    // The main camera's cull dropped the row from its own frame ...
    expect(culled.renderables).toHaveLength(0);
    // ... but the retained set a capture pass admits still carries it.
    const retained = scene.shadowCasterProjection()?.renderables;
    expect(retained?.at(0)?.pointsLines).toBeDefined();
    const points = new StandardPointsLinesOwner({} as never);
    const prepare = vi.spyOn(points, 'prepare').mockReturnValue(undefined);
    const scopeOf = () => ({ assetRevision: () => 1 }) as never;
    points.prepareFrame(culled.renderables, scopeOf, true);
    expect(prepare).not.toHaveBeenCalled();
    points.prepareFrame(retained as never, scopeOf, true);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    scene.dispose();
    lease.dispose();
  }
});
