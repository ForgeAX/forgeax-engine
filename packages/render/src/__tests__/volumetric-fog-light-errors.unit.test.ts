import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../volume/recovery.ts', import.meta.url), 'utf8');

describe('selected volumetric light errors', () => {
  it('preserves candidate and accepted selected-light facts in recovery state', () => {
    expect(source).toContain('selectedLight');
    expect(source).toContain('candidateFailure');
    expect(source).toContain('stale-generation');
  });

  it('keeps shadow degradation distinct from an absent selected light', () => {
    expect(source).toContain('shadow');
    expect(source).toContain('missing');
  });
});
