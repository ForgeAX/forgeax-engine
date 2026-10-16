import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { verifySdfStorage } from './sdf-storage.fixture';
import { verifyVisibilitySdf } from './sdf-visibility.fixture';

it('queries explicit sampled visibility, keeps incomplete states and replays actual resources', async () => {
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  const result = await verifyVisibilitySdf(async (tape, live) => {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/visibility.rhitape`, tape);
    for (const [i, bytes] of live.entries()) await writeFile(`${dir}/visibility-${i}.bin`, bytes);
  });
  if (dir) {
    await writeFile(
      `${dir}/visibility.json`,
      JSON.stringify({ works: result.works, errors: result.errors }, null, 2),
    );
  }
}, 120000);

it('decodes full small fields and large sparse-volume probes and replays both trace branches', async () => {
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  await verifySdfStorage(async (tape, live) => {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/storage.rhitape`, tape);
    for (const [i, bytes] of live.entries()) await writeFile(`${dir}/storage-${i}.bin`, bytes);
  });
});
