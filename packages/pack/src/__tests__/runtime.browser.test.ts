import { parsePackV2 } from '@forgeax/engine-pack/runtime';
import { describe, expect, it } from 'vitest';

describe('Pack runtime entry', () => {
  it('parses a Pack v2 envelope in a browser without the Node scanner barrel', () => {
    const result = parsePackV2({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      packageId: 'browser-runtime',
      assets: [],
    });

    expect(result.ok).toBe(true);
  });
});
