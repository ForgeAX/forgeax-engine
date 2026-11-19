import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import {
  verifyAnimationPath,
  verifyLegacySceneGallery,
  verifyStaticBatching,
} from './scene-format-addons-render.fixture';

it('verifyLegacySceneGallery on dawn', { timeout: 120000 }, async () => {
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  try {
    await verifyLegacySceneGallery(renderer, async () => {});
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});

it('verifyStaticBatching on dawn', { timeout: 120000 }, async () => {
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  try {
    await verifyStaticBatching(renderer, async () => {});
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});

it('verifyAnimationPath on dawn', { timeout: 120000 }, async () => {
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  try {
    await verifyAnimationPath(renderer, async () => {});
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});
