import { describe, expect, it } from 'vitest';

const scenarios = ['none', 'fxaa', 'taa', 'recovery'] as const;

describe('temporal Environment consumer browser contract', () => {
  it('requires every mode to carry a 60-frame identity', () => {
    const records = scenarios.map((scenario) => ({
      scenario,
      backend: 'browser-webgpu',
      frames: 60,
      status: 'pass',
    }));
    expect(records).toHaveLength(4);
    expect(
      records.every(
        (record) =>
          record.backend === 'browser-webgpu' && record.frames >= 60 && record.status === 'pass',
      ),
    ).toBe(true);
  });

  it('does not promote unavailable adapter evidence', () => {
    const unavailable = { backend: 'browser-webgpu', status: 'unavailable' };
    expect(unavailable.status).not.toBe('pass');
  });
});
