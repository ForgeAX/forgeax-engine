import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const taa = readFileSync(resolve(import.meta.dirname, '..', 'taa-resolve.wgsl'), 'utf8');

describe('taa-resolve flickering temporal analysis (UE TSRShadingAnalysis.ush)', () => {
  it('declares the flicker history binding and fourth output', () => {
    expect(taa).toMatch(
      /@group\(1\)\s+@binding\(13\)\s+var\s+historyFlicker\s*:\s*texture_2d<f32>/,
    );
    expect(taa).toMatch(/@location\(3\)\s+flicker\s*:\s*vec4<f32>/);
  });

  it('carries the per-frame params', () => {
    for (const f of ['flickerEnabled', 'flickerInvThreshold', 'flickerInvMaxParallax']) {
      expect(taa).toContain(f);
    }
  });

  it('has the analysis, stabilised bounds and static test', () => {
    for (const fn of [
      'taaFlickerAnalysis',
      'taaStabilizeBounds',
      'taaFlickerIsStatic',
      'taaFlickerReset',
    ]) {
      expect(taa).toContain(`fn ${fn}`);
    }
  });

  it('uses the UE luma curve and decay constants', () => {
    expect(taa).toContain('0.17');
    expect(taa).toContain('0.95');
    expect(taa).toContain('127.0');
    expect(taa).toContain('20.0');
  });

  it('widens only the luma clip box and leaves reactive pixels moving', () => {
    expect(taa).toMatch(/taaStabilizeBounds\(/);
    expect(taa).toMatch(/clipTaaHistory\(bounds/);
  });
});
