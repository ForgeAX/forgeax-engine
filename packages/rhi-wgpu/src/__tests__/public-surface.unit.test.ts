import { describe, expect, test } from 'vitest';
import * as publicSurface from '../index';

describe('rhi-wgpu public surface', () => {
  test('exposes one lazy-init front door without loader internals', () => {
    expect(typeof publicSurface.ensureReady).toBe('function');
    expect('ensureRhiWgpuReady' in publicSurface).toBe(false);
    expect('getRhiWgpuModule' in publicSurface).toBe(false);
  });
});
