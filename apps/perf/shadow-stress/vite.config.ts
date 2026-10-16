import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader({ engineEntries: { pointShadows: true } }) as never],
  // The Dawn smoke runs this production bundle, so the opt-in PERF_RHI_CAPTURE
  // tape needs the recorder branch kept at build time.
  define: {
    'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify(
      process.env.FORGEAX_ENGINE_RHI_DEBUG === '1' ? '1' : '0',
    ),
  },
  server: {
    fs: { allow: [monorepoRoot] },
  },
  build: {
    target: 'esnext',
  },
});
