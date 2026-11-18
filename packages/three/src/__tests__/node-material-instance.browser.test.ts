import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePrimitivePixels } from './node-family.fixture';
import {
  instanceModes,
  verifyInstanceBoundaries,
  verifyMaterialInstances,
} from './node-material-instance.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it.each(instanceModes)('matches independent r187 %s material instances and shared edits', {
  timeout: 120000,
}, async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyMaterialInstances(renderer, mode, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-material-instance-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
      if (mode === 'dashed') comparePrimitivePixels(displayPixels(frame), reference, 128);
    });
  } finally {
    await renderer.dispose();
  }
});

it('rejects unsupported instance boundaries before publication and recovers on the browser', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new WebGPURenderer({ canvas });
  try {
    await verifyInstanceBoundaries(renderer, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-material-instance-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await renderer.dispose();
  }
});
