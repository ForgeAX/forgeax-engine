import { DirectionalLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

interface RasterSample {
  readonly passCount: number;
  readonly views: number;
  readonly hits: number;
  readonly staticLayers: number;
  readonly reasons: readonly string[];
}

export default defineFeature({
  title: 'Shadow cache layers',
  catalog: 'Incremental shadow cache',
  kind: 'probe',
  summary:
    'Shadow views are cached per frame: a settled static scene re-rasters nothing, each view keeps a layer: static companion, and moving one caster invalidates only the views that contain it with a closed invalidation reason.',
  expect:
    'Checks: settled scene has passCount 0 with every view a hit and static-layer companions present; after one cube moves, at least one view misses with a named reason.',
  async setup({ world, app, frames }) {
    const { sun } = spawnStage(world, { eye: [0, 4, 7], target: [0, 0, 0] });
    world.set(sun, DirectionalLight, { cascadeCount: 2 } as never);
    const mat = standard(world, { baseColor: [0.9, 0.4, 0.1, 1] });
    const cubes = [-2, 0, 2].map((x) =>
      spawnMesh(world, MESH.cube, mat, { pos: [x, 0.5, 0], scale: [0.8, 1, 0.8] }),
    );
    const sample = (): RasterSample => {
      const raster = app.renderer.inspect().shadowRaster;
      return {
        passCount: raster.passCount,
        views: raster.views.length,
        hits: raster.views.filter((view) => view.cache === 'hit').length,
        staticLayers: raster.views.filter((view) => view.identity.layer === 'static').length,
        reasons: [
          ...new Set(
            raster.views.flatMap((view) =>
              view.invalidationReason === undefined ? [] : [view.invalidationReason],
            ),
          ),
        ],
      };
    };
    await frames(150);
    const settled = sample();
    const moved = cubes[1];
    if (moved !== undefined) world.set(moved, Transform, { pos: [0, 0.5, 1.5] } as never);
    await frames(1);
    const afterMove = sample();
    return {
      checks(): FeatureCheck[] {
        return [
          {
            name: 'shadow views published',
            ok: settled.views > 0,
            detail: JSON.stringify(settled),
          },
          {
            name: 'settled scene re-rasters nothing',
            ok: settled.passCount === 0,
            detail: JSON.stringify(settled),
          },
          {
            name: 'settled views all hit',
            ok: settled.views > 0 && settled.hits === settled.views,
          },
          {
            name: 'static layer companions exist',
            ok: settled.staticLayers > 0,
            detail: `staticLayers=${settled.staticLayers}`,
          },
          {
            name: 'moving a caster re-rasters',
            ok: afterMove.passCount > 0,
            detail: JSON.stringify(afterMove),
          },
          {
            name: 'miss carries an invalidation reason',
            ok: afterMove.reasons.length > 0,
            detail: afterMove.reasons.join(','),
          },
        ];
      },
    };
  },
});
