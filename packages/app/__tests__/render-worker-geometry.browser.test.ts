import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';

it.each(['instances', 'points', 'lines'])(
  'renders, updates, and recovers %s across the publication boundary',
  verifyRenderWorkerContent,
  360_000,
);
