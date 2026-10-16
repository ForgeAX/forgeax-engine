import { describe, expect, it } from 'vitest';
import { instantiateFlat } from '../../../assets-runtime/src/registry/instantiate';

describe('scene authoring bridge', () => {
  it('exposes the flat authoring entry without a runtime duplicate', () => {
    expect(typeof instantiateFlat).toBe('function');
  });
});
