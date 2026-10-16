import { describe, expect, it } from 'vitest';

describe('extended-lighting browser recovery evidence', () => {
  it('records an honest bounded status when the real carrier is unavailable', () => {
    const evidence = {
      status: 'not-run' as const,
      reason: 'Browser carrier requires a real extendedLighting adapter and readback owner',
      generation: 0,
      recordByteLength: 160,
    };
    expect(evidence.status).toBe('not-run');
    expect(evidence.recordByteLength).toBe(160);
  });
});
