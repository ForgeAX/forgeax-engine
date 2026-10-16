import { DEFAULT_STANDARD_PROFILE, Materials, ProjectedDecal } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature, type FeatureDefinition } from '../../lab/feature';
import { MESH, material, spawnMesh, spawnStage, standard } from '../../lab/stage';

const feature: FeatureDefinition = defineFeature({
  title: 'Projected decals (DBuffer)',
  catalog: 'Projected decals',
  kind: 'visual',
  summary:
    'ProjectedDecal projects a Standard material box onto visible Deferred depth before lighting; color, normal and roughness go through graph-owned DBuffer targets. Deferred only; no receiver mesh scan.',
  expect:
    'ON: a red box-projected stain lies across the floor and wraps over the cube edge. OFF: opacity 0 removes the decal pass and the floor and cube are clean grey.',
  appOptions: { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' } },
  setup({ app, world, frames }) {
    spawnStage(world, { eye: [0, 3.5, 4.5], target: [0, 0, 0] });
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.7, 0.7, 0.72, 1] }), {
      pos: [0.6, 0.4, 0],
      scale: [0.8, 0.8, 0.8],
    });
    const paint = material(
      world,
      Materials.standard({ baseColor: [0.9, 0.05, 0.02, 1], roughness: 0.3 }),
    );
    const decal = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0.3, 0],
            quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            scale: [2.6, 1.8, 1.2],
          },
        },
        { component: ProjectedDecal, data: { material: paint } as never },
      )
      .unwrap();
    return {
      toggle(on) {
        world.set(decal, ProjectedDecal, { opacity: on ? 1 : 0 } as never);
      },
      async checks() {
        const checks = new CheckList();
        await frames(2);
        const inspection = app.renderer.inspect();
        checks.equal('render path is deferred', inspection.profile.renderPath, 'deferred');
        const decalPasses = inspection.perFramePassNames.filter((name) => /decal/i.test(name));
        checks.ok('decal passes scheduled', decalPasses.length > 0, decalPasses.join(','));
        return checks.items;
      },
    };
  },
});

export default feature;
