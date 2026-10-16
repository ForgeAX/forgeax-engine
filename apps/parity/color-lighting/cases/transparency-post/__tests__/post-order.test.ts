import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../../../../../../packages/render/src/render-pipeline';

describe('transparency post order', () => {
  it('reports a machine-readable sequence for paired LDR and HDR cases', () => {
    const ldr = resolvePostColorDomainContract('linear-ldr');
    const hdr = resolvePostColorDomainContract('linear-hdr');
    expect(ldr[0]).toEqual(['transparent-blend', 'linear-ldr', 'linear-ldr']);
    expect(hdr[0]).toEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
  });

  it('keeps display encoding through FXAA, post effects, and present', () => {
    const stages = resolvePostColorDomainContract('linear-ldr');
    const fxaa = stages.findIndex(([name]) => name === 'fxaa');
    const output = stages.findIndex(([name]) => name === 'output-transform');
    const postEffect = stages.findIndex(([name]) => name === 'post-effect');
    const present = stages.findIndex(([name]) => name === 'present');
    expect(fxaa).toBeGreaterThanOrEqual(0);
    expect(output).toBeLessThan(fxaa);
    expect(postEffect).toBeGreaterThan(fxaa);
    expect(present).toBeGreaterThan(postEffect);
    expect(stages[output]?.[2]).toBe('display-encoded');
    expect(stages[fxaa]?.slice(1)).toEqual(['display-encoded', 'display-encoded']);
    expect(stages[postEffect]?.slice(1)).toEqual(['display-encoded', 'display-encoded']);
    expect(stages[present]?.slice(1)).toEqual(['display-encoded', 'display-encoded']);
  });
});
