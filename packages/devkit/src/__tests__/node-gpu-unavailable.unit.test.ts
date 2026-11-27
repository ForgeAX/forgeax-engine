import { describe, expect, it } from 'vitest';
import { dawnUnavailable } from '../node-gpu';

describe('dawnUnavailable', () => {
  it('preserves the load error and reports the optional provider and tape-only alternatives', () => {
    const cause = "Cannot find package 'upstream-webgpu'";
    const result = dawnUnavailable(cause);
    expect(result.ok).toBe(false);
    expect(result.error.cause).toBe(cause);
    expect(result.error.hint).toContain('upstream-webgpu@npm:webgpu@0.6.2');
    expect(result.error.hint).toContain('forgeax rhi summary');
    expect(result.error.hint).toContain('pipeline and bindings');
  });
});
