import { it } from 'vitest';
import { verifyBrowserMultiCamera } from './multi-camera-browser.fixture';

it(
  'composes independent camera views and replays Browser WebGPU through publication',
  {
    timeout: 180_000,
  },
  () => verifyBrowserMultiCamera('publication'),
);
