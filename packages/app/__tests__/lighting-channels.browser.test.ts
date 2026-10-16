import { it } from 'vitest';
import { verifyRenderWorkerContent } from './render-worker-content.fixture';

it('preserves high-bit selective light through Engine/Render Worker mutation and replacement', {
  timeout: 360_000,
}, async () => verifyRenderWorkerContent('lighting-channels'));
