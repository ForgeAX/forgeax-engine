import { it } from 'vitest';
import { runLightingChannelViews } from './lighting-channels-views.browser.fixture';

it(
  'preserves lighting channels across browser independent views through world',
  { timeout: 300_000 },
  () => runLightingChannelViews('world'),
);
