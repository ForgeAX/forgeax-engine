import type { World } from '@forgeax/engine-ecs';
import { AtmosphereInvalidParameterError, type AtmosphereParameterRange } from '../errors/render';
import type { TemporalView } from '../temporal/view';

/** The retained projection's environment extraction owner. */
export interface EnvironmentExtractionContext {
  readonly resourceOwner: number;
  readonly world: World;
}

/** Keep environment reads at the resource-owner frame boundary. */
export function createEnvironmentExtractionContext(
  world: World,
  resourceOwner: number,
): EnvironmentExtractionContext {
  return Object.freeze({ world, resourceOwner });
}

export type EnvironmentCandidate =
  | { readonly kind: 'image'; readonly entityKey: number; readonly sourceKey: string }
  | {
      readonly kind: 'atmosphere';
      readonly entityKey: number;
      readonly sourceKey: string;
      readonly atmosphere: AtmosphereParameters;
    };

/** Immutable extracted atmosphere facts; groundOrigin derives from Transform. */
export interface AtmosphereParameters {
  readonly planetRadius: number;
  readonly atmosphereHeight: number;
  readonly groundOrigin: readonly [number, number, number];
  readonly capturePosition: readonly [number, number, number];
  readonly rayleighScattering: readonly [number, number, number];
  readonly rayleighScaleHeight: number;
  readonly mieScattering: number;
  readonly mieAbsorption: number;
  readonly mieScaleHeight: number;
  readonly mieAnisotropy: number;
  readonly absorption: readonly [number, number, number];
  readonly absorptionPeakHeight: number;
  readonly absorptionHalfWidth: number;
  readonly groundAlbedo: readonly [number, number, number];
  readonly multipleScattering: number;
  readonly sunAngularRadius: number;
  readonly aerialPerspectiveStart: number;
  readonly aerialPerspectiveDistanceScale: number;
}

/** One validation vocabulary for extraction and published frame inputs. */
export const ATMOSPHERE_PARAMETER_RANGES: Readonly<
  Record<keyof AtmosphereParameters, AtmosphereParameterRange>
> = Object.freeze({
  planetRadius: { min: 1, max: 1e9 },
  atmosphereHeight: { min: 1, max: 1e8 },
  groundOrigin: { min: -1e12, max: 1e12 },
  capturePosition: { min: -1e12, max: 1e12 },
  rayleighScattering: { min: 0, max: 1 },
  rayleighScaleHeight: { min: 1, max: 1e8 },
  mieScattering: { min: 0, max: 1 },
  mieAbsorption: { min: 0, max: 1 },
  mieScaleHeight: { min: 1, max: 1e8 },
  mieAnisotropy: { min: -0.99, max: 0.99 },
  absorption: { min: 0, max: 1 },
  absorptionPeakHeight: { min: 0, max: 1e8 },
  absorptionHalfWidth: { min: 1, max: 1e8 },
  groundAlbedo: { min: 0, max: 1 },
  multipleScattering: { min: 0, max: 2 },
  sunAngularRadius: { min: 0, max: 0.1 },
  aerialPerspectiveStart: { min: 0, max: 1e8 },
  aerialPerspectiveDistanceScale: { min: 0, max: 10 },
});

export interface FogCandidate {
  readonly entityKey: number;
  readonly color: readonly [number, number, number];
  readonly density: number;
  readonly heightFalloff: number;
  readonly maxOpacity: number;
}

export type EnvironmentSource =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'image';
      readonly entityKey: number;
      readonly sourceKey: string;
    }
  | {
      readonly kind: 'atmosphere';
      readonly entityKey: number;
      readonly sourceKey: string;
      readonly atmosphere: AtmosphereParameters;
    };

export interface FogFrame extends FogCandidate {}

export interface FogParameterIssue {
  readonly field: string;
  readonly value: number;
  readonly expected: string;
}

/** Structured failure retained when an invalid Fog update falls back to LKG. */
export interface FogSelectionFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface EnvironmentFrame {
  readonly source: EnvironmentSource;
  /** Descriptor of the real environment resource adopted for this frame. */
  readonly resourceDescriptor?: Readonly<{
    readonly width: number;
    readonly height: number;
    readonly bytesPerPixel: number;
  }>;
  readonly fog: FogFrame | undefined;
  readonly environmentSignature: string;
  readonly fogSignature: string;
  readonly signature: string;
  readonly revision: number;
}

export interface FramePlan {
  readonly environment: EnvironmentFrame;
  readonly temporal: TemporalView;
}

/** Validate the bounded Fog domain once for every frame-selection producer. */
export function validateFogParameters(candidate: FogCandidate): FogParameterIssue | undefined {
  if (candidate.color.length !== 3) {
    return {
      field: 'color',
      value: candidate.color.length,
      expected: 'exactly three finite channels in [0, 1]',
    };
  }
  for (let index = 0; index < candidate.color.length; index += 1) {
    const value = candidate.color[index];
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
      return {
        field: `color[${index}]`,
        value: value ?? Number.NaN,
        expected: 'a finite number in [0, 1]',
      };
    }
  }
  if (!Number.isFinite(candidate.density) || candidate.density < 0) {
    return { field: 'density', value: candidate.density, expected: 'a finite number >= 0' };
  }
  if (!Number.isFinite(candidate.heightFalloff) || candidate.heightFalloff < 0) {
    return {
      field: 'heightFalloff',
      value: candidate.heightFalloff,
      expected: 'a finite number >= 0',
    };
  }
  if (
    !Number.isFinite(candidate.maxOpacity) ||
    candidate.maxOpacity < 0 ||
    candidate.maxOpacity > 1
  ) {
    return {
      field: 'maxOpacity',
      value: candidate.maxOpacity,
      expected: 'a finite number in [0, 1]',
    };
  }
  return undefined;
}

export function freezeAtmosphere(parameters: AtmosphereParameters): AtmosphereParameters {
  return Object.freeze({
    ...parameters,
    capturePosition: Object.freeze([
      ...parameters.capturePosition,
    ]) as AtmosphereParameters['capturePosition'],
    groundOrigin: Object.freeze([
      ...parameters.groundOrigin,
    ]) as AtmosphereParameters['groundOrigin'],
    rayleighScattering: Object.freeze([
      ...parameters.rayleighScattering,
    ]) as AtmosphereParameters['rayleighScattering'],
    absorption: Object.freeze([...parameters.absorption]) as AtmosphereParameters['absorption'],
    groundAlbedo: Object.freeze([
      ...parameters.groundAlbedo,
    ]) as AtmosphereParameters['groundAlbedo'],
  });
}

/** Return the first invalid atmosphere field at the extraction boundary. */
export function validateAtmosphereParameters(
  parameters: AtmosphereParameters,
): AtmosphereInvalidParameterError | undefined {
  for (const field of Object.keys(ATMOSPHERE_PARAMETER_RANGES) as (keyof AtmosphereParameters)[]) {
    const value = parameters[field];
    const range = ATMOSPHERE_PARAMETER_RANGES[field];
    const channels = typeof value === 'number' ? [value] : value;
    if (channels === undefined || (typeof value !== 'number' && channels.length !== 3)) {
      return new AtmosphereInvalidParameterError(field, Number.NaN, range);
    }
    for (const channel of channels) {
      if (!Number.isFinite(channel) || channel < range.min || channel > range.max) {
        return new AtmosphereInvalidParameterError(field, channel, range);
      }
    }
  }
  return undefined;
}
