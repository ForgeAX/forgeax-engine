import { describe, expect, it } from 'vitest';
import { type CaptureProvider, selectCaptureProvider } from '../index';

const provider = (id: string): CaptureProvider => ({ id });

describe('capture provider cardinality', () => {
  it('fails closed when no provider is available', () => {
    const result = selectCaptureProvider([]);
    expect(result).toEqual({
      ok: false,
      error: { code: 'capture-target-unavailable', providerIds: [] },
    });
  });

  it('returns the only provider without creating a second route', () => {
    const only = provider('tab-a');
    expect(selectCaptureProvider([only])).toEqual({ ok: true, value: only });
  });

  it('fails closed when multiple providers race for one artifact', () => {
    const result = selectCaptureProvider([provider('tab-a'), provider('tab-b')]);
    expect(result).toEqual({
      ok: false,
      error: { code: 'capture-target-ambiguous', providerIds: ['tab-a', 'tab-b'] },
    });
  });
});
