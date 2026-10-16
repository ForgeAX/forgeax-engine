import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../volume/capability.ts', import.meta.url), 'utf8');

describe('volumetric light capability boundary', () => {
  it('keeps light selection separate from device capability', () => {
    expect(source).toContain('resolveSelectedVolumetricLight');
    expect(source).toContain("'directional' | 'point' | 'spot'");
    expect(source).toContain("'wrong-component'");
    expect(source).toContain("'ambiguous'");
  });

  it('does not turn missing light facts into a synthetic light', () => {
    expect(source).toContain("status: 'unresolved'");
    expect(source).not.toContain('defaultDirectional');
    expect(source).not.toContain('synthetic');
  });
});
