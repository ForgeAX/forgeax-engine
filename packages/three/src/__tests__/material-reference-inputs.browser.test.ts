import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  referenceModes,
  verifyMaterialReferences,
  verifyReferenceBoundaries,
} from './material-reference-inputs.fixture';
import { comparePrimitivePixels } from './node-family.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it.each(
  referenceModes,
)('matches independent r187 %s direct material references and per-material edits', {
  timeout: 120000,
}, async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyMaterialReferences(renderer, mode, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-material-reference-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
      if (mode === 'dashed') comparePrimitivePixels(displayPixels(frame), reference, 128);
    });
  } finally {
    await renderer.dispose();
  }
});

it('rejects unsupported reference boundaries before publication and recovers on the browser', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyReferenceBoundaries(renderer, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-material-reference-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await renderer.dispose();
  }
});
