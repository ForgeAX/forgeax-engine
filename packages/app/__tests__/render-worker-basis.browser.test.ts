import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';
it('lazily transcodes encoded assets, updates, and recovers through real Engine and Render Workers', () => verifyRenderWorkerContent('basis'), 360_000);
