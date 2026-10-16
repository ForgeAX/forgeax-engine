import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // Three entries: main surface (index) + the pure controller-db parser +
  // the lazily-imported 554KB vendored data (M3 D-2). The data entry is a
  // separate chunk so the 554KB txt never enters dist/index.mjs.
  entry: ['src/index.ts', 'src/controller-db.ts', 'src/controller-db-data.ts'],
  // esbuild text loader inlines the vendored gamecontrollerdb.txt as a
  // string into dist/controller-db-data.mjs (M3 D-2 step 2).
  loader: { '.txt': 'text' },
  // M3 D-2: keep the lazily-imported controller-db sub-exports OUT of the
  // main-entry bundle. browser-backend.ts uses the package self-reference
  // specifiers `@forgeax/engine-input/controller-db{,-data}` in a dynamic
  // import(); without marking them external esbuild would inline the 554KB
  // parser + data back into dist/index.mjs, defeating the lazy-load.
  external: ['@forgeax/engine-input/controller-db', '@forgeax/engine-input/controller-db-data'],
});
