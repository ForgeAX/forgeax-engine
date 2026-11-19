import { it } from 'vitest';
import { ensureReady, rhi } from '../../../rhi-wgpu/src/index';
import {
  FORWARD_RESOLVE_CASES,
  verifyForwardResolvePlacement,
} from './forward-resolve-placement.gpu-fixture';

it.each(
  FORWARD_RESOLVE_CASES.filter((options) => options.automatic),
)('preserves WebGL2 4x pixels and legal discard with $resolves resolves (reader=$reader empty=$empty conditional=$conditional imported=$imported)', async (options) => {
  await ensureReady();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  document.body.append(canvas);
  try {
    await verifyForwardResolvePlacement(rhi, options, canvas);
  } finally {
    canvas.remove();
  }
});
