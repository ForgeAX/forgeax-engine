import { mkdir, writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { runInvalidBundleOffsetFixture, runRenderBundleFixture } from './render-bundle.fixture';

it(
  'preserves native offset slice validation on cached submissions',
  runInvalidBundleOffsetFixture,
  60_000,
);

it('reuses render bundles and replays every draw on a fresh Dawn device', async () => {
  const result = await runRenderBundleFixture(
    process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 8 : 60,
  );
  const directory = 'artifacts/render-bundle';
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/stable.rhitape`, result.artifact.bytes);
  await writeFile(
    `${directory}/evidence.json`,
    JSON.stringify(
      {
        digest: result.artifact.digest,
        backend: result.backendKind,
        frames: result.frames,
        works: result.works,
      },
      null,
      2,
    ),
  );
}, 60_000);
