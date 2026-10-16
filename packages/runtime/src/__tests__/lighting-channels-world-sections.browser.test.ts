import { it } from 'vitest';
import { runChannelBrowserCase } from './lighting-channels-browser.fixture';

it('matches channels through world with sections in both browser paths', {
  timeout: 300_000,
}, async () => {
  await runChannelBrowserCase('world', 'sections', 'both');
});
