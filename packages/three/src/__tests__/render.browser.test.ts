import { WebGPURenderer } from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { SIZE, verifyRender } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it('runs 60 native frames, matches original Three and replays its actual GPU capture', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new WebGPURenderer({ canvas });
  try {
    expect(() => renderer.render(undefined as never, undefined as never)).toThrow(
      'renderer-not-ready',
    );
    await verifyRender(renderer, renderReference, saveBrowserEvidence);
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
  await expect(renderer.init()).rejects.toMatchObject({ code: 'renderer-disposed' });
});

it('disposes safely while initialization is still pending', { timeout: 30000 }, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new WebGPURenderer({ canvas });
  await renderer.dispose();
  await expect(renderer.init()).rejects.toMatchObject({ code: 'renderer-disposed' });
  await renderer.dispose();
});
