import { describe, expect, it } from 'vitest';
import {
  deserializeColorResourceDescriptor,
  type ColorResourceDescriptor,
} from '../../../../../../packages/render-graph/src/index';

describe('transparency post color domain boundary', () => {
  it('requires an explicit domain even when the attachment format is LDR', () => {
    const descriptor = { format: 'rgba8unorm' } as unknown as ColorResourceDescriptor;
    const result = deserializeColorResourceDescriptor(descriptor);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a missing domain failure');
    expect(result.error.code).toBe('missing-color-domain');
    expect(result.error.hint).toContain('domain');
  });

  it('accepts a linear HDR destination independently of its texture format', () => {
    const descriptor: ColorResourceDescriptor = {
      domain: 'linear-hdr',
      format: 'rgba8unorm',
    };
    const result = deserializeColorResourceDescriptor(descriptor);
    expect(result).toEqual({ ok: true, value: descriptor });
  });
});
