/** Versioned product constants. External standards supply formulas, not these values. */
export interface AutoExposurePreset {
  readonly version: 'auto-exposure-v1';
  readonly histogramBins: 256;
  readonly sampleBlockSize: 4;
  readonly lowPercentile: number;
  readonly highPercentile: number;
  readonly middleGray: number;
  readonly logLuminanceMin: number;
  readonly logLuminanceMax: number;
  readonly referenceFormulas: readonly string[];
}

export const AUTO_EXPOSURE_PRESET_V1: AutoExposurePreset = Object.freeze({
  version: 'auto-exposure-v1',
  histogramBins: 256,
  sampleBlockSize: 4,
  lowPercentile: 0.05,
  highPercentile: 0.95,
  middleGray: 0.18,
  logLuminanceMin: -12,
  logLuminanceMax: 12,
  referenceFormulas: Object.freeze([
    'linear-rgb-to-xyz-d65',
    'bradford-d65-adaptation',
    'cielab-delta-e-2000',
  ]),
});
