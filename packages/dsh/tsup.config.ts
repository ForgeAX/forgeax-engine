import { defineConfig } from 'tsup';

import { baseTsupConfig } from '../../config/tsup.base';

const packageId = '@forgeax/engine-dsh';

export default defineConfig([
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: {
      index: 'src/index.ts',
      'engine-host': 'src/engine-host.ts',
      'engine-preview': 'src/engine-preview.ts',
      intelligence: 'src/intelligence.ts',
      protocol: 'src/protocol.ts',
      embedded: 'src/embedded.ts',
    },
    external: [
      '@forgeax/engine-ecs',
      '@forgeax/engine-intelligence',
      '@forgeax/engine-plugin',
      '@forgeax/engine-types',
    ],
  },
  {
    ...baseTsupConfig,
    platform: 'browser',
    format: ['cjs'],
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    dts: false,
    clean: false,
    treeshake: false,
    external: ['react', 'react/jsx-runtime'],
    noExternal: [],
    outExtension: () => ({ js: '.js' }),
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
    },
    footer: { js: 'return module.exports; } });' },
    esbuildOptions(options) {
      options.banner = {
        ...options.banner,
        js: `${options.banner?.js ?? ''}\nvar module = { exports: {} }; var exports = module.exports;`,
      };
    },
  },
]);
