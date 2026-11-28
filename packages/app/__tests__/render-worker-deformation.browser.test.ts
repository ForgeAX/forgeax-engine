import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';

it(
  'renders, updates and recovers skin and morph independently on one publication',
  () => verifyRenderWorkerContent('deformation'),
  360_000,
);
