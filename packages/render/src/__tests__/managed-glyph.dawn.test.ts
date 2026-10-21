import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, beforeAll, it } from 'vitest';
import { verifyRuntimeGlyph } from './managed-glyph.gpu-fixture';

let url: string;
beforeAll(async () => {
  url = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest())], { type: 'application/json' }),
  );
}, 120_000);
afterAll(() => URL.revokeObjectURL(url));
it.each(['local', 'worker'] as const)(
  'renders native Font edits and recovery (%s)',
  (mode) => verifyRuntimeGlyph(mode, url),
  120_000,
);
