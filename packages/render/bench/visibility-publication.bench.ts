import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { bench, describe } from 'vitest';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../src/components';
import { extractFrames } from '../src/render-system-extract-tail';
import { type PersistentRenderCandidateRequest, PersistentRenderScene } from '../src/scene/render-scene';

// Actual ECS -> retained-render projection, without GPU recording or FPS claims.
describe('2000 descendant draws / unchanged parent Visibility', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const parent = world.spawn(
    { component: Transform, data: {} },
    { component: Visibility, data: { state: VisibilityStateValue.visible } },
  ).unwrap();
  for (let entity = 0; entity < 2000; entity++) {
    world.spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [] } },
    ).unwrap();
  }
  propagateTransforms(world).unwrap();
  const lease = createRenderReadLease(world);
  const persistent = new PersistentRenderScene();
  const worlds = [world];
  const owners = { cameraOwner: 0, resourceOwner: 0 };
  const build = (request: PersistentRenderCandidateRequest) => extractFrames(
    worlds, owners, assets, undefined, persistent.materialSnapshotCacheStore(), { cull: 'none', renderables: request },
  );
  const draw = () => persistent.extractComposition(worlds, owners, assets, build, [lease]);
  draw();
  bench('same visibility preserves material and mesh projection', () => {
    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    draw();
  }, { time: 1000, warmupTime: 200, iterations: 20 });
});
