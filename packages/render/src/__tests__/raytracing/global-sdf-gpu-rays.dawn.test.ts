import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifyGlobalSdfGpuRays } from './global-sdf-gpu-rays.fixture';

it('traces borrowed GPU-emitted rays and replays them after producer destruction', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  const result = await verifyGlobalSdfGpuRays(async (tape, outputs) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/global-gpu-rays.rhitape`, tape);
    for (const [index, output] of outputs.entries()) {
      await writeFile(`${directory}/global-gpu-rays-${index}-rays.bin`, output.rays);
      await writeFile(`${directory}/global-gpu-rays-${index}-hits.bin`, output.hits);
    }
  });
  if (directory)
    await writeFile(`${directory}/global-gpu-rays.json`, JSON.stringify(result, null, 2));
}, 120000);
