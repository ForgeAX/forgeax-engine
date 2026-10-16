import { describe, expect, it, vi } from 'vitest';
import { validateArtifactPath } from '../artifact-path.js';

const context = {
  packageRoot: '/packages/hero',
  guid: '11111111-1111-4111-8111-111111111111',
  artifactKey: 'mesh',
};

describe('artifact locator validation', () => {
  it('accepts a normalized package-relative locator', () => {
    const result = validateArtifactPath('artifacts/hero.bin', context);

    expect(result).toEqual({ ok: true, value: 'artifacts/hero.bin' });
  });

  it.each([
    ['parent traversal', '../outside.bin'],
    ['encoded traversal', '%2e%2e%2foutside.bin'],
    ['double encoded traversal', '%252e%252e%252foutside.bin'],
    ['backslash traversal', '..\\outside.bin'],
    ['absolute POSIX path', '/tmp/outside.bin'],
    ['absolute Windows path', 'C:\\tmp\\outside.bin'],
    ['remote URL', 'https://example.test/outside.bin'],
  ])('rejects %s before any file read', (_label, locator) => {
    const readFile = vi.fn((_path: string) => new Uint8Array());
    const result = validateArtifactPath(locator, context);

    if (result.ok) {
      readFile(result.value);
    }

    expect(result.ok).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error.code).toBe('asset-artifact-path-invalid');
      expect(result.error.detail.guid).toBe(context.guid);
      expect(result.error.detail.artifactKey).toBe(context.artifactKey);
    }
  });
});
