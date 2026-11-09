import { it } from 'vitest';
import { verifyTsrRenderer } from './tsr-renderer.fixture';

it.each([
  'forward',
  'deferred',
] as const)('renders sixty %s TSR frames on a Browser canvas with the same replay and lifecycle oracle as Dawn', {
  timeout: 240_000,
}, async (renderPath) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyTsrRenderer(canvas, undefined, undefined, renderPath);
  } finally {
    canvas.remove();
  }
});
