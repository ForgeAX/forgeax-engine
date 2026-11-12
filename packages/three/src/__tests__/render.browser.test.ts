import { WebGPURenderer } from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';
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
  let sequence = 0;
  const measure = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const index = ++sequence;
    const started = performance.now();
    // biome-ignore lint/suspicious/noConsole: Preserve bounded native CI phase receipts.
    console.info('[three-render-phase]', JSON.stringify({ index, phase, state: 'start' }));
    try {
      return await work();
    } finally {
      // biome-ignore lint/suspicious/noConsole: Preserve bounded native CI phase receipts.
      console.info(
        '[three-render-phase]',
        JSON.stringify({ index, phase, state: 'end', milliseconds: performance.now() - started }),
      );
    }
  };
  const captureFrame = renderer.captureFrame.bind(renderer);
  vi.spyOn(renderer, 'captureFrame').mockImplementation((...args) =>
    measure('capture', () => captureFrame(...args)),
  );
  try {
    expect(() => renderer.render(undefined as never, undefined as never)).toThrow(
      'renderer-not-ready',
    );
    await verifyRender(
      renderer,
      (...args) => measure('oracle', () => renderReference(...args)),
      (...args) => measure(`evidence:${args[0]}`, () => saveBrowserEvidence(...args)),
    );
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
