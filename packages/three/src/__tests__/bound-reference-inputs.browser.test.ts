import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import {
  boundModes,
  verifyBoundaries,
  verifyBoundReferences,
} from './bound-reference-inputs.fixture';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePrimitivePixels } from './node-family.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it.each(
  boundModes,
)('matches independent r187 %s direct material references and per-material edits', {
  timeout: 120000,
}, async (mode) => {
  await verifyBoundReferences(rendererFor(), mode, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-bound-reference-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
    if (mode === 'userdata-dashed') comparePrimitivePixels(displayPixels(frame), reference, 128);
  });
});

it('rejects unsupported reference boundaries before publication and recovers on the browser', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyBoundaries(renderer, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-bound-reference-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await renderer.dispose();
  }
});
