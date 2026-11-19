import { DISPLAY_ENCODED_DOMAIN, LINEAR_HDR_DOMAIN, LINEAR_LDR_DOMAIN } from './color-transform';
import type {
  StandardOutputContract,
  StandardOutputLogicalStage,
  StandardOutputPlan,
  StandardOutputRequest,
  StandardOutputStageDomain,
} from './types';

function requestedHdrStages(input: StandardOutputRequest): StandardOutputLogicalStage[] {
  const stages: StandardOutputLogicalStage[] = [];
  if (input.temporal) stages.push('temporal');
  if (input.meter) stages.push('meter');
  if (input.dof === true) stages.push('dof');
  if (input.chromaticAberration === true) stages.push('chromatic-aberration');
  if (input.bloom) stages.push('bloom');
  if (input.lensFlare === true) stages.push('lens-flare');
  if (input.exposure || input.whiteBalance) stages.push('exposure-white-balance');
  return stages;
}

function requestedLinearStages(
  input: StandardOutputRequest,
  encodedAa: boolean,
): StandardOutputLogicalStage[] {
  const stages: StandardOutputLogicalStage[] = [];
  if (input.lut) stages.push('lut');
  if (encodedAa && input.lensEffects) stages.push('vignette');
  if (input.outline === true) stages.push('outline');
  if (input.barrelDistortion === true) stages.push('barrel-distortion');
  if (!encodedAa && input.fxaa) stages.push('fxaa');
  if (!encodedAa && input.lensEffects === true) stages.push('lens-effects');
  if (input.smaa === true) stages.push('smaa');
  return stages;
}

function requestedStages(input: StandardOutputRequest): StandardOutputLogicalStage[] {
  const encodedAa = input.contract === 'standard-output-v2';
  const stages = requestedHdrStages(input);
  stages.push('tone', ...requestedLinearStages(input, encodedAa), 'output-encoding');
  if (encodedAa && input.fxaa) stages.push('fxaa');
  if (encodedAa && input.sharpen) stages.push('sharpen');
  if (encodedAa && input.lensEffects) stages.push('grain');
  return stages;
}

function stageDomains(
  logicalStages: readonly StandardOutputLogicalStage[],
  contract: StandardOutputContract,
): StandardOutputStageDomain[] {
  return logicalStages.map((name) => {
    switch (name) {
      case 'temporal':
      case 'meter':
      case 'bloom':
      case 'lens-flare':
      case 'dof':
      case 'chromatic-aberration':
      case 'exposure-white-balance':
        return { name, input: LINEAR_HDR_DOMAIN, output: LINEAR_HDR_DOMAIN };
      case 'tone':
        return { name, input: LINEAR_HDR_DOMAIN, output: LINEAR_LDR_DOMAIN };
      case 'lut':
      case 'vignette':
      case 'outline':
      case 'barrel-distortion':
      case 'lens-effects':
      case 'smaa':
        return { name, input: LINEAR_LDR_DOMAIN, output: LINEAR_LDR_DOMAIN };
      case 'fxaa': {
        const domain =
          contract === 'standard-output-v2' ? DISPLAY_ENCODED_DOMAIN : LINEAR_LDR_DOMAIN;
        return { name, input: domain, output: domain };
      }
      case 'grain':
      case 'sharpen':
        return { name, input: DISPLAY_ENCODED_DOMAIN, output: DISPLAY_ENCODED_DOMAIN };
      case 'output-encoding':
        return { name, input: LINEAR_LDR_DOMAIN, output: DISPLAY_ENCODED_DOMAIN };
      default:
        throw new Error(`Unknown Standard output stage: ${name}`);
    }
  });
}

function incrementalOutputResources(input: StandardOutputRequest, encodedAa: boolean): string[] {
  return [
    ...(encodedAa && (input.fxaa || input.sharpen) ? ['standard-grade-output'] : []),
    ...(encodedAa && (input.outline || input.barrelDistortion || input.smaa)
      ? ['standard-grade-linear']
      : []),
    ...(!encodedAa && input.chromaticAberration === true ? ['standard-chromatic-aberration'] : []),
    ...(input.lensFlare === true
      ? ['standard-lens-flare-prefilter', 'standard-lens-flare-bokeh', 'standard-lens-flare']
      : []),
    ...(!encodedAa && input.lut ? ['standard-color-lut'] : []),
    ...(input.barrelDistortion === true ? ['standard-barrel-distortion'] : []),
    ...(!encodedAa && input.lensEffects === true ? ['standard-lens-effects'] : []),
  ];
}

function incrementalOutputBindings(input: StandardOutputRequest, encodedAa: boolean): number {
  return (
    (encodedAa && input.bloom ? 5 : 0) +
    (!encodedAa && input.chromaticAberration === true ? 3 : 0) +
    (input.lensFlare === true ? 10 : 0) +
    (input.lut ? 2 : 0) +
    (input.barrelDistortion === true ? 3 : 0) +
    (!encodedAa && input.lensEffects === true ? 3 : 0)
  );
}

export function createStandardOutputPlan(input: StandardOutputRequest): StandardOutputPlan {
  const contract = input.contract ?? 'standard-output-v1';
  const encodedAa = contract === 'standard-output-v2';
  const logicalStages = requestedStages(input);
  return {
    contract,
    features: {
      temporal: input.temporal,
      meter: input.meter,
      bloom: input.bloom,
      dof: input.dof === true,
      chromaticAberration: input.chromaticAberration === true,
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
    logicalStages,
    stageDomains: stageDomains(logicalStages, contract),
    incrementalResources: incrementalOutputResources(input, encodedAa),
    incrementalBindings: incrementalOutputBindings(input, encodedAa),
  };
}
