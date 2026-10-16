import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';

it.each(['skin', 'morph'])(
  'renders, updates, and recovers %s across the publication boundary',
  verifyRenderWorkerContent,
  360_000,
);
