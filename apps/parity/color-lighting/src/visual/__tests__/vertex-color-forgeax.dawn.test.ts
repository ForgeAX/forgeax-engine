import { writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it, onTestFinished } from 'vitest';
import { runVertexColorProducerEntry, vertexColorProducerIsScheduled } from '../vertex-color-producer-entry';

const VERTEX_COLOR_BATCH_TIMEOUT_MS = 120_000;

it.skipIf(!vertexColorProducerIsScheduled())('runs the ForgeaX Dawn vertex-color producer', async () => {
  globalThis.__forgeaxVertexColorPublish = (path, output) => {
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  };
  const manifest = await buildEngineShaderManifest();
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
  onTestFinished(() => URL.revokeObjectURL(url));
  return runVertexColorProducerEntry('forgeax', 'dawn', { shaderManifestUrl: url });
}, VERTEX_COLOR_BATCH_TIMEOUT_MS);
