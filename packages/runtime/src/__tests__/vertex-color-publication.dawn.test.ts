import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyVertexColorPublication } from './vertex-color-publication.fixture';
import { startVertexColorPublicationServer } from './vertex-color-publication.server';

it('renders cooked vertex colors after JSON transport and geometry changes on Dawn', async () => {
  const server = await startVertexColorPublicationServer();
  try {
    const manifest = await buildEngineShaderManifest();
    await verifyVertexColorPublication({
      ...server,
      warmupFrames: process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 8 : 60,
      shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
    });
  } finally {
    await server.close();
  }
}, 120_000);
