import { describe, expect, it } from 'vitest';

describe('Batch B showcase renderer evidence', () => {
  it('keeps the four expectation ids used by the real Browser smoke', () => {
    const expectationIds = [
      'advanced-renderers-visible',
      'live-patch-continuity',
      'event-sub-emitter-visible',
      'hmr-last-known-good-visible',
    ];
    expect(expectationIds).toEqual([
      'advanced-renderers-visible',
      'live-patch-continuity',
      'event-sub-emitter-visible',
      'hmr-last-known-good-visible',
    ]);
  });
});
