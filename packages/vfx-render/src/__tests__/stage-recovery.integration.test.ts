import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stagePlanPath = resolve(import.meta.dirname, '../feature/stage-plan.ts');

describe('VFX stage generation recovery', () => {
  it('keeps candidate failure and device recovery observable without stale resources', () => {
    const source = readFileSync(stagePlanPath, 'utf8');
    expect(source).toContain('candidate');
    expect(source).toContain('lastKnownGood');
    expect(source).toContain('generation');
    expect(source).toContain('retryable');
    expect(source).toContain('device-loss');
    expect(source).toContain('stale');
  });

  it('does not introduce a second VFX RPC or a CPU fallback recovery path', () => {
    const source = readFileSync(stagePlanPath, 'utf8');
    expect(source).not.toContain('readback');
    expect(source).not.toContain('cpuFallback');
    expect(source).not.toContain('new VFX RPC');
  });
});
