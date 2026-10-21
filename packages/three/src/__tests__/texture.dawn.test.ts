import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { verifyFlatShading } from './flat-shading.fixture';
import { SIZE } from './render.fixture';
import { verifyTextures } from './texture.fixture';

it.each([
  ['textures', verifyTextures],
  ['flat shading', verifyFlatShading],
] as const)(
  'runs material inputs and replay after sixty completed Dawn frames: %s',
  {
    timeout: 120000,
  },
  async (_name, verify) => {
    const target = offscreenCanvas(SIZE);
    const renderer = new WebGPURenderer({
      canvas: target.canvas as unknown as OffscreenCanvas,
      forgeax: {
        bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
      },
    });
    try {
      await verify(renderer);
    } finally {
      await renderer.dispose();
      target.destroy();
    }
  },
);
