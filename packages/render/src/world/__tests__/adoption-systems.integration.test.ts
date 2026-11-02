import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';
import { testAssets } from '../../__tests__/helpers/runtime-assets';
import { Instances, MeshFilter, MeshRenderer } from '../../components';
import { InstanceProjectionStore } from '../../instances';
import { extractFrames } from '../../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../../scene/render-scene';
import { SceneComposition } from '../../scene/scene-composition';
import { registerMaterialSystems } from '../material-systems';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
} from '../render-world';
import {
  INSTANCE_COLLECTIONS_SYSTEM,
  type RenderSceneAdoption,
  RenderSceneDelta,
  registerSceneSystem,
  SKIN_INPUTS_SYSTEM,
} from '../scene-systems';

const owner = { cameraOwner: 0, resourceOwner: 0 } as const;

function fixture(kind: 'skin' | 'instances') {
  const world = new World({ assets: new AssetRegistry() });
  registerPropagateTransforms(world);
  const assets = testAssets(world);
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  if (kind === 'skin') {
    const identity = new Float32Array(16);
    identity[0] = identity[5] = identity[10] = identity[15] = 1;
    const skeleton = assets
      .create({ kind: 'skeleton', inverseBindMatrices: identity, jointCount: 1 })
      .unwrap();
    const joint = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component: Skin, data: { skeleton, joints: new Uint32Array([joint as number]) } },
      )
      .unwrap();
  } else {
    const transforms = new Float32Array(32);
    for (const row of [0, 1]) {
      transforms[row * 16] = transforms[row * 16 + 5] = 1;
      transforms[row * 16 + 10] = transforms[row * 16 + 15] = 1;
    }
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component: Instances, data: { transforms } },
      )
      .unwrap();
  }
  world.update(0).unwrap();
  const collections = new InstanceProjectionStore();
  const composition = new SceneComposition({ instanceCollections: collections });
  const scene = new PersistentRenderScene({ instanceCollections: collections }, composition);
  const renderWorld = createRenderWorld();
  const source = registerSceneSystem(renderWorld, composition, assets);
  registerMaterialSystems(renderWorld);
  const lease = createRenderReadLease(world);
  const build = (request: PersistentRenderCandidateRequest) =>
    extractFrames([world], owner, assets, scene.materialSnapshotCacheStore(), {
      cull: 'none',
      retainHidden: true,
      renderables: request,
      instanceCollections: collections,
    });
  let frame = 0;
  return {
    renderWorld,
    collections,
    scene,
    run() {
      source.staged = true;
      source.worlds = [world];
      source.owner = owner;
      source.leases = [lease];
      source.buildCandidateFrame = build;
      beginRenderFrame(renderWorld, ++frame);
      scene.followAdoption(
        renderWorld.getResource<RenderSceneAdoption>(RenderSceneDelta),
        build,
        world,
      );
      endRenderFrame(renderWorld);
    },
    dispose() {
      lease.dispose();
      scene.dispose();
      collections.dispose();
    },
  };
}

function extractSystems(world: ReturnType<typeof createRenderWorld>): string[] {
  return (
    world.scheduleData().find((schedule) => schedule.name === 'RenderExtract')?.systems ?? []
  ).map((system) => system.name);
}

describe('skin-inputs system', () => {
  it('is scheduled and produces the shared Skin pose', () => {
    const f = fixture('skin');
    try {
      expect(extractSystems(f.renderWorld)).toContain(SKIN_INPUTS_SYSTEM);
      f.run();
      expect(f.scene.skinRecordingFrame()).toBeDefined();
    } finally {
      f.dispose();
    }
  });

  it('leaves the scene without Skin inputs once removed', () => {
    const f = fixture('skin');
    try {
      f.renderWorld.removeSystem(RenderExtract, SKIN_INPUTS_SYSTEM).unwrap();
      f.run();
      expect(f.scene.skinRecordingFrame()).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});

describe('instance-collections system', () => {
  it('is scheduled and accepts the Instances collection', () => {
    const f = fixture('instances');
    try {
      expect(extractSystems(f.renderWorld)).toContain(INSTANCE_COLLECTIONS_SYSTEM);
      f.run();
      expect(f.collections._inspections(0)).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it('accepts no collection once removed', () => {
    const f = fixture('instances');
    try {
      f.renderWorld.removeSystem(RenderExtract, INSTANCE_COLLECTIONS_SYSTEM).unwrap();
      f.run();
      expect(f.collections._inspections(0)).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
});
