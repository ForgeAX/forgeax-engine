import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifySceneSdf, verifySceneSdfContactGradient } from './scene-sdf.fixture';

it('composes a managed field before swept collision, shares consumers, rejects adoption and replays on a fresh device', async () => {
  await verifySceneSdf(async (tape, report) => {
    const directory = process.env.FORGEAX_VFX_SDF_EVIDENCE;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/scene-sdf.rhitape`, tape);
    await writeFile(`${directory}/scene-sdf.json`, JSON.stringify(report, null, 2));
  });
}, 120000);

it('uses the sampled cell gradient and completes four captured floor/wall contacts within the original work budget', async () => {
  await verifySceneSdfContactGradient(async (tape, report) => {
    const directory = process.env.FORGEAX_VFX_SDF_EVIDENCE;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/contact-gradient.rhitape`, tape);
    await writeFile(`${directory}/contact-gradient.json`, JSON.stringify(report, null, 2));
  });
}, 120000);
