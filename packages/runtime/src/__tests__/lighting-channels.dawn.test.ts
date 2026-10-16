import { it } from 'vitest';
import { runChannelDawnCase } from './lighting-channels-dawn.fixture';

// Browser owns these World receivers. Dawn owns their published counterparts;
// each retains Forward/Deferred pixels, capture and fresh-device falsification.
it.each([
  'sections',
  'instances',
  'transparent',
  'physical',
] as const)('matches published %s lighting channels on Dawn', {
  timeout: 300_000,
}, async (receiver) => {
  await runChannelDawnCase('publication', receiver, 'both');
});
