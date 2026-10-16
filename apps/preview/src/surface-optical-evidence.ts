import { surfaceEvidenceGuid } from './surface-standard-evidence-identity.js';

export const SURFACE_OPTICAL_BACKGROUND_SOURCE_KEY =
  'preview-surface-standard-evidence:material/water-optical-background';
export const SURFACE_OPTICAL_BACKGROUND_GUID = surfaceEvidenceGuid(
  'material/water-optical-background',
);

export interface SurfaceOpticalParameters {
  readonly roughness: number;
  readonly coverage: number;
  readonly foamBase: number;
  readonly foamScale: number;
  readonly absorption: readonly [number, number, number];
  readonly scattering: readonly [number, number, number];
  readonly ior: number;
  readonly phaseG: number;
  readonly maxDistanceMeters: number;
  readonly waveAmplitude: readonly [number, number];
}

export interface SurfaceOpticalEvidenceCase {
  readonly id: string;
  readonly guid: string;
  readonly sourceKey: string;
  readonly parameters: SurfaceOpticalParameters;
  /** Omitted when the paired depth producer intentionally reports a sky miss. */
  readonly backgroundDistanceMeters?: number;
  /** Rotation of the water plane around +Y, used for the grazing Fresnel case. */
  readonly waterTiltYRadians?: number;
  /** A target crossing the water plane; the two sample offsets straddle the crossing. */
  readonly halfSubmergedTarget?: true;
  /** One deliberately wrong reference input for the executable falsifier. */
  readonly falsifierAbsorption?: readonly [number, number, number];
}

const base = {
  roughness: 0.16,
  coverage: 1,
  foamBase: 0,
  foamScale: 0,
  ior: 1.0001,
  phaseG: 0,
  maxDistanceMeters: 900,
  waveAmplitude: [0, 0] as const,
} as const;

function opticalCase(
  id: string,
  parameters: Pick<SurfaceOpticalParameters, 'absorption' | 'scattering'> &
    Partial<SurfaceOpticalParameters>,
  geometry: Omit<SurfaceOpticalEvidenceCase, 'id' | 'guid' | 'sourceKey' | 'parameters'> = {},
): SurfaceOpticalEvidenceCase {
  const sourceKey = `material/water-optical-${id}`;
  return Object.freeze({
    id,
    guid: surfaceEvidenceGuid(sourceKey),
    sourceKey: `preview-surface-standard-evidence:${sourceKey}`,
    parameters: Object.freeze({ ...base, ...parameters }),
    ...geometry,
  });
}

/**
 * Meter-scale inputs for the real authored water Surface optical oracle.
 * These are author facts only; the independent test reference implements the
 * integration separately and never imports a product optical helper.
 */
export const SURFACE_OPTICAL_CASES = Object.freeze([
  opticalCase(
    'shore-contact',
    { absorption: [0.32, 0.075, 0.035], scattering: [0, 0, 0], maxDistanceMeters: 30 },
    { backgroundDistanceMeters: 0.002 },
  ),
  opticalCase(
    'zero-extinction',
    { absorption: [0, 0, 0], scattering: [0, 0, 0] },
    { backgroundDistanceMeters: 1 },
  ),
  opticalCase(
    'absorption-red',
    { absorption: [0.42, 0, 0], scattering: [0, 0, 0] },
    { backgroundDistanceMeters: 1 },
  ),
  opticalCase(
    'scattering-green',
    { absorption: [0, 0, 0], scattering: [0, 0.28, 0] },
    { backgroundDistanceMeters: 1 },
  ),
  opticalCase(
    'distance-near',
    { absorption: [0.12, 0.18, 0.24], scattering: [0.02, 0.03, 0.04] },
    { backgroundDistanceMeters: 1 },
  ),
  opticalCase(
    'distance-double',
    { absorption: [0.12, 0.18, 0.24], scattering: [0.02, 0.03, 0.04] },
    { backgroundDistanceMeters: 2 },
  ),
  opticalCase('small-extinction-sky', {
    absorption: [0.00001, 0.00002, 0.00003],
    scattering: [0.00002, 0.00001, 0.000015],
    maxDistanceMeters: 900,
  }),
  opticalCase(
    'ior-normal',
    { absorption: [0, 0, 0], scattering: [0, 0, 0], ior: 1.5 },
    { backgroundDistanceMeters: 1 },
  ),
  opticalCase(
    'ior-grazing',
    { absorption: [0, 0, 0], scattering: [0, 0, 0], ior: 1.5 },
    { backgroundDistanceMeters: 1, waterTiltYRadians: Math.PI * (70 / 180) },
  ),
  opticalCase(
    'shallow',
    { absorption: [0.18, 0.12, 0.08], scattering: [0.02, 0.025, 0.03] },
    { backgroundDistanceMeters: 0.25 },
  ),
  opticalCase(
    'deep',
    { absorption: [0.18, 0.12, 0.08], scattering: [0.02, 0.025, 0.03] },
    { backgroundDistanceMeters: 3 },
  ),
  opticalCase(
    'half-submerged',
    { absorption: [1.2, 0.6, 0.25], scattering: [0.015, 0.025, 0.04] },
    { halfSubmergedTarget: true },
  ),
  opticalCase(
    'falsifier',
    { absorption: [0.52, 0.08, 0.04], scattering: [0.01, 0.02, 0.03] },
    { backgroundDistanceMeters: 1.5, falsifierAbsorption: [0.05, 0.08, 0.04] },
  ),
] satisfies readonly SurfaceOpticalEvidenceCase[]);
