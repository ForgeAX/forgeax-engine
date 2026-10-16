import { type ProducerReadiness, parseProducerReadiness } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

describe('producer readiness policy', () => {
  it('defaults to before-consume for browser hosts', () => {
    expect(parseProducerReadiness(undefined)).toEqual({
      ok: true,
      value: 'before-consume' satisfies ProducerReadiness,
    });
  });

  it('keeps on-demand as an explicit host opt-in', () => {
    expect(parseProducerReadiness('on-demand')).toEqual({
      ok: true,
      value: 'on-demand' satisfies ProducerReadiness,
    });
  });

  it('rejects malformed global policy instead of silently choosing a mode', () => {
    expect(parseProducerReadiness('lazy')).toEqual({
      ok: false,
      error: {
        code: 'producer-readiness-invalid',
        expected: "'before-consume' or 'on-demand'",
        hint: 'set producerReadiness to before-consume or on-demand',
        detail: { value: 'lazy' },
      },
    });
  });
});
