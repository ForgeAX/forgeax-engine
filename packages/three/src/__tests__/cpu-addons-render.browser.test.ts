import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyAddonGallery, verifySceneDecomposition } from './cpu-addons-render.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it('verifyAddonGallery on browser', { timeout: 120000 }, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyAddonGallery(renderer, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-cpu-addons-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await renderer.dispose();
  }
});
it('verifySceneDecomposition on browser', { timeout: 120000 }, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifySceneDecomposition(renderer, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-cpu-addons-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await renderer.dispose();
  }
});
