import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { verifySamplerResidency } from './sampler-residency.gpu-fixture';

it('replaces same-handle sampler filtering while previous bindings stay valid', async () => {
  const result = await verifySamplerResidency();
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'sampler-source.rhitape'), result.bytes);
    await writeFile(join(directory, 'sampler-source.json'), JSON.stringify(result.facts, null, 2));
    for (const [index, output] of result.results.entries())
      await writeFile(join(directory, `sampler-source-${index}.bin`), output);
  }
}, 60_000);
