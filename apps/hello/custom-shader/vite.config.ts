import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const semanticPackPath = process.env.FORGEAX_CUSTOM_SHADER_SEMANTIC_PACK_PATH;
const semanticFixturePath = process.env.FORGEAX_CUSTOM_SHADER_SEMANTIC_FIXTURE_PATH;

// hello-custom-shader vite config: compile the shader and serve the authored
// pack through the same catalog path used by a shipped app.
export default defineConfig({
  plugins: [
    ...(semanticPackPath === undefined
      ? []
      : [
          {
            name: 'forgeax-semantic-pack-import',
            enforce: 'pre' as const,
            resolveId(source: string) {
              if (source.startsWith('../assets/pulse-material.pack.json')) {
                return `${semanticPackPath}?url`;
              }
              return undefined;
            },
          },
        ]),
    forgeaxShader({ materialPackages: [resolve(here, 'src/pulse-material.shader.pack.json')] }) as never,
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('hello-custom-shader'),
      roots: [
        resolve(here, 'assets'),
        ...(semanticFixturePath === undefined ? [] : [semanticFixturePath]),
      ],
      refresh: reloadAssetHost(),
    }) as never,
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  resolve:
    semanticPackPath === undefined
      ? undefined
      : {
          alias: [
            {
              find: '../assets/pulse-material.pack.json',
              replacement: semanticPackPath,
            },
            {
              find: resolve(here, 'assets/pulse-material.pack.json'),
              replacement: semanticPackPath,
            },
          ],
        },
});
