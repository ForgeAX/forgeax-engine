import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { extractFrames } from '../../../render/src/render-system-extract-tail';
import { pick } from '../pick';

const VIEWPORT = 600;

function transform(pos: [number, number, number]) {
  return {
    pos,
    quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function spawnCamera(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: transform([0, 0, 5]) },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_PERSPECTIVE,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
}

describe('visibility picking boundary', () => {
  it('keeps pick results unchanged when the render candidate is hidden', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const camera = spawnCamera(world);
    const entity = world
      .spawn(
        { component: Transform, data: transform([0, 0, 0]) },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component: Visibility, data: { state: VisibilityStateValue.visible } },
      )
      .unwrap();

    propagateTransforms(world);
    const before = pick(world, camera, VIEWPORT / 2, VIEWPORT / 2, VIEWPORT, VIEWPORT);

    world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    extractFrames([world], 0);
    propagateTransforms(world);
    const after = pick(world, camera, VIEWPORT / 2, VIEWPORT / 2, VIEWPORT, VIEWPORT);

    expect(before?.entity).toBe(entity);
    expect(after?.entity).toBe(entity);
    expect(after?.distance).toBeCloseTo(before?.distance ?? -1);
  });
});
