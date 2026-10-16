import { it } from 'vitest';
import { verifyParticleRasterCoalescing } from './particle-pass-order.fixture';

it(
  'preserves particle alpha pixels and order when raster passes are coalesced',
  verifyParticleRasterCoalescing,
  60_000,
);
