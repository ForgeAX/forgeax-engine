import { describe, expect, it } from 'vitest';
import { assertAtomicPatchSnapshot } from '../../scripts/smoke-diagnostics.mjs';

describe('Boss Lightning atomic patch falsifier', () => {
  it('rejects a snapshot with a partial generation', () => {
    expect(() =>
      assertAtomicPatchSnapshot({
        before: { generation: 4, payload: [1, 2, 3] },
        after: { generation: 5, payload: [1, 9, 3] },
      }),
    ).toThrow(/atomic/);
  });

  it('accepts a complete fixed-tick generation', () => {
    expect(() =>
      assertAtomicPatchSnapshot({
        before: { generation: 4, payload: [1, 2, 3] },
        after: { generation: 5, payload: [8, 7, 6] },
      }),
    ).not.toThrow();
  });
});
