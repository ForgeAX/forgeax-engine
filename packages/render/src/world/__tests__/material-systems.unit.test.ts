import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { extractFrames } from '../../render-system-extract-tail';
import { SceneComposition } from '../../scene/scene-composition';
import {
  RENDER_BATCH_PLAN_SYSTEM,
  RENDER_MATERIAL_ADOPT_SYSTEM,
  RENDER_MATERIAL_PASSES_SYSTEM,
  registerMaterialSystems,
} from '../material-systems';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderPrepare,
} from '../render-world';
import {
  RENDER_SCENE_PUBLISH_SYSTEM,
  type RenderSceneAdoption,
  RenderSceneDelta,
  registerSceneSystem,
} from '../scene-systems';

const material: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'forgeax::default-standard-pbr' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    },
  ],
  values: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 },
};

function fixture(disabled?: string) {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const handle = assets.create(material).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  const composition = new SceneComposition({ assets });
  const renderWorld = createRenderWorld();
  const source = registerSceneSystem(renderWorld, composition, assets);
  registerMaterialSystems(renderWorld);
  if (disabled !== undefined) renderWorld.removeSystem(RenderPrepare, disabled).unwrap();
  const lease = createRenderReadLease(world);
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  let frame = 0;
  const step = (): RenderSceneAdoption => {
    world.update(1 / 60).unwrap();
    Object.assign(source, {
      staged: true,
      worlds: [world],
      owner,
      leases: [lease],
      buildCandidateFrame: (
        request: Parameters<NonNullable<typeof source.buildCandidateFrame>>[0],
      ) =>
        extractFrames([world], owner, assets, composition.materialSnapshotCacheStore(), {
          cull: 'none',
          retainHidden: true,
          renderables: request,
        }),
    });
    beginRenderFrame(renderWorld, ++frame);
    endRenderFrame(renderWorld);
    const adoption = renderWorld.getResource<RenderSceneAdoption>(RenderSceneDelta);
    if (adoption.failure !== undefined) throw adoption.failure;
    return { ...adoption };
  };
  return { renderWorld, composition, step, dispose: () => composition.dispose() };
}

function entryOf(adoption: RenderSceneAdoption) {
  const entry = adoption.advance?.entry;
  if (entry === undefined) throw new Error('The frame adopted no scene');
  return entry;
}

describe('material RenderPrepare systems', () => {
  it('schedule material adoption, the Pass query and the batch plan before the scene publish', () => {
    const f = fixture();
    try {
      const prepare = f.renderWorld
        .scheduleData()
        .find((schedule) => schedule.name === 'RenderPrepare');
      expect(prepare?.systems.map((system) => system.name)).toEqual(
        expect.arrayContaining([
          RENDER_MATERIAL_ADOPT_SYSTEM,
          RENDER_MATERIAL_PASSES_SYSTEM,
          RENDER_BATCH_PLAN_SYSTEM,
          RENDER_SCENE_PUBLISH_SYSTEM,
        ]),
      );
      for (const edge of [
        [RENDER_MATERIAL_ADOPT_SYSTEM, RENDER_MATERIAL_PASSES_SYSTEM],
        [RENDER_MATERIAL_ADOPT_SYSTEM, RENDER_BATCH_PLAN_SYSTEM],
        [RENDER_MATERIAL_PASSES_SYSTEM, RENDER_SCENE_PUBLISH_SYSTEM],
        [RENDER_BATCH_PLAN_SYSTEM, RENDER_SCENE_PUBLISH_SYSTEM],
      ])
        expect(prepare?.dependencies).toContainEqual(edge);
    } finally {
      f.dispose();
    }
  });

  it('publish the frame Pass query, batch plan and accepted observation', () => {
    const f = fixture();
    try {
      const first = f.step();
      const entry = entryOf(first);
      expect(f.composition.materialPasses(entry).length).toBe(1);
      expect(f.composition.batchPlan(entry).candidateCount).toBe(1);
      // The accepted observation leaves a still frame with the same advance.
      expect(f.step().advance).toBe(first.advance);
    } finally {
      f.dispose();
    }
  });

  it('fail the frame Pass query when render-material-adopt is removed', () => {
    const f = fixture(RENDER_MATERIAL_ADOPT_SYSTEM);
    try {
      // Unadopted rows leave the dispatch on no Mesh frame: the step fails, unaccepted.
      expect(() => f.step()).toThrow(/current adopted MeshFrame/);
    } finally {
      f.dispose();
    }
  });

  it('publish no Pass query when render-material-passes is removed', () => {
    const f = fixture(RENDER_MATERIAL_PASSES_SYSTEM);
    try {
      const entry = entryOf(f.step());
      expect(() => f.composition.materialPasses(entry)).toThrow(/composition step that queried/);
    } finally {
      f.dispose();
    }
  });

  it('publish no batch plan when render-batch-plan is removed', () => {
    const f = fixture(RENDER_BATCH_PLAN_SYSTEM);
    try {
      const entry = entryOf(f.step());
      expect(() => f.composition.batchPlan(entry)).toThrow(/composition step that planned/);
    } finally {
      f.dispose();
    }
  });

  it('re-observe the same sources when render-scene-publish is removed', () => {
    const f = fixture(RENDER_SCENE_PUBLISH_SYSTEM);
    try {
      const first = f.step();
      expect(f.step().advance).not.toBe(first.advance);
    } finally {
      f.dispose();
    }
  });
});
