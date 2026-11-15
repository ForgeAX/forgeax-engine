import type { CloudRgb, MediumSample } from '../contracts';

export const CLOUD_ISOTROPIC_PHASE = 1 / (4 * Math.PI);

/** Cosine between camera-to-sample and sample-to-light; positive g peaks toward the light. */
export function cloudHenyeyGreenstein(anisotropy: number, cosine: number): number {
  const g = Math.min(0.999, Math.max(-0.999, anisotropy));
  const magnitude = Math.abs(g);
  const signedCosine = (g < 0 ? -1 : 1) * Math.min(1, Math.max(-1, cosine));
  const oneMinusG = 1 - magnitude;
  const denominator = oneMinusG * oneMinusG + 2 * magnitude * (1 - signedCosine);
  return (
    (CLOUD_ISOTROPIC_PHASE * oneMinusG * (1 + magnitude)) / (denominator * Math.sqrt(denominator))
  );
}

export function cloudDoubleHenyeyGreenstein(
  g: number,
  g2: number,
  blend: number,
  cosine: number,
): number {
  const phase0 = cloudHenyeyGreenstein(g, cosine);
  const phase1 = cloudHenyeyGreenstein(g2, cosine);
  return phase0 + (phase1 - phase0) * Math.min(1, Math.max(0, blend));
}

export interface CloudMultipleScattering {
  readonly contribution: number;
  readonly occlusion: number;
  readonly eccentricity: number;
  readonly extraOctaves: 0 | 1 | 2;
  readonly grayScale: boolean;
  readonly clampContribution: boolean;
}

export interface CloudOpticalOctave {
  readonly extinctionPerMeter: number;
  readonly scatteringPerMeter: CloudRgb;
  readonly phase: number;
}

const saturate = (value: number): number => Math.min(1, Math.max(0, value));

/** Pure reference optical coefficients. Only the base octave attenuates the view ray. */
export function cloudOpticalOctaves(
  medium: MediumSample,
  basePhase: number,
  settings: CloudMultipleScattering,
): readonly CloudOpticalOctave[] {
  let extinctionPerMeter = medium.extinctionPerMeter;
  let scatteringPerMeter: CloudRgb = [
    extinctionPerMeter * medium.albedo[0],
    extinctionPerMeter * medium.albedo[settings.grayScale ? 0 : 1],
    extinctionPerMeter * medium.albedo[settings.grayScale ? 0 : 2],
  ];
  const octaves: CloudOpticalOctave[] = [
    { extinctionPerMeter, scatteringPerMeter, phase: basePhase },
  ];
  let contribution = settings.clampContribution
    ? saturate(settings.contribution)
    : Math.max(0, settings.contribution);
  let occlusion = saturate(settings.occlusion);
  let eccentricity = saturate(settings.eccentricity);
  for (let octave = 0; octave < settings.extraOctaves; octave++) {
    extinctionPerMeter *= occlusion;
    scatteringPerMeter = [
      scatteringPerMeter[0] * contribution,
      scatteringPerMeter[1] * contribution,
      scatteringPerMeter[2] * contribution,
    ];
    octaves.push({
      extinctionPerMeter,
      scatteringPerMeter,
      phase: CLOUD_ISOTROPIC_PHASE + (basePhase - CLOUD_ISOTROPIC_PHASE) * eccentricity,
    });
    contribution *= contribution;
    occlusion *= occlusion;
    eccentricity *= eccentricity;
  }
  return octaves;
}
