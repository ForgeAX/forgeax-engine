import { createRenderer } from '@forgeax/engine-runtime';
import { it } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { verifySubsurface } from './subsurface.fixture';

// Dawn owns all three geometry paths; App owns skinned publication through
// both Worker layouts. Keep Browser's direct validation on the rigid fixture.
it('ordinary rigid SSS preserves emission and restores zero on Browser WebGPU', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const renderer = renderValue(await createRenderer(canvas));
  try {
    await verifySubsurface(renderer, 'rigid');
  } finally {
    await renderer.dispose();
  }
}, 180_000);
