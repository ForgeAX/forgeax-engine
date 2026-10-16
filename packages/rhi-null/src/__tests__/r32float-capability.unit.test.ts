import { describe, expect, it } from 'vitest';
import { RhiNullAdapter } from '../adapter';

describe('RhiNull r32float profile matrix', () => {
  it('returns structural-only evidence and never pixel admission', async () => {
    const adapter = new RhiNullAdapter();
    const deviceResult = await adapter.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;

    const receiptResult = await deviceResult.value.probeTextureFormatCapability();
    expect(receiptResult.ok).toBe(true);
    if (!receiptResult.ok) return;
    expect(receiptResult.value.verdict).toBe('structural-only');
    expect(receiptResult.value.evidence).toBe('structural');
    expect(receiptResult.value.readback).toBeUndefined();
  });
});
