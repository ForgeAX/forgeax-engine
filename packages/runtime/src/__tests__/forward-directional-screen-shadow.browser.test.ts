import { it } from 'vitest';
import { verifyForwardScreenShadow } from './forward-directional-screen-shadow.fixture';

it('projects Forward sun visibility on Chromium WebGPU', { timeout: 180_000 }, () =>
  verifyForwardScreenShadow('automatic'),
);
