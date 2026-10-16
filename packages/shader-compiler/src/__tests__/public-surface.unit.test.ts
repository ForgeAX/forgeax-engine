import { describe, expect, test } from 'vitest';
import * as publicSurface from '../index.js';

describe('shader compiler public surface', () => {
  test('keeps the compiler front door without a version mirror', () => {
    expect(typeof publicSurface.compileShader).toBe('function');
    expect('SHADER_COMPILER_PACKAGE_VERSION' in publicSurface).toBe(false);
  });
});
