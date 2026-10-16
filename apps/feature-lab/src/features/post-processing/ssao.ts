import { DEFAULT_STANDARD_PROFILE, PointLight, Skylight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature, type FeatureDefinition } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, standard } from '../../lab/stage';

const AO = {
  algorithm: 'gtao',
  quality: 'high',
  radius: 0.8,
  bias: 0.025,
  intensity: 2.5,
} as const;

export default defineFeature<FeatureDefinition>({
  title: 'Screen-space ambient occlusion',
  catalog: 'Screen-space ambient occlusion',
  kind: 'visual',
  summary:
    'StandardProfile.ssao on the deferred render path computes half-resolution SSAO/GTAO from depth and normals and darkens ambient light only.',
  expect:
    'ON: dark contact shadows pool where the cubes meet the floor and in the inner corner of the stacked blocks. OFF: the same scene is flatly lit by the skylight with no contact darkening.',
  appOptions: {
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred', ssao: AO },
  },
  setup({ app, world, frames }) {
    const grey = standard(world, { baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.9 });
    spawnMesh(world, MESH.cube, grey, { pos: [0, -0.05, 0], scale: [12, 0.1, 12] });
    spawnMesh(world, MESH.cube, grey, { pos: [0, 1.5, -1.6], scale: [6, 3, 0.3] });
    spawnMesh(world, MESH.cube, grey, { pos: [-1, 0.5, -0.5], scale: [1, 1, 1] });
    spawnMesh(world, MESH.cube, grey, { pos: [0.3, 0.4, -0.9], scale: [0.8, 0.8, 0.8] });
    spawnMesh(world, MESH.sphere, grey, { pos: [1.3, 0.5, 0], scale: [0.5, 0.5, 0.5] });
    world
      .spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 1.2 } as never })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [3, 5, 4] } },
        { component: PointLight, data: { color: [1, 1, 1], intensity: 2, range: 30 } as never },
      )
      .unwrap();
    spawnCamera(world, {
      eye: [2.5, 2.5, 4.5],
      target: [0, 0.5, -0.5],
      data: { clearColor: [0.12, 0.14, 0.17, 1] },
    });
    const setAo = (on: boolean): void => {
      const result = app.renderer.setProfile({
        ...app.renderer.inspect().profile,
        ssao: on ? AO : false,
      });
      if (!result.ok) throw result.error;
    };
    return {
      toggle: setAo,
      async checks() {
        await frames(3);
        const inspection = app.renderer.inspect();
        return new CheckList()
          .equal('profile render path', inspection.profile.renderPath, 'deferred')
          .ok(
            'profile carries SSAO parameters',
            typeof inspection.profile.ssao === 'object',
            JSON.stringify(inspection.profile.ssao),
          )
          .ok(
            'an AO pass is scheduled',
            inspection.perFramePassNames.some(
              (name) => name.includes('ssao') || name.includes('ao'),
            ),
            inspection.perFramePassNames.join(','),
          ).items;
      },
    };
  },
});
