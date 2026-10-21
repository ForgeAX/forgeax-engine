import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyOutput } from './output.fixture';
import { SIZE } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it.each([
  false,
  true,
])('matches mixed data/color materials, exposure and transparent blending (MSAA %s)', {
  timeout: 120000,
}, async (antialias) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new WebGPURenderer({ canvas, antialias });
  try {
    await verifyOutput(
      renderer,
      (scene, camera, mode, exposure) =>
        renderReference(scene, camera, { antialias, toneMapping: mode, exposure }),
      (name, capture, expected) =>
        saveBrowserEvidence(`${name}-${antialias ? 'msaa' : 'single'}`, capture, expected),
    );
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
});
