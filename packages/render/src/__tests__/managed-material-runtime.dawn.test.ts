import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, beforeAll, it } from 'vitest';
import { verifyRuntimeMaterial } from './managed-material-runtime.gpu-fixture';

let manifestUrl: string;
beforeAll(async () => {
  manifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
  );
}, 120_000);
afterAll(() => URL.revokeObjectURL(manifestUrl));

it.each([
  'mesh',
  'sprite',
  'mesh-structure',
] as const)('updates shared material values through the complete Renderer without changing its entities (%s)', async (kind) => {
  await verifyRuntimeMaterial(kind, manifestUrl);
}, 120_000);
