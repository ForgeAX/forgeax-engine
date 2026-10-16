import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { rayPathCommands } from './path-tracer.commands';
import { verifySubmittedTextures } from './submitted-textures.gpu-fixture';

it('traces dynamic MASK through accepted texture and sampler residency and fresh replay', async () => {
  const result = await verifySubmittedTextures(
    await rayPathCommands.prepareRayPublicationFixture(undefined, 'cutout'),
  );
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'submitted-textures.rhitape'), result.bytes);
    await writeFile(
      join(directory, 'submitted-textures.json'),
      JSON.stringify(result.facts, null, 2),
    );
    for (const [stage, bytes] of result.outputs.entries())
      await writeFile(join(directory, `submitted-textures-${stage}.bin`), bytes);
  }
}, 120_000);
