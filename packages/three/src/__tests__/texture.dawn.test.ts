import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { observeNativeDeviceRequests } from '../../../runtime/src/__tests__/native-device-work.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { verifyFlatShading } from './flat-shading.fixture';
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

it.each([
  ['textures', verifyTextures],
  ['flat shading', verifyFlatShading],
] as const)(
  'runs material inputs and replay after sixty completed Dawn frames: %s',
  {
    timeout: 120000,
  },
  async (_name, verify) => {
    sharedRenderer ??= createTextureRenderer();
    const { renderer } = await sharedRenderer;
    await verify(renderer);
  },
);
