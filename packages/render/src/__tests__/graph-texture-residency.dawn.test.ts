import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { verifyGraphTextureResidency } from './graph-texture-residency.gpu-fixture';

it('keeps graph mip residency private and replays both source generations', async () => {
  const result = await verifyGraphTextureResidency();
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'texture-graph.rhitape'), result.bytes);
    await writeFile(join(directory, 'texture-graph.json'), JSON.stringify(result.facts, null, 2));
    for (const [index, output] of result.outputs.entries())
      await writeFile(join(directory, `texture-graph-${index}.bin`), output);
  }
}, 60_000);
