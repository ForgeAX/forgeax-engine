import { describe, expect, test } from 'vitest';
import * as publicSurface from '../index.js';

describe('shader public surface', () => {
  test('keeps the runtime registry without a version mirror', () => {
    expect(typeof publicSurface.ShaderRegistry).toBe('function');
    expect('SHADER_PACKAGE_VERSION' in publicSurface).toBe(false);
  });
});
