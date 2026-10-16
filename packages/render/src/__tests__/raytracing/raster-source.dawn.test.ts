import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { shaderManifestUrl } from '../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';
import { prepareRasterRayFixture } from './raster-source.commands';
import { verifyRasterRaySource } from './raster-source.fixture';

const published = await loadPublishedRayKernels(
  shaderManifestUrl(await buildEngineShaderManifest()),
);

it('generates receiver rays from real raster attachments and exposes invalid inputs in replay', async () => {
  const result = await verifyRasterRaySource(
    {
      ...(await prepareRasterRayFixture()),
      kernel: published.raster,
      transportKernel: published.transport,
    },
    published.composite,
  );
  const dir = process.env.FORGEAX_RAY_EVIDENCE;
  if (dir) {
    await mkdir(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(result))
      await writeFile(
        join(dir, `raster-source-${name}.${name === 'bytes' ? 'rhitape' : 'bin'}`),
        bytes,
      );
  }
}, 120000);
