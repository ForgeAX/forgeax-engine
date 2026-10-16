import { describe, expect, it, vi } from 'vitest';

import { createUiInputResetBoundary } from '../ui-ownership';

describe('UI input reset boundary', () => {
  it('clears a held key when ownership enters the UI', () => {
    const clear = vi.fn();
    const boundary = createUiInputResetBoundary({ clear });

    boundary.reset();
    expect(clear).toHaveBeenCalledTimes(1);
    boundary.dispose();
  });

  it('resets from an abort signal exactly once', () => {
    const clear = vi.fn();
    const controller = new AbortController();
    const boundary = createUiInputResetBoundary({ clear, signal: controller.signal });

    controller.abort();
    controller.abort();
    expect(clear).toHaveBeenCalledTimes(1);
    boundary.dispose();
  });
});
