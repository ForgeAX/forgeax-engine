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
  it('keeps the saved V1 default and describes V2 encoded edge AA explicitly', () => {
    expect(createStandardOutputPlan(fullRequest).contract).toBe('standard-output-v1');
    const plan = createStandardOutputPlan({
      ...fullRequest,
      contract: 'standard-output-v2',
      chromaticAberration: true,
      lensEffects: true,
      sharpen: true,
    });
    expect(plan.contract).toBe('standard-output-v2');
    expect(plan.logicalStages).toEqual([
      'temporal',
      'meter',
      'chromatic-aberration',
      'bloom',
      'exposure-white-balance',
      'tone',
      'lut',
      'vignette',
      'output-encoding',
      'fxaa',
      'sharpen',
      'grain',
    ]);
    expect(plan.stageDomains.find((stage) => stage.name === 'fxaa')).toEqual({
      name: 'fxaa',
      input: 'display-encoded',
      output: 'display-encoded',
    });
    expect(plan.incrementalResources).toEqual(['standard-grade-output']);
    expect(plan.incrementalBindings).toBe(7);
  });

  it('does not describe an empty final texture for V2 pointwise output', () => {
    const plan = createStandardOutputPlan({
      ...fullRequest,
      contract: 'standard-output-v2',
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
    expect(plan.logicalStages).toEqual(['tone', 'output-encoding']);
  });

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
    expect(direct.stageDomains.map(({ name, input, output }) => ({ name, input, output }))).toEqual(
      [
        { name: 'temporal', input: 'linear-hdr', output: 'linear-hdr' },
        { name: 'meter', input: 'linear-hdr', output: 'linear-hdr' },
        { name: 'bloom', input: 'linear-hdr', output: 'linear-hdr' },
        { name: 'exposure-white-balance', input: 'linear-hdr', output: 'linear-hdr' },
        { name: 'tone', input: 'linear-hdr', output: 'linear-ldr' },
        { name: 'lut', input: 'linear-ldr', output: 'linear-ldr' },
        { name: 'fxaa', input: 'linear-ldr', output: 'linear-ldr' },
        { name: 'output-encoding', input: 'linear-ldr', output: 'display-encoded' },
      ],
    );
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
    expect(plan.stageDomains.at(6)).toEqual({
      name: 'barrel-distortion',
      input: 'linear-ldr',
      output: 'linear-ldr',
    });
    expect(plan.incrementalResources).toContain('standard-barrel-distortion');
    expect(plan.incrementalBindings).toBeGreaterThan(0);
    expect(plan.stageDomains.at(8)?.output).toBe('display-encoded');
  });
});

it('accounts for the selected native linear-LDR seam without charging the ordinary core', () => {
  const request = {
    contract: 'standard-output-v2' as const,
    temporal: false,
    meter: false,
    bloom: false,
    exposure: false,
    whiteBalance: false,
    lut: false,
    fxaa: true,
  };
  expect(createStandardOutputPlan(request).incrementalResources).toEqual(['standard-grade-output']);
  expect(createStandardOutputPlan({ ...request, outline: true }).incrementalResources).toEqual([
    'standard-grade-output',
    'standard-grade-linear',
  ]);
});
