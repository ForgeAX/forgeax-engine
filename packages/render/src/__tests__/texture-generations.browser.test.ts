import { it } from 'vitest';
import { verifyTextureGenerations } from './texture-generations.gpu-fixture';

it(
  'samples and replays independent generations of a recycled texture slot',
  verifyTextureGenerations,
  60_000,
);
