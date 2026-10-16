import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    rapier3d: 'src/rapier3d.ts',
  },
  external: [
    // rapier3d.ts is a preset for this package's root entry.  Keep the
    // self-reference external so both entrypoints share one component-token
    // module instance at runtime instead of inlining components.ts twice.
    '@forgeax/engine-physics',
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-types',
    '@forgeax/engine-plugin',
    '@forgeax/engine-scene',
    // physicsPlugin dynamic-imports these on build; keep them external so the
    // interface package stays a thin shell and the rapier WASM backends load
    // lazily (D-5). Bundling them would bloat physics to several MB and defeat
    // the lazy-load contract.
    '@forgeax/engine-physics-rapier2d',
    '@forgeax/engine-physics-rapier3d',
  ],
});
