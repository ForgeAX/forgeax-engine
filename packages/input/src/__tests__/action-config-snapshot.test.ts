import { describe, expect, it } from 'vitest';
import { type ActionConfig, deriveActionStates } from '../action-state';
import { createEmptyInputBackendSample, snapshotFromSample } from '../input-snapshot';

describe('action configuration at frame sampling', () => {
  it('keeps the sampled radial deadzone when author configuration changes before the next frame', () => {
    const config = {
      action: 'right',
      bindings: [{ type: 'key' as const, key: 'd' }],
      deadzone: 0.25,
    };
    const inputMap: ActionConfig[] = [config];
    const states = deriveActionStates(
      { ...createEmptyInputBackendSample(), downKeys: new Set(['d']) },
      inputMap,
    );
    // A half-strength analog observation makes the radial remapping observable.
    const sampled = states.map((state) => ({ ...state, raw: 0.5 }));
    const snapshot = snapshotFromSample(createEmptyInputBackendSample(), sampled);
    const before = snapshot.getVector('left', 'right', 'up', 'down');
    config.deadzone = 0.9;
    expect(snapshot.getVector('left', 'right', 'up', 'down')).toEqual(before);
    const nextStates = deriveActionStates(createEmptyInputBackendSample(), inputMap).map(
      (state) => ({ ...state, raw: 0.5 }),
    );
    const next = snapshotFromSample(createEmptyInputBackendSample(), nextStates);
    expect(next.getVector('left', 'right', 'up', 'down')).not.toEqual(before);
  });
});
