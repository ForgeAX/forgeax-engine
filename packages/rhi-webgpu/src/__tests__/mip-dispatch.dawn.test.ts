import { it } from 'vitest';
import { verifyMipDispatchChain } from './mip-dispatch.fixture';

it(
  'orders sampled and storage mip transitions between dispatches and frames',
  verifyMipDispatchChain,
);
