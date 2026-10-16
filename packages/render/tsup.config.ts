import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: [
    'src/index.ts',
    'src/authoring.ts',
    'src/internal.ts',
    'src/temporal/index.ts',
    'src/construct-renderer.ts',
  ],
  splitting: true,
  // Keep ECS/math identity shared with host worlds. Bundling a second ECS
  // copy makes component tokens incomparable and manifests as a silent
  // render-system-no-camera failure in real app consumers.
  external: [
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-pack',
    // Backend modules own process-local device registries (for example the
    // WebGPU RhiDevice -> GPUDevice reverse lookup used by lazy shader
    // compilation). Bundling a second copy makes an otherwise live device
    // appear unregistered when a custom material is compiled after boot.
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-rhi-wgpu',
  ],
});
