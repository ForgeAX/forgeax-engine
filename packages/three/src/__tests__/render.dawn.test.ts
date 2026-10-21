import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { verifyOutput } from './output.fixture';
import { SIZE, verifyRender } from './render.fixture';

it('submits 60 compatibility frames and replays them on a fresh Dawn device', {
  timeout: 120000,
}, async () => {
  const url = shaderManifestUrl(await buildEngineShaderManifest());
  const target = offscreenCanvas(SIZE);
  const renderer = new WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: { bundler: { shaderManifestUrl: url } },
  });
  try {
    await verifyRender(renderer);
    await verifyOutput(renderer);
  } finally {
    await renderer.dispose();
    target.destroy();
  }
});
