import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { verifyEagerTexture } from './eager-texture.fixture';
import { SIZE } from './render.fixture';

it('prepares textures without a hidden frame and replays their physical edits on Dawn', {
  timeout: 120000,
}, async () => {
  const url = shaderManifestUrl(await buildEngineShaderManifest());
  const target = offscreenCanvas(SIZE);
  const renderer = new WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: { bundler: { shaderManifestUrl: url } },
  });
  try {
    await verifyEagerTexture(renderer);
  } finally {
    await renderer.dispose();
    target.destroy();
  }
});
