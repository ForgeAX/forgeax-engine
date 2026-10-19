import { WebGLRenderer } from '@forgeax/engine/three';
import { WebGLRenderer as OriginalRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { SIZE, verifyRender } from './render.fixture';

it('runs 60 native frames, matches original Three and replays its actual GPU capture', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new WebGLRenderer({ canvas });
  const original = new OriginalRenderer({ preserveDrawingBuffer: true });
  original.setSize(SIZE, SIZE);
  try {
    expect(() => renderer.render(undefined as never, undefined as never)).toThrow(
      'renderer-not-ready',
    );
    await verifyRender(
      renderer,
      (scene, camera) => {
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
      saveBrowserEvidence,
    );
  } finally {
    await renderer.dispose();
    original.dispose();
    canvas.remove();
  }
  await expect(renderer.init()).rejects.toMatchObject({ code: 'renderer-disposed' });
});

it('disposes safely while initialization is still pending', { timeout: 30000 }, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new WebGLRenderer({ canvas });
  await renderer.dispose();
  await expect(renderer.init()).rejects.toMatchObject({ code: 'renderer-disposed' });
  await renderer.dispose();
});
