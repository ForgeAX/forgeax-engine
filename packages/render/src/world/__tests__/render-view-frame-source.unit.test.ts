import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../components/camera';
import {
  RenderView,
  RenderViewFrameSource,
  RenderViewInput,
  RenderViews,
  viewCameraOf,
} from '../render-views';
import { beginRenderFrame, createRenderWorld, endRenderFrame } from '../render-world';

describe('RenderViewFrameSource', () => {
  it('gives a frame without composed views one primary display view', () => {
    const source = new World();
    const camera = source
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { aspect: 4, near: 0.1, far: 100, fov: 1 } },
      )
      .unwrap();
    propagateTransforms(source).unwrap();
    const renderWorld = createRenderWorld();
    const views = new RenderViews(renderWorld);
    const frameSource = new RenderViewFrameSource({ canvas: { width: 80, height: 40 } });
    renderWorld.insertResource(RenderViewInput, frameSource);
    frameSource.stage([], [], [source], { cameraOwner: 0, resourceOwner: 0 }, undefined, undefined);
    beginRenderFrame(renderWorld, 1);
    const primary = views.primary;
    expect(views.size).toBe(0);
    expect(renderWorld.get(primary as never, RenderView).unwrap()).toMatchObject({
      primary: true,
      capture: false,
      camera: Number(camera),
      attachment: source.identity,
    });
    expect(viewCameraOf(renderWorld, primary)).toMatchObject({
      extent: { width: 80, height: 40 },
      camera: { entityKey: Number(camera) },
    });
    endRenderFrame(renderWorld);
    frameSource.clear();
    expect(frameSource.attachment({ entityKey: 1 } as never)).toBeUndefined();
  });
});
