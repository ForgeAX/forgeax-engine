import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { verifyAddonGallery, verifySceneDecomposition } from './cpu-addons-render.fixture';

it('verifyAddonGallery on dawn', { timeout: 120000 }, async () => {
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()) },
    },
  });
  try {
    await verifyAddonGallery(renderer, async () => {});
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});
it('verifySceneDecomposition on dawn', { timeout: 120000 }, async () => {
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()) },
    },
  });
  try {
    await verifySceneDecomposition(renderer, async () => {});
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});
