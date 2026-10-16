import { describe, expect, it } from 'vitest';

import { assertCurrentSourceContentKey } from '../provenance.mjs';

describe('wgpu-wasm provenance source identity', () => {
  it('accepts a bundle whose source key matches the current key', () => {
    expect(() =>
      assertCurrentSourceContentKey(
        { sourceContentKey: 'sha256-current' },
        'sha256-current',
      ),
    ).not.toThrow();
  });

  it('rejects a self-consistent bundle whose source key is stale', () => {
    expect(() =>
      assertCurrentSourceContentKey(
        { sourceContentKey: 'sha256-old' },
        'sha256-current',
      ),
    ).toThrow(
      'provenance sourceContentKey does not match current source content key ' +
        '(manifest=sha256-old; current=sha256-current)',
    );
  });
});
