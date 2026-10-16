import { describe, expect, it } from 'vitest';
import {
  createExtendedLightingState,
  promoteExtendedLightingCandidate,
} from '../prepare/extended-lighting/state';

describe('extended lighting zero-feature integration', () => {
  it('keeps all extension allocations and graph work at exact zero', () => {
    const state = createExtendedLightingState(1);

    expect(state.enabled).toBe(false);
    expect(promoteExtendedLightingCandidate(state, undefined)).toEqual(state);
  });
});
