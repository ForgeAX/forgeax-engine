import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifyProbeCardSupport } from './probe-card-support.fixture';

it('preserves the Global caller truth table independently of Surface RGB and replays after disposal', async () => {
  const result = await verifyProbeCardSupport();
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/card-support.rhitape`, result.tape);
    await writeFile(`${directory}/card-support.bin`, result.live);
    await writeFile(`${directory}/card-support.json`, JSON.stringify(result.rows, null, 2));
  }
}, 60000);
