import * as THREE from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyCanvasTarget } from './canvas-target.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
it('shares CanvasTarget state, renders resized output and preserves native surface ownership', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  await renderer.init();
  const widthWrites = vi.spyOn(renderer.domElement, 'width', 'set');
  const heightWrites = vi.spyOn(renderer.domElement, 'height', 'set');
  try {
    await verifyCanvasTarget(renderer, async (name, capture, size, scene, camera) => {
      if (name === 'initial') {
        expect(widthWrites).not.toHaveBeenCalled();
        expect(heightWrites).not.toHaveBeenCalled();
      }
      const reference = await renderReference(scene, camera, { width: size, height: size });
      comparePixels(displayPixels(capture), reference);
      await saveBrowserEvidence(`r187-canvas-${name}`, capture, reference);
    });
  } finally {
    widthWrites.mockRestore();
    heightWrites.mockRestore();
  }
  const selected = renderer.getCanvasTarget();
  const other = new THREE.CanvasTarget(document.createElement('canvas'));
  expect(() => renderer.setCanvasTarget(other)).toThrow('surface rebinding');
  expect(renderer.getCanvasTarget()).toBe(selected);
  other.dispose();
  const dispose = vi.fn();
  selected.addEventListener('dispose', dispose);
  await renderer.dispose();
  await renderer.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});
