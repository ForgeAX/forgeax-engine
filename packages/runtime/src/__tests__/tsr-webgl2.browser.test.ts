import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyTsrRenderer } from './tsr-renderer.fixture';

it('runs TSR and mixed TAA views through real WebGL2, sixty-frame histories and fresh-device replay', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  const replayCanvas = document.createElement('canvas');
  canvas.width = canvas.height = replayCanvas.width = replayCanvas.height = 64;
  document.body.append(canvas, replayCanvas);
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  try {
    await verifyTsrRenderer(
      canvas,
      '/shaders/manifest.json',
      async (name, bytes) => {
        if (typeof bytes === 'string') {
          await commands.writeFile(`artifacts/ci-focus/temporal-aa/${name}`, bytes);
        } else {
          let binary = '';
          for (let start = 0; start < bytes.length; start += 8192)
            binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
          await commands.writeFile(
            `artifacts/ci-focus/temporal-aa/${name}`,
            btoa(binary),
            'base64',
          );
        }
      },
      'forward',
      wgpu,
      replayCanvas,
    );
  } finally {
    if (saved) Object.defineProperty(navigator, 'gpu', saved);
    else Reflect.deleteProperty(navigator, 'gpu');
    canvas.remove();
    replayCanvas.remove();
  }
});
