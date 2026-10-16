import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { prepareSdfCardsFixture } from './sdf-cards.commands';
import { verifySoftwareSdfQuery } from './software-sdf-query.fixture';

it('continues only executed near misses and replays source-dependent intervals', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  const result = await verifySoftwareSdfQuery(
    await prepareSdfCardsFixture(),
    async (name, bytes) => {
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(`${directory}/${name}`, bytes);
      }
    },
  );
  if (directory) await writeFile(`${directory}/software-sdf.json`, JSON.stringify(result, null, 2));
}, 120000);
