import { openReplay } from '@forgeax/engine/rhi-debug';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { firstPixel, freshReplayBackend, recordSolidFrame, TAPE_COLOR } from './_shared/rhi-tape';

async function replayPixel(
  tape: Parameters<typeof openReplay>[0],
): Promise<string | readonly number[]> {
  const session = await openReplay(tape, await freshReplayBackend());
  if (!session.ok) return `openReplay: ${session.error.code}`;
  try {
    const work = session.value.inspectWork(0, ['pixels']);
    const inspected = await work;
    if (!inspected.ok) return `inspectWork: ${inspected.error.code}`;
    if (inspected.value.attachment === undefined) return 'no attachment readback';
    return firstPixel(inspected.value.attachment.bytes);
  } finally {
    await session.value.dispose();
  }
}

export default defineFeature({
  title: 'Deterministic RHI replay',
  catalog: 'Deterministic RHI replay',
  kind: 'probe',
  summary:
    'openReplay rebuilds a captured tape on a brand-new device and replays through a work item; the result depends only on the tape.',
  expect:
    'Two independent fresh-device replays read back the captured tint; a tape with a foreign formatVersion is refused with tape-version-unsupported.',
  async setup({ world }) {
    spawnStage(world);
    const recorded = await recordSolidFrame().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    if (typeof recorded === 'string') {
      return {
        checks: (): FeatureCheck[] => [{ name: 'record frame', ok: false, detail: recorded }],
      };
    }
    const first = await replayPixel(recorded.tape);
    const second = await replayPixel(recorded.tape);
    const foreign = {
      ...recorded.tape,
      header: { ...recorded.tape.header, formatVersion: 6 },
    } as unknown as typeof recorded.tape;
    const refused = await openReplay(foreign, await freshReplayBackend());
    return {
      checks(): FeatureCheck[] {
        const expected = JSON.stringify([...TAPE_COLOR]);
        return [
          {
            name: 'fresh-device replay reads the captured tint',
            ok: JSON.stringify(first) === expected,
            detail: JSON.stringify(first),
          },
          {
            name: 'second replay is identical',
            ok: JSON.stringify(second) === JSON.stringify(first),
            detail: JSON.stringify(second),
          },
          {
            name: 'formatVersion 6 is refused',
            ok: !refused.ok && refused.error.code === 'tape-version-unsupported',
            detail: refused.ok ? 'opened' : refused.error.code,
          },
        ];
      },
    };
  },
});
