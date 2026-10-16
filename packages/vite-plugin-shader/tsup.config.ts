import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // index main entry re-exports the wrap helper; tsup walks the dependency graph and auto-compiles submodules.
  // source-digest is also emitted standalone (node builtins only) so the release producer script can
  // record profile provenance without loading the compiler graph.
  entry: { index: 'src/index.ts', 'source-digest': 'src/engine-inputs/source-digest.ts', 'prepare-engine-shader-source': 'src/engine-inputs/prepare-engine-shader-source.ts' },
  // Same target as @forgeax/engine-shader-compiler (top-level await wasm loading, plan-strategy §S-5).
  target: 'esnext',
  external: ['@forgeax/engine-shader-compiler', '@forgeax/engine-types', 'vite', 'rollup'],
});
