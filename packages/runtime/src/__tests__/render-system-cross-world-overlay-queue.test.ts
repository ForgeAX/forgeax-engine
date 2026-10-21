import { World } from '@forgeax/engine-ecs';
import { createMeshBuilder } from '@forgeax/engine-geometry';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { extractFrames } from '../../../render/src/render-system-extract-tail';
import { testAssets } from './helpers/runtime-assets';

const QUEUE_OPAQUE = 2000;
const QUEUE_OVERLAY = 4000;

function makeRenderableWorld(queue: number): World {
  const world = new World();
  const assets = testAssets(world);
  const mesh = assets
    .create(
      createMeshBuilder({
        attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
        indices: [0, 1, 2],
      })
        .build()
        .unwrap(),
    )
    .unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: queue === QUEUE_OVERLAY ? 'Overlay' : 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { queue },
        },
      ],
      values: {},
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -2] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  return world;
}

describe('cross-world Overlay queue merge', () => {
  it('dispatches Overlay after opaque geometry even when its World is first', () => {
    const sceneWorld = makeRenderableWorld(QUEUE_OPAQUE);
    sceneWorld
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const editorWorld = makeRenderableWorld(QUEUE_OVERLAY);
    for (const world of [sceneWorld, editorWorld]) propagateTransforms(world).unwrap();

    const frame = extractFrames([editorWorld, sceneWorld], { cameraOwner: 1, resourceOwner: 1 });
    expect(frame.renderables).toHaveLength(2);
    const queues = frame.dispatch.map((entry) => entry.queue);
    const opaqueIndex = queues.indexOf(QUEUE_OPAQUE);
    const overlayIndex = queues.indexOf(QUEUE_OVERLAY);
    expect(opaqueIndex).toBeGreaterThanOrEqual(0);
    expect(overlayIndex).toBeGreaterThan(opaqueIndex);
  });
});
