import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifyGlobalSdf } from './global-sdf.fixture';
import { verifyGlobalSdfQuery } from './global-sdf-query.fixture';
import { verifyGlobalSdfMinimumStep } from './global-sdf-step.fixture';
import { prepareSdfCardsFixture } from './sdf-cards.commands';

it('composes mesh distance fields in world space and replays every output on a fresh device', async () => {
  const result = await verifyGlobalSdf(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/global-compose.rhitape`, result.tape);
    for (const [i, bytes] of result.live.entries())
      await writeFile(`${dir}/global-compose-${i}.bin`, bytes);
    await writeFile(
      `${dir}/global-compose.json`,
      JSON.stringify({ counts: result.counts, cases: result.cases, works: result.works }, null, 2),
    );
  }
}, 120000);

it('queries a composed world region without treating unavailable space as a miss', async () => {
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  const result = await verifyGlobalSdfQuery(
    await prepareSdfCardsFixture(),
    async (tape, outputs) => {
      if (!dir) return;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/global-query.rhitape`, tape);
      for (const [i, bytes] of outputs.entries())
        await writeFile(`${dir}/global-query-${i}.bin`, bytes);
    },
  );
  if (dir) await writeFile(`${dir}/global-query.json`, JSON.stringify(result, null, 2));
}, 120000);

it('keeps minimum step independent of expansion and preserves a sampled near blocker', async () => {
  await verifyGlobalSdfMinimumStep();
}, 120000);
