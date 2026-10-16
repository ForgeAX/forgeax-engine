import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyMultiCameraVfx } from './multi-camera-vfx.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('retains current native VFX work across two-view hidden, pause, resume and device retirement', {
  timeout: 180000,
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
  const directory = 'artifacts/new-author-dawn/vfx';
  mkdirSync(directory, { recursive: true });
  const prepared = process.env.FORGEAX_TEST_SHADER_MANIFEST;
  const url =
    prepared === undefined
      ? shaderManifestUrl(await buildEngineShaderManifest())
      : URL.createObjectURL(new Blob([readFileSync(prepared)], { type: 'application/json' }));
  try {
    await verifyMultiCameraVfx({
      canvas,
      shaderManifestUrl: url,
      publication: true,
      warmupFrames: 60,
      verifyVisibilityTransitions: true,
      cook: cookParticleCodeEffect,
      save: (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
    });
  } finally {
    texture?.destroy();
    if (prepared !== undefined) URL.revokeObjectURL(url);
  }
});
