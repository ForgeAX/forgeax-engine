import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifyGlobalCards } from './global-card-lookup.fixture';
import { prepareSdfCardsFixture } from './sdf-cards.commands';

it('retains bounded object candidates and independently validates shared Card samples', async () => {
  const results = await verifyGlobalCards(await prepareSdfCardsFixture());
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    for (const r of results) {
      await writeFile(`${dir}/global-cards-${r.mode}.rhitape`, r.tape);
      for (const key of [
        'candidates',
        'samples',
        'hits',
        'borrowedCandidates',
        'borrowedSamples',
      ] as const)
        await writeFile(`${dir}/global-cards-${r.mode}-${key}.bin`, r[key]);
    }
  }
}, 120000);
