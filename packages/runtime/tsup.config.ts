import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  splitting: true,
  entry: [
    'src/index.ts',
    'src/dev-import-transport.ts',
    'src/geometry/index.ts',
    'src/renderer-host.ts',
    'src/shader-publication.ts',
    'src/tasks.ts',
    'src/water-buoyancy-solver.ts',
  ],
  external: [
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-pack',
    // Preserve the backend package boundary. rhi-wgpu owns the lazy wasm
    // import, and engine-wgpu-wasm owns the physical sibling `pkg/` asset.
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-rhi-wgpu',
  ],
});
