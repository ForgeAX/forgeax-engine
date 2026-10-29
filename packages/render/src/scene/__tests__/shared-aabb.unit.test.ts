import { describe, expect, it } from 'vitest';
import { sharedAabb } from '../shared-aabb';

describe('sharedAabb', () => {
  it('shares one copy per source and re-copies after an in-place rewrite', () => {
    const source = [0, 0, 0, 1, 1, 1];
    const first = sharedAabb(source);
    expect(sharedAabb(source)).toBe(first);
    expect(sharedAabb(first)).toBe(first);
    source[3] = 2;
    const second = sharedAabb(source);
    expect(second).not.toBe(first);
    expect([...first]).toEqual([0, 0, 0, 1, 1, 1]);
    expect([...second]).toEqual([0, 0, 0, 2, 1, 1]);
  });
});
