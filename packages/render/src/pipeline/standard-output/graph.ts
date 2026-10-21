import { DISPLAY_ENCODED_DOMAIN, LINEAR_HDR_DOMAIN, LINEAR_LDR_DOMAIN } from './color-transform';
import type {
  StandardOutputLogicalStage,
  StandardOutputPhysicalStage,
  StandardOutputPlan,
  StandardOutputRequest,
} from './types';

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
    logicalStages,
    physicalStages: physicalStages(logicalStages),
    incrementalResources,
    incrementalBindings,
  };
}
