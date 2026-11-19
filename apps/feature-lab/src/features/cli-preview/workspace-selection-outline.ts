import { engineWorkspaceTargetToolsPlugin } from '@forgeax/engine/app';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Outline, readEditorAssistance, setActiveCamera } from '@forgeax/engine/render';
import { ChildOf, Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Workspace selection outline',
  catalog: 'Workspace selection outline',
  kind: 'visual',
  summary:
    'engineWorkspaceTargetTools.highlight({ entityId }) projects the selected entity and its descendants through the independent editor Outline; authored camera Outline remains unchanged.',
  expect:
    'ON: all nine grey cubes under the selected parent get a bright outline. OFF: highlight({}) clears the selection and the editor Outline disappears; materials never change.',
  async setup({ app, world, canvas, frames }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const { camera } = spawnStage(world, { eye: [0, 4.5, 6], target: [0, 0.3, 0] });
    setActiveCamera(world, camera);
    const parent = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
    const grey = standard(world, { baseColor: [0.25, 0.25, 0.28, 1] });
    for (let i = 0; i < 9; i += 1) {
      spawnMesh(
        world,
        stageCube,
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
        const input = readEditorAssistance(world)?.snapshot();
        checks.equal('selection retains the full parent handle', input?.selected, [parent]);
        checks.equal('editor width is 4', input?.outline.width, 4);
        checks.ok('author camera Outline remains absent', !world.get(camera, Outline).ok);
        checks.ok(
          'native editor outline passes run',
          app.renderer
            .inspect()
            .perFramePassNames.some((name) => name.startsWith('editor-outline')),
        );
        select(false);
        await frames(2);
        checks.equal(
          'clearing releases only editor selection',
          readEditorAssistance(world)?.snapshot()?.selected,
          [],
        );
        checks.ok('clearing leaves authored camera unchanged', !world.get(camera, Outline).ok);
        select(true);
        await frames(1);
        return checks.items;
      },
    };
  },
});
