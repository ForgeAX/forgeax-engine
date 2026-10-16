import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { shaderManifestUrl } from '../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';
import { verifyRayReference } from './query.fixture';

const published = await loadPublishedRayKernels(
  shaderManifestUrl(await buildEngineShaderManifest()),
);

it('captures and independently replays opaque ray queries on Dawn', async () => {
  const result = await verifyRayReference(published.query);
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'reference.rhitape'), result.bytes);
    await writeFile(join(directory, 'native-input.json'), JSON.stringify(result.packet));
    await writeFile(join(directory, 'portable-hits.bin'), result.output);
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify(
        {
          rayCount: result.rayCount,
          hitCount: result.hitCount,
          selectedWorkIndex: 0,
          laterMaskedWorkIndex: 1,
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
