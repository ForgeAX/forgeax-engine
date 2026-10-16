import { describe, expect, test } from 'vitest';
import * as publicSurface from '../index';

describe('gltf public surface', () => {
  test('keeps parser/importer front doors without a version mirror', () => {
    expect(typeof publicSurface.parseGltf).toBe('function');
    expect(typeof publicSurface.gltfImporter).toBe('object');
    expect('GLTF_PACKAGE_VERSION' in publicSurface).toBe(false);
  });
});
