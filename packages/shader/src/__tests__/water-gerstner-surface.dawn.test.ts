import { it } from 'vitest';
import { verifyWaterGerstnerSurface } from './water-gerstner-surface-gpu.fixture';

it(
  'samples the draw geometry and accepted time in the pre-displacement Gerstner domain',
  verifyWaterGerstnerSurface,
);
