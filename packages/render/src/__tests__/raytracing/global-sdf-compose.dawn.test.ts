import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifyBorrowedGlobalSdfComposition } from './global-sdf-compose.fixture';

it('matches borrowed composition with the reference, preserves omitted output and replays exact ranges', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  const result = await verifyBorrowedGlobalSdfComposition(async (tape, outputs) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/borrowed-compose.rhitape`, tape);
    for (const [name, bytes] of Object.entries(outputs))
      await writeFile(`${directory}/borrowed-compose-${name}.bin`, bytes);
  });
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/borrowed-compose.json`, JSON.stringify(result.summary, null, 2));
  }
}, 120000);
