import { Materials, MeshRenderer, PlanarReflection } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, material, spawnMesh, spawnStage, standard, unlit } from '../../lab/stage';
import { serial } from './support/serial';
import { readTarget, sampledTarget, TARGET_2D } from './support/target';

function redPixels(bytes: Uint8Array): number {
  let red = 0;
  for (let at = 0; at < bytes.length; at += 4)
    // The target stores linear color, so the lit red cube reads well below 128.
    if ((bytes[at] ?? 0) > 40 && (bytes[at] ?? 0) > 3 * (bytes[at + 1] ?? 0)) red++;
  return red;
}

export default defineFeature({
  title: 'Planar reflection',
  catalog: 'Planar reflection capture',
  kind: 'visual',
  summary:
    'PlanarReflection on the display Camera renders the mirrored scene into a distinct public RenderTarget; any material can sample it.',
  expect:
    'ON: the monitor panel on the right shows the upside-down mirrored red cube from the y=0 plane. OFF: PlanarReflection is removed and the panel is plain grey.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { eye: [0, 2, 6], target: [0, 0.5, 0] });
    const made = sampledTarget(app, TARGET_2D, '2d');
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [1, 0.05, 0.05, 1] }), {
      pos: [-0.8, 1, 0],
    });
    if (made === undefined)
      return {
        async checks() {
          return new CheckList().ok('target created', false).items;
        },
      };
    const data = { target: made.targetRef, normal: [0, 1, 0], distance: 0 };
    world.addComponent(camera, { component: PlanarReflection, data: data as never }).unwrap();
    const screen = material(
      world,
      Materials.unlit([1, 1, 1, 1], { baseColorTexture: made.sourceRef as never }),
    );
    const grey = unlit(world, [0.4, 0.4, 0.4, 1]);
    const panel = spawnMesh(world, MESH.quad, screen, {
      pos: [1.6, 1.3, 0.5],
      scale: [1.8, 1.8, 1],
    });
    const passes = () =>
      app.renderer
        .inspect()
        .perFramePassNames.filter((name) => name.startsWith('planar-reflection-face'));
    const set = (on: boolean) => {
      world.set(panel, MeshRenderer, { materials: [on ? screen : grey] } as never);
      if (on === world.hasComponent(camera, PlanarReflection)) return;
      if (on)
        world.addComponent(camera, { component: PlanarReflection, data: data as never }).unwrap();
      else world.removeComponent(camera, PlanarReflection).unwrap();
    };
    return {
      toggle: set,
      checks: serial(async () => {
        const checks = new CheckList();
        set(false);
        await frames(3);
        checks.equal('no reflection pass without the component', passes(), []);
        set(true);
        let recorded: readonly string[] = [];
        for (let i = 0; i < 10 && recorded.length === 0; i++) {
          await frames(1);
          recorded = passes();
        }
        checks.ok(
          'adding PlanarReflection records a capture pass',
          recorded.length === 1,
          JSON.stringify(recorded),
        );
        let bytes = await readTarget(app, made.target);
        for (let i = 0; i < 10 && (typeof bytes === 'string' || redPixels(bytes) <= 10); i++) {
          await frames(3);
          bytes = await readTarget(app, made.target);
        }
        if (typeof bytes === 'string') checks.ok('reflection readback', false, bytes);
        else
          checks.ok(
            'reflection target contains the red cube',
            redPixels(bytes) > 10,
            `red=${redPixels(bytes)}`,
          );
        return checks.items;
      }),
    };
  },
});
