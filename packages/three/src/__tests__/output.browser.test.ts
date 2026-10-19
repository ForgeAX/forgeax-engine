import { WebGLRenderer } from '@forgeax/engine/three';
import { WebGLRenderer as OriginalRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyOutput } from './output.fixture';
import { SIZE } from './render.fixture';

it.each([
  false,
  true,
])('matches mixed data/color materials, exposure and transparent blending (MSAA %s)', {
  timeout: 120000,
}, async (antialias) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new WebGLRenderer({ canvas, antialias });
  const original = new OriginalRenderer({ preserveDrawingBuffer: true, antialias });
  original.setSize(SIZE, SIZE);
  try {
    await verifyOutput(
      renderer,
      (scene, camera, mode, exposure) => {
        original.toneMapping = mode;
        original.toneMappingExposure = exposure;
        original.render(scene, camera);
        const gl = original.getContext();
        const bottomUp = new Uint8Array(SIZE * SIZE * 4);
        gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
        const pixels = new Uint8Array(bottomUp.length);
        for (let y = 0; y < SIZE; y++)
          pixels.set(
            bottomUp.subarray(y * SIZE * 4, (y + 1) * SIZE * 4),
            (SIZE - 1 - y) * SIZE * 4,
          );
        return pixels;
      },
      (name, capture, expected) =>
        saveBrowserEvidence(`${name}-${antialias ? 'msaa' : 'single'}`, capture, expected),
    );
  } finally {
    await renderer.dispose();
    original.dispose();
    canvas.remove();
  }
});
