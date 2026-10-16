import { describe, expect, it } from 'vitest';
import { RhiNullAdapter } from '../adapter';

describe('RhiNull r32float probe generation budget', () => {
  it('reports one structural probe per replacement device generation', async () => {
    const firstResult = await new RhiNullAdapter().requestDevice();
    const replacementResult = await new RhiNullAdapter().requestDevice();
    expect(firstResult.ok).toBe(true);
    expect(replacementResult.ok).toBe(true);
    if (!firstResult.ok || !replacementResult.ok) return;

    const first = await firstResult.value.probeTextureFormatCapability();
    const replacement = await replacementResult.value.probeTextureFormatCapability();
    expect(first.ok).toBe(true);
    expect(replacement.ok).toBe(true);
    if (!first.ok || !replacement.ok) return;
    expect(first.value.verdict).toBe('structural-only');
    expect(first.value.probeExecutions).toBe(1);
    expect(replacement.value.deviceGeneration).not.toBe(first.value.deviceGeneration);
  });
});
