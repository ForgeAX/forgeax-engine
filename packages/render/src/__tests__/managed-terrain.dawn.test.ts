import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyRuntimeTerrain } from './managed-terrain.gpu-fixture';

it.each([
  'weights',
  'ids',
] as const)('renders native Terrain edits without rebinding (%s)', async (encoding) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
  );
  try {
    await verifyRuntimeTerrain(encoding, url);
  } finally {
    URL.revokeObjectURL(url);
  }
}, 120_000);
