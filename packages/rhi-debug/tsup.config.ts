import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // The root RHI-debug entry is consumed directly by browser Engine App
  // modules. Bundle its CommonJS codec dependency so native-ESM Vite hosts do
  // not have to resolve pako through a host-specific optimizer boundary.
  noExternal: ['pako'],
  entry: [
    'src/index.ts',
    'src/browser.ts',
  ],
  external: [
    '@forgeax/engine-rhi',
    '@forgeax/engine-types',
    '@webgpu/types',
    // Backend packages remain optional peer implementations and are not bundled.
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-rhi-wgpu',
  ],
});
