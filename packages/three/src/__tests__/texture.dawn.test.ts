import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { observeNativeDeviceRequests } from '../../../runtime/src/__tests__/native-device-work.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { flatShadingMaterialTypes, verifyFlatShading } from './flat-shading.fixture';
import { SIZE } from './render.fixture';
import { verifyTextures } from './texture.fixture';

const nativeDevices = observeNativeDeviceRequests();
async function createTextureRenderer() {
  const target = offscreenCanvas(SIZE);
  const renderer = new WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  return { target, renderer };
}
let sharedRenderer: ReturnType<typeof createTextureRenderer> | undefined;
afterAll(async () => {
  try {
    if (sharedRenderer !== undefined) {
      const { target, renderer } = await sharedRenderer;
      await renderer.dispose();
      target.destroy();
    }
    nativeDevices.assertMaximum(10);
  } finally {
    nativeDevices.restore();
  }
});

it('runs texture inputs and replay after sixty completed Dawn frames', {
  timeout: 120000,
}, async () => {
  sharedRenderer ??= createTextureRenderer();
  const { renderer } = await sharedRenderer;
  await verifyTextures(renderer);
});

it.each(
  flatShadingMaterialTypes,
)('runs flat shading %s inputs and replay after sixty completed Dawn frames', {
  timeout: 120000,
}, async (materialType) => {
  sharedRenderer ??= createTextureRenderer();
  const { renderer } = await sharedRenderer;
  await verifyFlatShading(renderer, undefined, undefined, materialType);
});
