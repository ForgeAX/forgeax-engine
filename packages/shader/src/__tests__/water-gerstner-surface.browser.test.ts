import { it } from 'vitest';
import { verifyWaterGerstnerSurface } from './water-gerstner-surface-gpu.fixture';

it(
  'samples the shared Gerstner geometry and rejects unsupported sources in the browser GPU',
  verifyWaterGerstnerSurface,
);
