import { expect, it } from 'vitest';
import { shouldReplayAuthoredShadow } from './shadow-replay-policy.fixture';

const states = [
  'default',
  'cast-off',
  'receive-off',
  'camera-moved',
  'authored',
  'basic',
  'rectangular-soft',
  'shadow-layer-only',
  'shadow-layer-inherit',
  'shadow-layer-bit31',
];

it('retains eight daily fresh-device replays and all ten directional states', () => {
  const core = states.filter((state) => shouldReplayAuthoredShadow(state, true));
  expect(core).toHaveLength(8);
  expect(states.filter((state) => !core.includes(state))).toEqual([
    'camera-moved',
    'shadow-layer-bit31',
  ]);
  expect(states.filter((state) => shouldReplayAuthoredShadow(state))).toEqual(states);
});

it('keeps every newly added shadow state and every distinct filter/shape replay by default', () => {
  for (const name of ['new-shadow-owner', 'basic', 'pcf-soft', 'rectangular-soft']) {
    expect(shouldReplayAuthoredShadow(name, true)).toBe(true);
  }
});
