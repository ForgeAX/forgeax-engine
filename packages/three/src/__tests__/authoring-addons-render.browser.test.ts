import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { verifyAuthoringGallery } from './authoring-addons-render.fixture';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it('verifyAuthoringGallery on browser', { timeout: 120000 }, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyAuthoringGallery(renderer, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-authoring-addons-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await renderer.dispose();
  }
});
