import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { shaderManifestUrl } from '../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';
import { verifyRetainedRayScene } from './scene-projection.gpu-fixture';

const published = await loadPublishedRayKernels(
  shaderManifestUrl(await buildEngineShaderManifest()),
);

it('traces retained offscreen contributors and replays edits after original resources retire', async () => {
  const result = await verifyRetainedRayScene(published.query);
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'retained-scene.rhitape'), result.bytes);
    await writeFile(join(directory, 'retained-scene.json'), JSON.stringify(result.facts, null, 2));
    for (const [stage, output] of result.outputs.entries())
      await writeFile(join(directory, `retained-scene-${stage}.bin`), output);
  }
}, 60_000);
