import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { verifyRasterPassLabels } from './raster-pass-label.fixture';

it('retains raster labels and pixels through actual capture and fresh replay', async () => {
  const result = await verifyRasterPassLabels();
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/raster-label.rhitape`, result.bytes);
  writeFileSync(`${directory}/live.rgba8`, result.live);
  writeFileSync(`${directory}/replayed.rgba8`, result.replayed);
  writeFileSync(`${directory}/labels.json`, `${JSON.stringify(result.labels)}\n`);
});
