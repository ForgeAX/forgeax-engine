import { World } from '@forgeax/engine/ecs';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Multi-World composition',
  catalog: 'Multi-World composition',
  kind: 'visual',
  summary:
    'app.setDrawSource(() => ({ worlds: [app.world, overlay], cameraOwner: 0, resourceOwner: 0 })) makes one Renderer draw renderables from a second World with the primary camera and light.',
  expect:
    'ON: two large glowing cubes (cyan and magenta) from the second World stand beside the grey sphere of the primary World. OFF: only the primary World (sphere on the floor) is drawn.',
  setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.7, 0.7, 0.7, 1] }), {
      pos: [0, 0.6, 0],
    });
    const overlay = new World();
    const glow = (rgb: readonly [number, number, number]) =>
      standard(overlay, {
        baseColor: [rgb[0], rgb[1], rgb[2], 1],
        emissive: rgb,
        emissiveIntensity: 0.6,
      });
    spawnMesh(overlay, MESH.cube, glow([0.1, 0.9, 1]), {
      pos: [-1.6, 0.7, 0],
      scale: [1.1, 1.1, 1.1],
    });
    spawnMesh(overlay, MESH.cube, glow([1, 0.2, 0.7]), {
      pos: [1.6, 0.7, 0],
      scale: [1.1, 1.1, 1.1],
    });
    const route = (on: boolean) =>
      app.setDrawSource(
        on ? () => ({ worlds: [app.world, overlay], cameraOwner: 0, resourceOwner: 0 }) : undefined,
      );
    route(true);
    return {
      toggle: route,
      async checks() {
        const checks = new CheckList();
        route(false);
        await frames(3);
        const single = app.renderer.inspect().renderScene.projectionRecords;
        route(true);
        await frames(3);
        const composed = app.renderer.inspect().renderScene.projectionRecords;
        return checks
          .ok(
            'second World adds its renderables',
            composed >= single + 2,
            `${single} -> ${composed}`,
          )
          .equal('renderer alive', app.renderer.state(), 'alive').items;
      },
    };
  },
});
