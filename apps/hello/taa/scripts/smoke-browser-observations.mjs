export const compareDecodedRgb = (left, right) => {
  const leftPixels = left?.pixels ?? left;
  const rightPixels = right?.pixels ?? right;
  const dimensionsMatch =
    Number.isInteger(leftPixels?.width) &&
    Number.isInteger(leftPixels?.height) &&
    leftPixels.width === rightPixels?.width &&
    leftPixels.height === rightPixels?.height;
  const hashesPresent = typeof leftPixels?.rgbHash === 'string' && typeof rightPixels?.rgbHash === 'string';
  const decodedRgbEqual = dimensionsMatch && hashesPresent && leftPixels.rgbHash === rightPixels.rgbHash;
  return {
    ok: dimensionsMatch && hashesPresent && !decodedRgbEqual,
    reason: !dimensionsMatch
      ? 'decoded-rgb-dimensions-mismatch'
      : !hashesPresent
        ? 'decoded-rgb-hash-missing'
        : decodedRgbEqual
          ? 'decoded-rgb-identical'
          : 'decoded-rgb-different',
    dimensionsMatch,
    hashesPresent,
    decodedRgbEqual,
    pngHashesEqual: typeof left?.sha256 === 'string' && left.sha256 === right?.sha256,
  };
};

export const FEATURE_VISUAL_TARGETS = Object.freeze([
  'exposure-adaptation-card',
  'white-balance-card',
  'lut-output-card',
]);

export function validateFeatureVisualEvidence(record) {
  const cards = Array.isArray(record?.visualEvidence) ? record.visualEvidence : [];
  const ids = new Set(cards.map((card) => card?.id));
  const complete = FEATURE_VISUAL_TARGETS.every((id) => ids.has(id));
  const joined = complete && cards.every((card) =>
    typeof card?.png === 'string' && card.png.length > 0 &&
    typeof card?.observed === 'string' && card.observed.length > 0 &&
    ['pass', 'fail', 'unavailable'].includes(card.verdict) &&
    ['high', 'medium', 'low'].includes(card.confidence));
  return { ok: joined, complete, targetCount: cards.length, missing: FEATURE_VISUAL_TARGETS.filter((id) => !ids.has(id)) };
}

export const validateMotionBlurTrace = (state, mode) => {
  const passes = Array.isArray(state?.passes) ? state.passes : [];
  const on = mode === 'on';
  const expected = on
    ? {
        enabled: true,
        status: 'active',
        temporalDemand: 'scene-data-temporal-v1',
        hasMotionBlurPass: true,
      }
    : mode === 'off'
      ? {
          enabled: false,
          status: 'off',
          temporalDemand: null,
        }
      : undefined;
  const hasMotionBlurPass = passes.includes('motion-blur');
  // The LUT-enabled Standard chain splits tone/LUT from the final OETF and
  // names its single encoding writer `standard-output-encoding`; the
  // combined no-LUT path keeps the historical `output-transform` name.
  const outputTransformPresent = passes.includes('output-transform') || passes.includes('standard-output-encoding');
  return {
    ok:
      expected !== undefined &&
      state?.motionBlur?.enabled === expected.enabled &&
      state?.motionBlur?.status === expected.status &&
      state?.motionBlur?.temporalDemand === expected.temporalDemand &&
      (on ? hasMotionBlurPass === expected.hasMotionBlurPass : true) &&
      outputTransformPresent,
    mode,
    enabled: state?.motionBlur?.enabled,
    status: state?.motionBlur?.status,
    temporalDemand: state?.motionBlur?.temporalDemand,
    hasMotionBlurPass,
    outputTransformPresent,
  };
};
