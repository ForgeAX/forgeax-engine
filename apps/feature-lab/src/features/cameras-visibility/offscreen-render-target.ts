import { CameraView, Materials, MeshRenderer } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, material, spawnCamera, spawnMesh, spawnStage, unlit } from '../../lab/stage';
import { serial } from './support/serial';
import { meanColor, readTarget, sampledTarget, TARGET_2D } from './support/target';

export default defineFeature({
  title: 'Offscreen render target',
  catalog: 'Offscreen RenderTarget',
  kind: 'visual',
  summary:
    'A second Camera with a shared RenderTarget renders a separate scene offscreen; a material samples it through a RenderTargetTextureSource.',
  expect:
    'ON: the big panel shows the monitor camera image (a red sphere on a green background). OFF: the panel uses a plain grey material.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { eye: [0, 1.5, 5], target: [0, 1.2, 0] });
    world.addComponent(camera, { component: CameraView, data: { order: 0 } }).unwrap();
    const made = sampledTarget(app, TARGET_2D, '2d');
    if (made === undefined)
      return {
        async checks() {
          const c = new CheckList();
          c.ok('target created', false);
          return c.items;
        },
      };
    spawnMesh(world, MESH.sphere, unlit(world, [1, 0.1, 0.1, 1]), { pos: [50, 0, 0] });
    const monitor = spawnCamera(world, {
      eye: [50, 0, 3],
      target: [50, 0, 0],
      data: { aspect: 1, clearColor: [0.1, 0.9, 0.2, 1], target: made.targetRef },
    });
    world.addComponent(monitor, { component: CameraView, data: { order: -10 } }).unwrap();
    const screen = material(
      world,
      Materials.unlit([1, 1, 1, 1], { baseColorTexture: made.sourceRef as never }),
    );
    const grey = unlit(world, [0.4, 0.4, 0.4, 1]);
    const panel = spawnMesh(world, MESH.quad, screen, { pos: [0, 1.4, 0], scale: [2.4, 2.4, 1] });
    return {
      toggle(on) {
        world.set(panel, MeshRenderer, { materials: [on ? screen : grey] } as never);
      },
      checks: serial(async () => {
        const checks = new CheckList();
        await frames(2);
        const view = app.renderer.inspect().views?.find((entry) => entry.output === 'texture');
        checks.ok('texture view reported', view !== undefined);
        if (view !== undefined)
          checks.equal('texture view extent', [view.width, view.height], [128, 128]);
        const bytes = await readTarget(app, made.target);
        if (typeof bytes === 'string') checks.ok('target readback', false, bytes);
        else {
          const [r, g] = meanColor(bytes);
          checks.ok(
            'readback shows green clear and red sphere',
            g > 0.3 && r > 0.05,
            JSON.stringify(meanColor(bytes)),
          );
        }
        return checks.items;
      }),
    };
  },
});
