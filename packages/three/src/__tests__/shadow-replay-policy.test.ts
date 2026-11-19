import { expect, it } from 'vitest';
import { shouldReplayAuthoredShadow } from './shadow-replay-policy.fixture';

const states = [
  'default',
  'cast-off',
  'receive-off',
  'camera-moved',
  'authored',
  'target',
  'basic',
  'pcf-soft',
  'rectangular-soft',
  'rectangular-vogel',
  'shadow-layer-only',
  'shadow-layer-inherit',
  'shadow-layer-bit31',
  'variance',
  'variance-receiver-casts',
  'variance-caster-off',
  'variance-one-sample',
  'variance-wide',
];

it('retains fourteen daily fresh-device replays and all eighteen full-profile states', () => {
  const core = states.filter((state) => shouldReplayAuthoredShadow(state, true));
  expect(core).toHaveLength(14);
  expect(states.filter((state) => !core.includes(state))).toEqual([
    'camera-moved',
    'target',
    'shadow-layer-bit31',
    'variance-receiver-casts',
  ]);
  expect(states.filter((state) => shouldReplayAuthoredShadow(state))).toEqual(states);
});

it('keeps every newly added shadow state and every distinct filter/shape replay by default', () => {
  for (const name of [
    'new-shadow-owner',
    'basic',
    'pcf-soft',
    'rectangular-soft',
    'rectangular-vogel',
    'variance-one-sample',
    'variance-wide',
  ]) {
    expect(shouldReplayAuthoredShadow(name, true)).toBe(true);
  }
});
