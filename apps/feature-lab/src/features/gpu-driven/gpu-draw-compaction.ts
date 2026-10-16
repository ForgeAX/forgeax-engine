import { CheckList, defineFeature } from '../../lab/feature';
import { inspect, mainChannel, spawnGrid } from './support/scene';

export default defineFeature({
  title: 'GPU draw compaction',
  catalog: 'GPU draw compaction',
  kind: 'probe',
  summary:
    'Visible instances are compacted into bounded streams and the GPU writes the indirect draw arguments; capacity and overflow are inspection data.',
  expect:
    'All checks pass: the frame schedules the finalize-indirect pass, at least one indirect draw is encoded, overflow is false, indirect capacity covers the draws, and the main channel claims the 20 opaque cubes with no residual.',
  async setup({ app, world, frames }) {
    spawnGrid(world, 4);
    await frames(20);
    return {
      checks() {
        const checks = new CheckList();
        const { driven, passes } = inspect(app);
        checks.ok(
          'frame schedules finalize-indirect',
          passes.some((name) => name.includes('finalize-indirect')),
          passes.filter((name) => name.includes('gpu-driven')).join(','),
        );
        checks.ok(
          'indirect draws encoded',
          driven.indirectDrawCount > 0,
          `indirectDrawCount=${driven.indirectDrawCount}`,
        );
        checks.equal('overflow', driven.overflow, false);
        checks.ok(
          'bounded capacities cover the frame',
          driven.indirectCapacity >= driven.indirectDrawCount && driven.candidateCapacity >= 20,
          `indirectCapacity=${driven.indirectCapacity} candidateCapacity=${driven.candidateCapacity}`,
        );
        checks.ok(
          'candidate submitted',
          driven.submitted && driven.lastKnownGoodGeneration !== undefined,
          `submitted=${driven.submitted} lkg=${driven.lastKnownGoodGeneration}`,
        );
        const main = mainChannel(app);
        checks.ok(
          'main channel claims the opaque cubes',
          main !== undefined && main.claimedDrawCount >= 20 && main.residualDrawCount === 0,
          JSON.stringify(main),
        );
        return checks.items;
      },
    };
  },
});
