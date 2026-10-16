import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const POST_STAGES = [
  'transparent-blend',
  'bloom',
  'output-transform',
  'fxaa',
  'post-effect',
  'present',
];

export default defineFeature({
  title: 'Standard render pipeline',
  catalog: 'Standard render pipeline',
  kind: 'probe',
  summary:
    'Without any profile option the Renderer installs forgeax::standard: scene, transparency, Bloom, output transform (tone + LUT), FXAA, post effect and present on one committed graph.',
  expect:
    "All checks pass: the active profile is 'forgeax::standard' with the canonical post-stage order, the committed output graph carries an output-transform owner, and the frame graph records passes.",
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.9, 0.3, 0.2, 1] }), {
      pos: [0, 0.6, 0],
    });
    await frames(3);
    return {
      checks() {
        const facts = app.renderer.inspect();
        return new CheckList()
          .equal('pipeline id', facts.profile.pipelineId, 'forgeax::standard')
          .equal(
            'default render path',
            facts.profile.renderPath,
            DEFAULT_STANDARD_PROFILE.renderPath,
          )
          .equal('post stage order', facts.profile.postStages, POST_STAGES)
          .equal(
            'output transform owner',
            facts.output.outputTransform,
            'forgeax::standard::output-transform',
          )
          .ok(
            'output graph has passes',
            facts.output.graphPassNames.length > 0,
            facts.output.graphPassNames.join(','),
          )
          .ok(
            'output contract has no error',
            facts.output.error === undefined,
            JSON.stringify(facts.output.error),
          )
          .ok(
            'frame graph recorded',
            facts.perFramePassNames.length > 0,
            facts.perFramePassNames.join(','),
          ).items;
      },
    };
  },
});
