import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { verifyVisibleSurfaceReplay } from './visible-surface-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
it('validates ordinary Renderer visible surfaces on Dawn with fresh-device replay', {
  timeout: 180_000,
}, async () => {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        texture?.destroy();
        texture = options.device.createTexture({
          size: [canvas.width, canvas.height],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => texture,
    }),
  };
  const dir =
    process.env.FORGEAX_RAY_EVIDENCE ??
    'artifacts/raytracing/iteration-01/renderer-visible-surface';
  mkdirSync(dir, { recursive: true });
  try {
    await verifyVisibleSurfaceReplay(
      canvas,
      (name, bytes) => {
        writeFileSync(`${dir}/${name}`, bytes);
      },
      manifest,
    );
  } finally {
    texture?.destroy();
  }
});
