import { encodeTape, summarizeFrame, tapeDigest } from '@forgeax/engine/rhi-debug';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { recordSolidFrame } from './_shared/rhi-tape';

export default defineFeature({
  title: 'RHI frame tape',
  catalog: 'RHI frame tape',
  kind: 'probe',
  summary:
    'attachRecorder wraps the WebGPU backend before resources exist; captureFrame between two frameBoundary calls yields a self-contained v7 tape.',
  expect:
    'The tape decodes to one pass and one draw work, seeds every resource it reads, and re-encodes to the same digest.',
  async setup({ world }) {
    spawnStage(world);
    const recorded = await recordSolidFrame().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    return {
      async checks(): Promise<FeatureCheck[]> {
        if (typeof recorded === 'string')
          return [{ name: 'record frame', ok: false, detail: recorded }];
        const summary = summarizeFrame(recorded.model);
        const reencoded = encodeTape(recorded.tape);
        const sameDigest =
          reencoded.ok &&
          (await tapeDigest(reencoded.value)) === (await tapeDigest(recorded.bytes));
        return [
          { name: 'tape formatVersion 7', ok: recorded.tape.header.formatVersion === 7 },
          {
            name: 'one render pass captured',
            ok: summary.passCount === 1,
            detail: JSON.stringify(summary).slice(0, 200),
          },
          { name: 'one draw work item', ok: recorded.model.works.length === 1 },
          { name: 'commands recorded', ok: summary.commandCount > 0 },
          {
            name: 'no unseeded resources (self-contained)',
            ok: summary.unseededResources.length === 0,
            detail: JSON.stringify(summary.unseededResources),
          },
          { name: 'encode(decode(bytes)) keeps the digest', ok: sameDigest },
        ];
      },
    };
  },
});
