import { describe, expect, it, vi } from 'vitest';

import { createUiInputResetBoundary } from '../ui-ownership';

describe('UI reset idempotence', () => {
  it('can be disposed and reset repeatedly without throwing', () => {
    const clear = vi.fn();
    const boundary = createUiInputResetBoundary({ clear });

    boundary.reset();
    boundary.dispose();
    boundary.dispose();
    boundary.reset();

    expect(clear).toHaveBeenCalledTimes(1);
  });
});
