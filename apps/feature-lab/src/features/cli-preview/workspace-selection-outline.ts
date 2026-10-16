import { engineWorkspaceTargetToolsPlugin } from '@forgeax/engine/app';
import { Outline, setActiveCamera } from '@forgeax/engine/render';
import { ChildOf, Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Workspace selection outline',
  catalog: 'Workspace selection outline',
  kind: 'visual',
  summary:
    'engineWorkspaceTargetTools.highlight({ entityId }) projects the selected entity and its descendants into the active camera Outline (width 4 when unauthored); clearing removes only the members it added (#3408).',
  expect:
    'ON: all nine grey cubes under the selected parent get a bright outline. OFF: highlight({}) clears the selection and the camera Outline disappears; materials never change.',
  async setup({ app, world, canvas, frames }) {
    const { camera } = spawnStage(world, { eye: [0, 4.5, 6], target: [0, 0.3, 0] });
    setActiveCamera(world, camera);
    const parent = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
    const grey = standard(world, { baseColor: [0.25, 0.25, 0.28, 1] });
    for (let i = 0; i < 9; i += 1) {
      spawnMesh(
        world,
        MESH.cube,
        grey,
        { pos: [((i % 3) - 1) * 1.8, 0.5, (Math.floor(i / 3) - 1) * 1.6] },
        { component: ChildOf, data: { parent } },
      );
    }
    const fiber = await app.pluginContext.plugin(engineWorkspaceTargetToolsPlugin, {
      targetId: 'lab',
      display: { canvas, app },
    });
    await fiber.await();
    const tools = app.pluginContext.engineWorkspaceTargetTools;
    const entityId = `lab:${world.identity}:${parent}`;
    const select = (on: boolean) => tools?.highlight?.(on ? { entityId } : {});
    select(true);
    return {
      toggle(on) {
        select(on);
      },
      async checks() {
        const checks = new CheckList();
        checks.ok('highlight capability present', tools?.highlight !== undefined);
        select(true);
        await frames(2);
        const outline = world.get(camera, Outline);
        checks.equal(
          'outline covers parent and nine descendants',
          outline.ok ? outline.value.entities.length : 0,
          10,
        );
        checks.equal('unauthored width is 4', outline.ok ? outline.value.width : 0, 4);
        select(false);
        await frames(2);
        checks.ok('clearing removes the tool-added Outline', !world.get(camera, Outline).ok);
        select(true);
        await frames(1);
        return checks.items;
      },
    };
  },
});
