import { DEFAULT_STANDARD_PROFILE, ScreenSpaceReflection, Skylight } from '@forgeax/engine/render';
import { CheckList, defineFeature, type FeatureDefinition } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, spawnSun, standard } from '../../lab/stage';

const SSR = { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 } as const;

export default defineFeature<FeatureDefinition>({
  title: 'Screen-space reflections',
  catalog: 'Screen-space reflections',
  kind: 'visual',
  summary:
    'A ScreenSpaceReflection companion on a Standard Deferred camera traces the depth buffer and composes a bounded reflection delta over the environment fallback. Admission is fail-closed: every visible opaque row must use the built-in Standard PBR material, so the pillars are emissive Standard rather than unlit.',
  expect:
    'ON: the glossy dark floor mirrors the bright emissive red, green and blue pillars below them. OFF: the floor shows only the flat skylight sheen, with no pillar reflections.',
  appOptions: {
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
    ssrIdentity: {
      sourceHead: 'unknown',
      sourceTree: 'unknown',
      lockSha256: 'unknown',
      buildSha256: 'unknown',
    },
  },
  setup({ app, world, frames }) {
    spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.05, 0.05, 0.06, 1], metallic: 1, roughness: 0.05 }),
      {
        pos: [0, -0.05, 0],
        scale: [14, 0.1, 14],
      },
    );
    const colors = [
      [1, 0.1, 0.1, 1],
      [0.1, 1, 0.2, 1],
      [0.15, 0.3, 1, 1],
    ] as const;
    colors.forEach((rgba, i) => {
      const [r, g, b] = rgba;
      const emissive = standard(world, {
        baseColor: rgba,
        emissive: [r, g, b],
        emissiveIntensity: 3,
        roughness: 0.6,
      });
      spawnMesh(world, MESH.cube, emissive, {
        pos: [-1.8 + i * 1.8, 1, -1.5],
        scale: [0.8, 2, 0.8],
      });
    });
    world
      .spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0.4 } as never })
      .unwrap();
    spawnSun(world, { intensity: 1 });
    const camera = spawnCamera(world, {
      eye: [0, 1.2, 5],
      target: [0, 0.4, -1],
      data: { clearColor: [0.02, 0.02, 0.03, 1] },
    });
    world.addComponent(camera, { component: ScreenSpaceReflection, data: SSR }).unwrap();
    return {
      toggle(on) {
        if (on)
          world.addComponent(camera, { component: ScreenSpaceReflection, data: SSR }).unwrap();
        else world.removeComponent(camera, ScreenSpaceReflection).unwrap();
      },
      async checks() {
        await frames(3);
        const inspection = app.renderer.inspect();
        return new CheckList()
          .equal('profile render path', inspection.profile.renderPath, 'deferred')
          .ok(
            'SSR admitted',
            inspection.ssr.status === 'admitted',
            `status=${inspection.ssr.status} failure=${JSON.stringify(inspection.ssr.failure ?? null)}`,
          ).items;
      },
    };
  },
});
