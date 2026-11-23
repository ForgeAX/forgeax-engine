import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';

// Each route has a distinct publication owner. Lines, points, text and
// render targets have separate render-level tests without another Worker recovery.
it.each(['instances', 'environment', 'video', 'basis'])(
  'renders, updates, and recovers %s across the publication boundary',
  verifyRenderWorkerContent,
  360_000,
);
