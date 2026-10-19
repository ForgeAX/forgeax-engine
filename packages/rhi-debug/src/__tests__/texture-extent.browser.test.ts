import { it } from 'vitest';
import { verifyTextureExtent } from './texture-extent.fixture';

it.each([
  { size: [4] },
  { size: { width: 4 } },
])('round-trips omitted texture dimensions in the browser: %j', ({ size }) =>
  verifyTextureExtent(size));
