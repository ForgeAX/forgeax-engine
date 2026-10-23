import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // index main entry re-exports the wrap helper; tsup walks the dependency graph and auto-compiles submodules.
  // source-digest and packaged-profiles are also emitted standalone (node builtins only) so release
  // scripts can record provenance and read the packaged container without loading the compiler graph.
  entry: { index: 'src/index.ts', 'source-digest': 'src/engine-inputs/source-digest.ts', 'prepare-engine-shader-source': 'src/engine-inputs/prepare-engine-shader-source.ts', 'packaged-profiles': 'src/engine-inputs/packaged-profiles.ts' },
  // Same target as @forgeax/engine-shader-compiler (top-level await wasm loading, plan-strategy §S-5).
  target: 'esnext',
  external: ['@forgeax/engine-shader-compiler', '@forgeax/engine-types', 'vite', 'rollup'],
});
