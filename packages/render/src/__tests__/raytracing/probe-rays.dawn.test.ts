import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifyProbeRayRows, verifyProbeRays } from './probe-rays.fixture';

it('emits fresh candidate rays into the real Global query and replays after producer destruction', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  const report = await verifyProbeRays(async (tape, outputs) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/probe-rays.rhitape`, tape);
    for (const [index, output] of outputs.entries())
      for (const [name, bytes] of Object.entries(output))
        await writeFile(`${directory}/probe-rays-${index}-${name}.bin`, bytes);
  });
  if (directory) await writeFile(`${directory}/probe-rays.json`, JSON.stringify(report, null, 2));
}, 120000);

it('keeps multi-probe candidate identity and square direction intervals separate', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  const report = await verifyProbeRayRows(async (outputs) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    for (const [name, bytes] of Object.entries(outputs))
      await writeFile(`${directory}/probe-rays-multi-${name}.bin`, bytes);
  });
  if (directory)
    await writeFile(`${directory}/probe-rays-multi.json`, JSON.stringify(report, null, 2));
});
