import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { shaderManifestUrl } from '../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { prepareProbePlacementFixture } from './probe-placement.commands';
import { verifyProbePlacement } from './probe-placement.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';

const published = await loadPublishedRayKernels(
  shaderManifestUrl(await buildEngineShaderManifest()),
);

it('places candidate probes from native raster inputs without publishing accepted state', async () => {
  const result = await verifyProbePlacement({
    ...(await prepareProbePlacementFixture()),
    kernel: published.placement,
  });
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'probe-placement.rhitape'), result.bytes);
    await writeFile(join(dir, 'probe-placement.json'), JSON.stringify(result.report, null, 2));
  }
}, 120000);
