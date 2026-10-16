import { err, ok, type Result } from '@forgeax/engine-types';
import { DISPLAY_ENCODED_DOMAIN, LINEAR_HDR_DOMAIN, LINEAR_LDR_DOMAIN } from './color-transform';
import type {
  StandardOutputLogicalStage,
  StandardOutputPhysicalStage,
  StandardOutputPlan,
  StandardOutputRequest,
} from './types';

export class StandardOutputPlanError extends Error {
  readonly code = 'standard-output-plan-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly actual: string };

  constructor(field: string, actual: string, expected: string) {
    super(`standard-output-plan-invalid: ${field} ${actual}; expected ${expected}`);
    this.name = 'StandardOutputPlanError';
    this.expected = expected;
    this.hint = `repair the ${field} projection before recording the Standard graph`;
    this.detail = { field, actual };
  }
}

function requestedStages(input: StandardOutputRequest): StandardOutputLogicalStage[] {
  const stages: StandardOutputLogicalStage[] = [];
  if (input.temporal) stages.push('temporal');
  if (input.meter) stages.push('meter');
  if (input.dof === true) stages.push('dof');
  if (input.bloom) stages.push('bloom');
  if (input.lensFlare === true) stages.push('lens-flare');
  if (input.exposure || input.whiteBalance) stages.push('exposure-white-balance');
  stages.push('tone');
  if (input.lut) stages.push('lut');
  if (input.outline === true) stages.push('outline');
  if (input.barrelDistortion === true) stages.push('barrel-distortion');
  if (input.fxaa) stages.push('fxaa');
  if (input.lensEffects === true) stages.push('lens-effects');
  if (input.smaa === true) stages.push('smaa');
  stages.push('output-encoding');
  return stages;
}

function physicalStages(
  logicalStages: readonly StandardOutputLogicalStage[],
): StandardOutputPhysicalStage[] {
  return logicalStages.map((name) => {
    switch (name) {
      case 'temporal':
      case 'meter':
      case 'bloom':
      case 'lens-flare':
      case 'dof':
      case 'exposure-white-balance':
        return { name, input: LINEAR_HDR_DOMAIN, output: LINEAR_HDR_DOMAIN };
      case 'tone':
        return { name, input: LINEAR_HDR_DOMAIN, output: LINEAR_LDR_DOMAIN };
      case 'lut':
      case 'outline':
      case 'barrel-distortion':
      case 'fxaa':
      case 'lens-effects':
      case 'smaa':
        return { name, input: LINEAR_LDR_DOMAIN, output: LINEAR_LDR_DOMAIN };
      case 'output-encoding':
        return { name, input: LINEAR_LDR_DOMAIN, output: DISPLAY_ENCODED_DOMAIN };
      default:
        throw new Error(`Unknown Standard output stage: ${name}`);
    }
  });
}

export function createStandardOutputPlan(input: StandardOutputRequest): StandardOutputPlan {
  const logicalStages = requestedStages(input);
  const incrementalResources = [
    ...(input.lensFlare === true
      ? ['standard-lens-flare-prefilter', 'standard-lens-flare-bokeh', 'standard-lens-flare']
      : []),
    ...(input.lut ? ['standard-color-lut'] : []),
    ...(input.barrelDistortion === true ? ['standard-barrel-distortion'] : []),
    ...(input.lensEffects === true ? ['standard-lens-effects'] : []),
  ];
  const incrementalBindings =
    (input.lensFlare === true ? 10 : 0) +
    (input.lut ? 2 : 0) +
    (input.barrelDistortion === true ? 3 : 0) +
    (input.lensEffects === true ? 3 : 0);
  return {
    lane: input.lane,
    features: {
      temporal: input.temporal,
      meter: input.meter,
      bloom: input.bloom,
      dof: input.dof === true,
      lensFlare: input.lensFlare === true,
      exposure: input.exposure,
      whiteBalance: input.whiteBalance,
      lut: input.lut,
      outline: input.outline === true,
      barrelDistortion: input.barrelDistortion === true,
      lensEffects: input.lensEffects === true,
      fxaa: input.fxaa,
      smaa: input.smaa === true,
    },
    outputEncoding: input.outputEncoding,
    logicalStages,
    physicalStages: physicalStages(logicalStages),
    finalWriterCount: 1,
    outputEncodingCount: 1,
    incrementalResources,
    incrementalBindings,
    incrementalTimestamps: 0,
  };
}

function invalid(
  field: string,
  actual: string,
  expected: string,
): Result<never, StandardOutputPlanError> {
  return err(new StandardOutputPlanError(field, actual, expected));
}

export function validateStandardOutputPlan(
  plan: StandardOutputPlan,
): Result<StandardOutputPlan, StandardOutputPlanError> {
  const expected = requestedStages({
    lane: plan.lane,
    ...plan.features,
    outputEncoding: plan.outputEncoding,
  });
  if (
    plan.logicalStages.length !== expected.length ||
    plan.logicalStages.some((stage, index) => stage !== expected[index])
  ) {
    return invalid('logicalStages', plan.logicalStages.join(','), expected.join(','));
  }
  if (plan.finalWriterCount !== 1)
    return invalid('finalWriterCount', String(plan.finalWriterCount), '1');
  if (plan.outputEncodingCount !== 1)
    return invalid('outputEncodingCount', String(plan.outputEncodingCount), '1');
  if (plan.physicalStages.length !== plan.logicalStages.length) {
    return invalid(
      'physicalStages',
      String(plan.physicalStages.length),
      String(plan.logicalStages.length),
    );
  }
  const expectedPhysical = physicalStages(expected);
  for (let index = 0; index < expectedPhysical.length; index += 1) {
    const actual = plan.physicalStages[index];
    const wanted = expectedPhysical[index];
    if (
      actual?.name !== wanted?.name ||
      actual?.input !== wanted?.input ||
      actual?.output !== wanted?.output
    ) {
      return invalid(`physicalStages[${index}]`, JSON.stringify(actual), JSON.stringify(wanted));
    }
  }
  if (
    plan.outputEncoding === 'explicit-oetf' &&
    plan.physicalStages.at(-1)?.output !== DISPLAY_ENCODED_DOMAIN
  ) {
    return invalid('outputEncoding', plan.outputEncoding, 'one final display-encoded writer');
  }
  return ok(plan);
}
