import { Outline, OutlineOcclusionValue } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { serial } from './support/serial';

export default defineFeature({
  title: 'Selection outline',
  catalog: 'Selection outline',
  kind: 'visual',
  summary:
    'Camera Outline lists exact entities; visible and hidden silhouettes are composited from scene depth. Width 0 does zero work.',
  expect:
    'ON: the grey sphere gets a thick yellow outline, and the part hidden behind the wall shows a magenta outline. OFF: no outline, and no outline-* passes run.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { eye: [0, 1.8, 5], target: [0, 0.8, 0] });
    const sphere = spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [0.5, 0.5, 0.5, 1] }),
      {
        pos: [0.4, 0.9, -0.5],
        scale: [1.4, 1.4, 1.4],
      },
    );
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.35, 0.6, 1] }), {
      pos: [-0.6, 0.9, 0.8],
      scale: [1.4, 1.8, 0.2],
    });
    const data = (width: number) => ({
      entities: [sphere],
      visibleColor: [1, 0.9, 0],
      hiddenColor: [1, 0, 1],
      width,
      occlusion: OutlineOcclusionValue.all,
    });
    world.addComponent(camera, { component: Outline, data: data(6) as never });
    const outlinePasses = () =>
      app.renderer.inspect().perFramePassNames.filter((name) => name.startsWith('outline'));
    return {
      toggle(on) {
        world.set(camera, Outline, data(on ? 6 : 0) as never);
      },
      checks: serial(async () => {
        const checks = new CheckList();
        world.set(camera, Outline, data(6) as never);
        await frames(3);
        checks.ok(
          'selection runs outline-* passes',
          outlinePasses().length > 0,
          outlinePasses().join(','),
        );
        world.set(camera, Outline, data(0) as never);
        await frames(3);
        checks.equal('width 0 runs no outline pass', outlinePasses(), []);
        world.set(camera, Outline, data(6) as never);
        await frames(2);
        return checks.items;
      }),
    };
  },
});
