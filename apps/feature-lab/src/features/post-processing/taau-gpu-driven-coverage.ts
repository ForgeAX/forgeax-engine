import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPlaneGeometry } from '@forgeax/engine/geometry';
import { ANTIALIAS_TAA, DynamicResolution, Materials } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage } from '../../lab/stage';

export default defineFeature({
  title: 'TAAU coverage for GPU-driven meshes',
  catalog: 'TAAU GPU-driven coverage',
  kind: 'probe',
  summary:
    'With TAAU active, GPU-claimed (LOD) meshes write the output-extent temporal coverage through the same culled indirect rows as their color draws, instead of a direct fallback.',
  expect:
    'All checks pass: the standard-scene-coverage pass is scheduled, dynamic resolution is fixed at 0.5, the main view runs the GPU-driven cull/indirect passes with a resident GPU Scene and no output error is reported.',
  setup({ app, world, frames }) {
    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const assets = app.assets;
    const { camera } = spawnStage(world, {
      eye: [0, 3, 6],
      target: [0, 0, 0],
      data: { antialias: ANTIALIAS_TAA },
    });
    world
      .addComponent(camera, {
        component: DynamicResolution,
        data: { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 },
      })
      .unwrap();
    if (assets !== undefined) {
      const plane = createPlaneGeometry(1, 1, 1, 1).unwrap();
      const lower = assets.create(plane).unwrap();
      const mesh = sceneAssets
        .create({
          ...plane,
          lods: [{ mesh: lower, screenCoverage: 0.01 }],
          lodHysteresis: 0,
        })
        .unwrap();
      const mat = sceneAssets
        .create(
          Materials.standard({ baseColor: [0.9, 0.5, 0.2, 1], renderState: { cullMode: 'none' } }),
        )
        .unwrap();
      for (let x = 0; x < 6; x++) {
        for (let z = 0; z < 6; z++)
          spawnMesh(world, mesh as never, mat, {
            pos: [-2.5 + x, 0.6, -2.5 + z],
            scale: [0.7, 0.7, 0.7],
          });
      }
    }
    return {
      async checks() {
        await frames(6);
        const inspection = app.renderer.inspect();
        return new CheckList()
          .ok('app.assets registry present', assets !== undefined)
          .ok(
            'standard-scene-coverage scheduled',
            inspection.perFramePassNames.includes('standard-scene-coverage'),
            inspection.perFramePassNames.join(','),
          )
          .equal('dynamic resolution status', inspection.dynamicResolution?.status, 'fixed')
          .ok(
            'main view culls and draws through GPU-driven indirect rows',
            ['gpu-driven.frustum-compact', 'gpu-driven.finalize-indirect'].every((name) =>
              inspection.perFramePassNames.includes(name),
            ),
            inspection.perFramePassNames.filter((name) => name.startsWith('gpu-driven.')).join(','),
          )
          .equal('GPU Scene resident', inspection.renderScene.gpu.status, 'resident')
          .ok(
            'no output error',
            inspection.output.error === undefined,
            JSON.stringify(inspection.output.error),
          ).items;
      },
    };
  },
});
