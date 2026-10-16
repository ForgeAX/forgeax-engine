import { it } from 'vitest';
import { runChannelBrowserCase } from './lighting-channels-browser.fixture';

it('matches and replays publication rigid deferred channels in browser WebGPU', {
  timeout: 300_000,
}, async () => {
  await runChannelBrowserCase('publication', 'rigid', 'deferred');
});
