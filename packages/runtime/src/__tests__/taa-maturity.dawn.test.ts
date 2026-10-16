import { it } from 'vitest';
import { quality } from './taa-maturity-quality.fixture';

it.skipIf(process.env.TAA_MATURITY !== 'quality')(
  'measures thin detail, phase stability, movement and cut recovery against spatial supersampling',
  { timeout: 240_000, retry: 0 },
  quality,
);
