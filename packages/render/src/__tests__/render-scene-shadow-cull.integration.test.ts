import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4 } from '@forgeax/engine-math';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';
import * as shadowVisibility from '../scene/shadow-visibility';

it('constructs shadow frusta only for off-camera CPU casters and preserves their depth dispatch', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const handle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: ['Forward', 'ShadowCaster'].map((mode) => ({
      name: mode,
      program: { module: 'test::shadow-cull' },
      renderState: { tags: { LightMode: mode }, queue: 2000 },
    })),
    values: {},
  });
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 20] } },
      { component: Camera, data: { fov: Math.PI / 3, near: 0.1, far: 200, aspect: 1 } },
    )
    .unwrap();
  const caster = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  const lightMatrix = mat4.identity(mat4.create());
  lightMatrix[0] = 0.01;
  lightMatrix[5] = 0.01;
  lightMatrix[10] = 0.01;
  const build = vi.spyOn(shadowVisibility, 'buildShadowFrusta');
  const draw = () => {
    world.update(1 / 60).unwrap();
    return scene.extractComposition(
      [world],
      owner,
      0,
      (request) => {
        const frame = extractFrames(
          [world],
          owner,
          assets,
          undefined,
          scene.materialSnapshotCacheStore(),
          { cull: 'none', retainHidden: true, renderables: request },
        );
        return {
          ...frame,
          lights: { ...frame.lights, lightViewProj: [lightMatrix], cascadeCount: 1 },
        };
      },
      [lease],
    );
  };
  try {
    expect(draw().renderables).toHaveLength(1);
    expect(build).not.toHaveBeenCalled();
    world.set(caster, Transform, { pos: [30, 0, 0] }).unwrap();
    const offCamera = draw();
    expect(scene.shadowCasterProjection()?.renderables[0]?.transform.world[12]).toBe(30);
    expect(offCamera.frustumStats).toEqual({ culled: 1, total: 1 });
    expect(build).toHaveBeenCalledTimes(1);
    expect(offCamera.renderables).toHaveLength(1);
    expect(offCamera.dispatch.map((entry) => entry.tags.LightMode)).toEqual(['ShadowCaster']);
    // A moved light must be read for the next off-camera decision.
    lightMatrix[12] = -5;
    expect(draw().renderables).toHaveLength(0);
    expect(build).toHaveBeenCalledTimes(2);
    world.set(camera, Transform, { pos: [30, 0, 20] }).unwrap();
    expect(draw().dispatch.map((entry) => entry.tags.LightMode)).toEqual([
      'Forward',
      'ShadowCaster',
    ]);
    expect(build).toHaveBeenCalledTimes(2);
  } finally {
    build.mockRestore();
    scene.dispose();
    lease.dispose();
  }
});
