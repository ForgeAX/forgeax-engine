import { mkdirSync, writeFileSync } from 'node:fs';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyMultiCameraVfx } from './multi-camera-vfx.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

// The Browser carrier owns the matching publication journey.
it('simulates shared World VFX and replays two Dawn camera views', {
  timeout: 180_000,
}, async () => {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: 128,
    height: 64,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        texture?.destroy();
        texture = config.device.createTexture({
          size: [128, 64],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      getCurrentTexture: () => texture,
      unconfigure() {},
    }),
  };
  const directory = 'artifacts/multi-camera/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyMultiCameraVfx({
      canvas,
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()),
      publication: false,
      warmupFrames: process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 12 : 60,
      cook: cookParticleCodeEffect,
      save: (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
    });
  } finally {
    texture?.destroy();
  }
});
