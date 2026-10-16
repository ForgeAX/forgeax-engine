import { PointLightShadow, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard, unlit } from '../../lab/stage';
import { spawnPointLight } from './support/scene';

export default defineFeature({
  title: 'Point cube shadow',
  catalog: 'Point cube shadow',
  kind: 'visual',
  summary:
    'A warm PointLight in the middle of a ring of pillars carries PointLightShadow, which allocates a six-face cube-array depth atlas.',
  expect:
    'ON: dark radial shadows point outward from every pillar like clock hands. OFF: PointLightShadow is removed; the light still shines but no pillar casts a shadow.',
  setup({ world, app }) {
    spawnGround(world);
    spawnCamera(world, {
      eye: [0, 5, 5],
      target: [0, 0, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.5, 0.6], intensity: 0.05 } as never })
      .unwrap();
    const mat = standard(world, { baseColor: [0.3, 0.6, 1, 1] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spawnMesh(world, MESH.cube, mat, {
        pos: [Math.cos(a) * 1.1, 0.5, Math.sin(a) * 1.1],
        scale: [0.25, 1, 0.25],
      });
    }
    spawnMesh(world, MESH.sphere, unlit(world, [1, 0.9, 0.6, 1]), {
      pos: [0, 0.6, 0],
      scale: [0.1, 0.1, 0.1],
    });
    const light = spawnPointLight(world, [0, 0.6, 0], [1, 0.8, 0.5], 20, 10, {
      component: PointLightShadow,
      data: {},
    });
    let enabled = true;
    let onSample = app.renderer.inspect().pointShadow;
    return {
      toggle(on) {
        if (on === enabled) return;
        if (!on) onSample = app.renderer.inspect().pointShadow;
        enabled = on;
        if (on)
          world.addComponent(light, { component: PointLightShadow, data: {} } as never).unwrap();
        else world.removeComponent(light, PointLightShadow).unwrap();
      },
      checks() {
        // The runner checks after OFF; judge the ON state by the sample taken before the toggle.
        const point = enabled ? app.renderer.inspect().pointShadow : onSample;
        return [
          { name: 'pointShadow inspected', ok: point !== undefined },
          {
            name: 'status ready',
            ok: point?.status === 'ready',
            detail: `status=${point?.status}`,
          },
          {
            name: 'one shadowed point light',
            ok: point?.shadowed === 1,
            detail: JSON.stringify(point),
          },
        ];
      },
    };
  },
});
