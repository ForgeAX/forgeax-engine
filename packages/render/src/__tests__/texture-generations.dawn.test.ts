import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { verifyTextureGenerations } from './texture-generations.gpu-fixture';

it('samples and replays independent generations of a recycled texture slot', async () => {
  const result = await verifyTextureGenerations();
  const directory = process.env.FORGEAX_TEXTURE_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'texture-generations.rhitape'), result.bytes);
    await writeFile(
      join(directory, 'texture-generations.json'),
      JSON.stringify(result.facts, null, 2),
    );
  }
}, 60_000);
