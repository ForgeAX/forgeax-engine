import * as THREE from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { exerciseOpaqueOrder } from './opaque-order.fixture';
import { SIZE } from './render.fixture';

it('preserves ordered opaque queues across native Dawn recording and replay', {
  timeout: 120000,
}, async () => {
  const target = offscreenCanvas(SIZE);
  const renderer = new THREE.WebGPURenderer({
    canvas: target.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  try {
    await renderer.init();
    await exerciseOpaqueOrder(renderer, async () => {});
  } finally {
    await renderer.dispose();
    target.destroy();
  }
});
