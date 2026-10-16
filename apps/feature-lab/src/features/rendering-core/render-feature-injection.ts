import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { createLabComputeFeature, LAB_COMPUTE_PASS } from './support/compute-feature';

const IDENTITY = 'feature-lab::render-feature-injection';
const lab = createLabComputeFeature(IDENTITY);

export default defineFeature({
  title: 'RenderFeature injection',
  catalog: 'RenderFeature injection',
  kind: 'probe',
  appOptions: { features: [lab.feature] },
  summary:
    'A producer passed through createApp({ features }) declares one compute program, one storage buffer and one dispatch; the Standard graph admits it next to the scene passes.',
  expect:
    "All checks pass: inspect().features lists the identity, featureDiagnostics reports it 'active' with no error, and the per-frame pass list contains the feature pass next to the Standard passes.",
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.6, 1, 1] }), {
      pos: [0, 0.5, 0],
    });
    await frames(3);
    return {
      async checks() {
        await frames(2);
        const facts = app.renderer.inspect();
        const diag = facts.featureDiagnostics.find((entry) => entry.identity === IDENTITY);
        const passes = facts.perFramePassNames;
        return new CheckList()
          .ok('identity registered', facts.features.includes(IDENTITY), facts.features.join(','))
          .equal('status', diag?.status, 'active')
          .ok(
            'no latest error',
            diag !== undefined && diag.latestError === undefined,
            JSON.stringify(diag?.latestError),
          )
          .ok(
            'feature pass in frame',
            passes.some((name) => name.includes(LAB_COMPUTE_PASS)),
            passes.join(','),
          )
          .ok('Standard passes kept', passes.length > 1, `passCount=${passes.length}`).items;
      },
    };
  },
});
