import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

const facade = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    materials: 'src/generated/materials.mjs',
    'addons/controls/OrbitControls': 'src/addons/controls/OrbitControls.ts',
    'addons/loaders/GLTFLoader': 'src/addons/loaders/GLTFLoader.ts',
  },
  splitting: true,
  noExternal: [/^three(?:\/|$)/],
  esbuildPlugins: [
    {
      name: 'three-cpu-identity',
      setup(build) {
        // Addons and the facade must share source constructors, never the separate upstream bundle.
        build.onResolve({ filter: /^three$/ }, () => ({ path: facade }));
      },
    },
  ],
});
