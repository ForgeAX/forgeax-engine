import { it } from 'vitest';
import { verifyRasterBatchPixels } from './forward-raster-batching.fixture';

it.each([1, 4] as const)(
  'preserves depth/coverage/blend pixels across raster batching (samples=%s)',
  verifyRasterBatchPixels,
);
