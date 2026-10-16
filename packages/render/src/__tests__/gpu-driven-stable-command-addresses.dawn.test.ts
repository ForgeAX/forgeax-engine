import { it } from 'vitest';
import { stableCommandAddressFrames } from './gpu-driven-stable-command-addresses-fixture';

it(
  'consumes sparse surviving windows through growth, reuse and three view projections for 60 submissions',
  stableCommandAddressFrames,
);
