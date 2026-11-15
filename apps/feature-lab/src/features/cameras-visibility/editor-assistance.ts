import { Camera, editorAssistance, PointLight, readEditorAssistance } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

export default defineFeature({
  title: 'Editor assistance',
  catalog: 'Editor assistance',
  kind: 'visual',
  summary:
    'An opt-in native Feature derives camera and light diagrams without helper entities or authored component writes. Local and Worker sources capture the same input.',
  expect:
    'ON: a fixed-pixel camera glyph, camera frustum and point-light range appear. OFF: the helper pass disappears and the authored scene remains unchanged.',
  setup({ app, world, frames }) {
    spawnStage(world, { eye: [0, 2, 6], target: [0, 0.5, 0] });
    world
      .spawn(
        { component: Transform, data: { pos: [1, 0.8, 0] } },
        { component: Camera, data: { near: 0.1, far: 3, fov: 0.8, aspect: 1 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [-1, 0.8, 0] } },
        { component: PointLight, data: { range: 1.6, intensity: 1 } },
      )
      .unwrap();
    const count = world.inspect().entityCount;
    const state = editorAssistance(world);
    const configure = (enabled: boolean) =>
      state
        .configure({ enabled, icons: true, cameraFrusta: true, lightRanges: true, depth: 'always' })
        .unwrap();
    configure(true);
    const helperPasses = () =>
      app.renderer
        .inspect()
        .perFramePassNames.filter(
          (name) => name.includes('editor-always') || name.includes('editor-occluded'),
        );
    return {
      toggle: configure,
      async checks() {
        const checks = new CheckList();
        configure(true);
        await frames(3);
        checks.equal('presentation adds no gameplay entities', world.inspect().entityCount, count);
        checks.ok(
          'native helper work is recorded',
          helperPasses().length > 0,
          helperPasses().join(','),
        );
        configure(false);
        await frames(3);
        checks.equal(
          'disabled state produces no helper input',
          readEditorAssistance(world)?.snapshot(),
          undefined,
        );
        checks.equal('disabled state records no helper passes', helperPasses(), []);
        checks.equal('disabling preserves authored entities', world.inspect().entityCount, count);
        configure(true);
        await frames(1);
        return checks.items;
      },
    };
  },
});
