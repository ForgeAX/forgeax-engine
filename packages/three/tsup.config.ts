import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

const core = fileURLToPath(import.meta.resolve('three/src/Three.Core.js'));
const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> };
const addons = Object.fromEntries(
  Object.keys(manifest.exports)
    .filter((path) => path.startsWith('./addons/') && path.endsWith('.js'))
    .map((path) => {
      const entry = path.slice(2, -3);
      return [entry, `src/${entry}.ts`];
    }),
);

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    tsl: 'src/tsl.ts',
    materials: 'src/generated/materials.mjs',
    physical: 'src/generated/physical.mjs',
    'build/index': 'src/build/materials.ts',
    ...addons,
  },
  splitting: true,
  external: [/^@forgeax\/engine-/],
  noExternal: [/^three(?:\/|$)/],
  esbuildPlugins: [
    {
      name: 'three-cpu-identity',
      setup(build) {
        // Addons and the facade must share source constructors, never the facade runtime or a separate upstream bundle.
        build.onResolve({ filter: /^three$/ }, () => ({ path: core }));
      },
    },
  ],
});
