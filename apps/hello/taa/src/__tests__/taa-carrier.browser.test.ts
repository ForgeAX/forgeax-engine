import { ANTIALIAS_TAA, Camera } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('hello-taa carrier', () => {
  it('uses the public Camera TAA front door', () => {
    expect(ANTIALIAS_TAA).toBe(3);
    expect(Camera.name).toBe('Camera');
  });
});
