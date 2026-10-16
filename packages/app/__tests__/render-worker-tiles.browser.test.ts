import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';

it.each(['tile-layer', 'tile-cell'])(
  'renders, updates, and recovers %s across the publication boundary',
  verifyRenderWorkerContent,
  360_000,
);
