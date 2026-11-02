import { describe, expect, it } from 'vitest';
import { TS_KERNEL_DIGEST } from '../compute/kernel-digest';
import { environmentOf } from '../tools/environment';

describe('tool environment', () => {
  it('names the kernel build the report ran on', () => {
    expect(environmentOf()).toEqual({ kernel: TS_KERNEL_DIGEST });
  });
});
