import { describe, expect, it } from 'vitest';
import {
  createStandardOutputPlan,
  validateStandardOutputPlan,
} from '../pipeline/standard-output/graph';
import type { StandardOutputPlan } from '../pipeline/standard-output/types';

const fullRequest = {
  lane: 'direct' as const,
  temporal: true,
  meter: true,
  bloom: true,
  exposure: true,
  whiteBalance: true,
  lut: true,
  fxaa: true,
  outputEncoding: 'explicit-oetf' as const,
};

describe('Standard output chain contract', () => {
  it('keeps the logical order and domains independent of the lighting lane', () => {
    const direct = createStandardOutputPlan(fullRequest);
    const clustered = createStandardOutputPlan({ ...fullRequest, lane: 'clustered' });

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
    expect(clustered).toEqual({ ...direct, lane: 'clustered' });
    expect(direct.finalWriterCount).toBe(1);
    expect(direct.outputEncodingCount).toBe(1);
    expect(validateStandardOutputPlan(direct).ok).toBe(true);
  });

  it('retains exact zero incremental work for manual D65 without a LUT', () => {
    const plan = createStandardOutputPlan({
      lane: 'direct',
      temporal: false,
      meter: false,
      bloom: false,
      exposure: false,
      whiteBalance: false,
      lut: false,
      fxaa: false,
      outputEncoding: 'explicit-oetf',
    });
    expect(plan.incrementalResources).toEqual([]);
    expect(plan.incrementalBindings).toBe(0);
    expect(plan.incrementalTimestamps).toBe(0);
    expect(validateStandardOutputPlan(plan).ok).toBe(true);
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
    expect(validateStandardOutputPlan(plan).ok).toBe(true);
  });

  it.each([
    [
      'swaps meter and bloom',
      (plan: StandardOutputPlan): StandardOutputPlan => ({
        ...plan,
        logicalStages: ['temporal', 'bloom', 'meter', ...plan.logicalStages.slice(3)] as const,
      }),
    ],
    [
      'adds a second output encoding',
      (plan: StandardOutputPlan): StandardOutputPlan => ({
        ...plan,
        outputEncodingCount: 2 as never,
      }),
    ],
    [
      'bypasses the LUT',
      (plan: StandardOutputPlan): StandardOutputPlan => ({
        ...plan,
        logicalStages: plan.logicalStages.filter(
          (stage) => stage !== 'lut',
        ) as StandardOutputPlan['logicalStages'],
      }),
    ],
  ])('falsifies when it %s', (_name, mutate) => {
    const invalid = mutate(createStandardOutputPlan(fullRequest));
    expect(validateStandardOutputPlan(invalid).ok).toBe(false);
  });
});
