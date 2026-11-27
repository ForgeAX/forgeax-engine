import { WebGPURenderer } from '@forgeax/engine/three';
import { afterAll, beforeAll, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  referenceModes,
  verifyMaterialReferences,
  verifyReferenceBoundaries,
} from './material-reference-inputs.fixture';
import { comparePrimitivePixels } from './node-family.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const core = import.meta.env.FORGEAX_CI_CORE_VALIDATION === '1';
let renderer: WebGPURenderer;

beforeAll(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  renderer = new WebGPURenderer({ canvas });
});
afterAll(async () => {
  await renderer?.dispose();
});

it.each(
  referenceModes,
)('matches independent r187 %s direct material references and per-material edits', {
  timeout: 120000,
}, async (mode) => {
  // Dawn replays all six captures. Keep independent browser pixels for
  // every mode and real browser replay for both an unlit and a lit surface.
  await verifyMaterialReferences(
    renderer,
    mode,
    async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-material-reference-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
      if (mode === 'dashed') comparePrimitivePixels(displayPixels(frame), reference, 128);
    },
    { replay: !core || mode === 'basic' || mode === 'physical' },
  );
});

it('rejects unsupported reference boundaries before publication and recovers on the browser', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const boundary = new WebGPURenderer({ canvas });
  try {
    await verifyReferenceBoundaries(boundary, async (name, frame, scene, camera) => {
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-material-reference-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  } finally {
    await boundary.dispose();
  }
});
