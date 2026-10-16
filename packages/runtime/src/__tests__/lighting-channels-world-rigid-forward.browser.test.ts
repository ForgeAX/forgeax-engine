import { it } from 'vitest';
import { runChannelBrowserCase } from './lighting-channels-browser.fixture';

it('matches and replays world rigid forward channels in browser WebGPU', {
  timeout: 300_000,
}, async () => {
  await runChannelBrowserCase('world', 'rigid', 'forward');
});
