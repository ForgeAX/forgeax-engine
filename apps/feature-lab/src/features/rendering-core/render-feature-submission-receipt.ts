import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { createLabComputeFeature, LAB_COMPUTE_PASS } from './support/compute-feature';

const lab = createLabComputeFeature('feature-lab::submission-receipt');

export default defineFeature({
  title: 'RenderFeature submission receipt',
  catalog: 'RenderFeature submission receipt',
  kind: 'probe',
  appOptions: { features: [lab.feature] },
  summary:
    'onFrameSubmitted(data, submission) runs once per submitted frame and lists the compute/draw passes that survived prepared-resource resolution. It proves command admission, not GPU results.',
  expect:
    'All checks pass: the callback fired for every recent frame, the receipt names the feature compute pass with exactly one dispatch, and onFrameAborted does not fire once the feature is warm (warm-up frames may abort while the program is still preparing).',
  async setup({ world, frames }) {
    spawnStage(world);
    await frames(3);
    return {
      async checks() {
        const before = lab.state.submitted;
        const abortedBefore = lab.state.aborted;
        await frames(4);
        const passes = lab.state.last?.works.flatMap((work) => work.passes) ?? [];
        const tick = passes.find((pass) => pass.name === LAB_COMPUTE_PASS);
        return new CheckList()
          .ok(
            'callback fired per frame',
            lab.state.submitted - before >= 3,
            `delta=${lab.state.submitted - before}`,
          )
          .ok(
            'receipt lists the compute pass',
            tick !== undefined,
            JSON.stringify(passes.map((pass) => pass.name)),
          )
          .equal('one admitted dispatch', tick?.resolvedGpuCompute?.dispatches.length, 1)
          .equal('no aborted frames once warm', lab.state.aborted - abortedBefore, 0).items;
      },
    };
  },
});
