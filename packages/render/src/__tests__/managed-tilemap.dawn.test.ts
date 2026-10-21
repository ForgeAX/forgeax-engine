import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, beforeAll, it } from 'vitest';
import { verifyRuntimeTilemap } from './managed-tilemap.gpu-fixture';

let url: string;
beforeAll(async () => {
  url = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
  );
}, 120_000);
afterAll(() => URL.revokeObjectURL(url));
it.each([
  ['local', 0],
  ['local', 1],
  ['worker', 0],
  ['worker', 1],
] as const)(
  'renders native Tilemap updates and recovery (%s, sort %s)',
  (mode, scope) => verifyRuntimeTilemap(mode, scope, url),
  120_000,
);
