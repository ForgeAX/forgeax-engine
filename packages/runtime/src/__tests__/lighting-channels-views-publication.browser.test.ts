import { it } from 'vitest';
import { runLightingChannelViews } from './lighting-channels-views.browser.fixture';

it(
  'preserves lighting channels across browser independent views through publication',
  { timeout: 300_000 },
  () => runLightingChannelViews('publication'),
);
