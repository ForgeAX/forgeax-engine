import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { MeshRenderer } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Hold a key to recolor a cube',
  catalog: 'Keyboard input',
  kind: 'visual',
  summary:
    'An Update system reads InputSnapshot.keyboard.down("k") every frame; while K is held the cube switches to a green material. Hold K yourself or use the toggle, which dispatches keydown/keyup on window.',
  expect: 'ON (K held): the cube is bright green. OFF (K released): the cube is red.',
  setup({ world, app, frames }) {
    spawnStage(world);
    const red = standard(world, { baseColor: [0.9, 0.1, 0.1, 1] });
    const green = standard(world, { baseColor: [0.1, 0.95, 0.2, 1] });
    const cube = spawnMesh(world, MESH.cube, red, { pos: [0, 0.8, 0], scale: [1.6, 1.6, 1.6] });
    let held = false;
    let shown = false;
    world.addSystem(Update, {
      name: 'fl-key-recolor',
      queries: [],
      fn: (world) => {
        held = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard.down('k');
      },
    });
    app.renderer.subscribe((event) => {
      if (event.kind !== 'frame-submitted' || held === shown) return;
      shown = held;
      world.set(cube, MeshRenderer, { materials: [held ? green : red] } as never);
    });
    const press = (on: boolean) =>
      window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { key: 'k', code: 'KeyK' }));
    press(true);
    return {
      async toggle(on) {
        press(on);
        await frames(4);
      },
      async checks() {
        const c = new CheckList();
        press(true);
        await frames(4);
        c.ok('system sees K held', held);
        press(false);
        await frames(4);
        c.ok('system sees K released', !held);
        press(true);
        await frames(4);
        return c.items;
      },
    };
  },
});
