import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/geometry/index.ts', 'src/renderer-host.ts'],
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
