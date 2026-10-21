import { describe, expect, it } from 'vitest';
import { createStandardOutputPlan } from '../pipeline/standard-output/graph';

const fullRequest = {
  temporal: true,
  meter: true,
  bloom: true,
  exposure: true,
  whiteBalance: true,
  lut: true,
  fxaa: true,
};

describe('Standard output chain contract', () => {
  it('keeps the logical order and color domains', () => {
    const direct = createStandardOutputPlan(fullRequest);

    expect(direct.logicalStages).toEqual([
      'temporal',
      'meter',
      'bloom',
      'exposure-white-balance',
      'tone',
      'lut',
      'fxaa',
      'output-encoding',
    ]);
    expect(
      direct.physicalStages.map(({ name, input, output }) => ({ name, input, output })),
    ).toEqual([
      { name: 'temporal', input: 'linear-hdr', output: 'linear-hdr' },
      { name: 'meter', input: 'linear-hdr', output: 'linear-hdr' },
      { name: 'bloom', input: 'linear-hdr', output: 'linear-hdr' },
      { name: 'exposure-white-balance', input: 'linear-hdr', output: 'linear-hdr' },
      { name: 'tone', input: 'linear-hdr', output: 'linear-ldr' },
      { name: 'lut', input: 'linear-ldr', output: 'linear-ldr' },
      { name: 'fxaa', input: 'linear-ldr', output: 'linear-ldr' },
      { name: 'output-encoding', input: 'linear-ldr', output: 'display-encoded' },
    ]);
  });

  it('retains exact zero incremental work for manual D65 without a LUT', () => {
    const plan = createStandardOutputPlan({
      temporal: false,
      meter: false,
      bloom: false,
      exposure: false,
      whiteBalance: false,
      lut: false,
      fxaa: false,
    });
    expect(plan.incrementalResources).toEqual([]);
    expect(plan.incrementalBindings).toBe(0);
  });

  it('places barrel distortion in linear-LDR after LUT and before edge AA', () => {
    const plan = createStandardOutputPlan({
      ...fullRequest,
      barrelDistortion: true,
    });

    expect(plan.logicalStages).toEqual([
      'temporal',
      'meter',
      'bloom',
      'exposure-white-balance',
      'tone',
      'lut',
      'barrel-distortion',
      'fxaa',
      'output-encoding',
    ]);
    expect(plan.physicalStages.at(6)).toEqual({
      name: 'barrel-distortion',
      input: 'linear-ldr',
      output: 'linear-ldr',
    });
    expect(plan.incrementalResources).toContain('standard-barrel-distortion');
    expect(plan.incrementalBindings).toBeGreaterThan(0);
    expect(plan.physicalStages.at(8)?.output).toBe('display-encoded');
  });
});
