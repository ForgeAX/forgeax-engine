import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type AtmosphereInvalidParameterError,
  EnvironmentSourceConflictError,
  FogCardinalityError,
} from '../errors/render';
import type {
  EnvironmentCandidate,
  EnvironmentFrame,
  EnvironmentSource,
  FogCandidate,
  FogFrame,
  GradientSkyFrame,
} from '../extract/environment';
import {
  freezeAtmosphere,
  validateAtmosphereParameters,
  validateFogParameters,
  validateGradientSky,
} from '../extract/environment';
import { environmentFactSignatures } from './signature';

export type {
  EnvironmentCandidate,
  EnvironmentFrame,
  EnvironmentSource,
  FogCandidate,
  FogFrame,
  GradientSkyFrame,
};

/** Producer-local fallback while replacement environment storage is uninitialized. */
export const SKYLIGHT_RECOVERY_FALLBACK = Object.freeze({
  kind: 'skylight',
  active: false,
} as const);

export interface SunCandidate {
  readonly entityKey: number;
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
}

export interface EnvironmentSelectionInput {
  readonly environments: readonly EnvironmentCandidate[];
  readonly fogs: readonly FogCandidate[];
  readonly suns: readonly SunCandidate[];
  /** GradientSky owners; a SkyboxBackground or Atmosphere also drawing the background conflicts. */
  readonly skies?: readonly GradientSkyFrame[];
  readonly skyboxBackground?: boolean;
}

export interface EnvironmentSelectionParameterDetail {
  readonly field: string;
  readonly value: number;
}

export class EnvironmentSelectionParameterError extends Error {
  readonly code = 'environment-selection-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: EnvironmentSelectionParameterDetail;

  constructor(field: string, value: number, expected: string) {
    super(`environment selection field ${field} is invalid: expected ${expected}, got ${value}`);
    this.name = 'EnvironmentSelectionParameterError';
    this.expected = expected;
    this.hint = `set ${field} to a finite value satisfying ${expected}`;
    this.detail = { field, value };
  }
}

export interface SunCardinalityDetail {
  readonly field: 'sun';
  readonly value: number;
}

export class SunCardinalityError extends Error {
  readonly code = 'sun-cardinality' as const;
  readonly expected = 'atmosphere has exactly one sun owner';
  readonly hint = 'add exactly one DirectionalLight sun for the atmosphere owner';
  readonly detail: SunCardinalityDetail;

  constructor(value: number) {
    super(`atmosphere sun cardinality is ${value}`);
    this.name = 'SunCardinalityError';
    this.detail = { field: 'sun', value };
  }
}

export type EnvironmentSelectionError =
  | EnvironmentSourceConflictError
  | FogCardinalityError
  | EnvironmentSelectionParameterError
  | AtmosphereInvalidParameterError
  | SunCardinalityError;

export interface SelectedEnvironmentFrame extends EnvironmentFrame {
  readonly sun: SunCandidate | undefined;
}

function freezeCandidate<T extends object>(candidate: T): T {
  return Object.freeze(candidate);
}

function freezeFog(candidate: FogCandidate): FogFrame {
  return Object.freeze({
    ...candidate,
    color: Object.freeze([...candidate.color] as unknown as FogFrame['color']),
  });
}

/** At most one valid GradientSky, and no other background owner beside it. */
function selectGradientSky(
  input: EnvironmentSelectionInput,
  atmosphere: boolean,
): Result<GradientSkyFrame | undefined, EnvironmentSelectionParameterError> {
  const skies = input.skies ?? [];
  const candidate = skies[0];
  if (candidate === undefined) return ok(undefined);
  if (skies.length > 1)
    return err(
      new EnvironmentSelectionParameterError('GradientSky', skies.length, 'one GradientSky'),
    );
  if (atmosphere || input.skyboxBackground === true) {
    return err(
      new EnvironmentSelectionParameterError(
        'GradientSky',
        1,
        `no ${atmosphere ? 'Atmosphere' : 'SkyboxBackground'} beside a GradientSky (both draw the background)`,
      ),
    );
  }
  const issue = validateGradientSky(candidate);
  if (issue !== undefined)
    return err(new EnvironmentSelectionParameterError(issue.field, issue.value, issue.expected));
  return ok(
    Object.freeze({
      ...candidate,
      zenith: Object.freeze([...candidate.zenith]) as unknown as GradientSkyFrame['zenith'],
      horizon: Object.freeze([...candidate.horizon]) as unknown as GradientSkyFrame['horizon'],
      ground: Object.freeze([...candidate.ground]) as unknown as GradientSkyFrame['ground'],
      mid: Object.freeze([...candidate.mid]) as unknown as GradientSkyFrame['mid'],
    }),
  );
}

/** Select one immutable frame fact set for every Standard lighting path. */
export function selectEnvironment(
  input: EnvironmentSelectionInput,
): Result<SelectedEnvironmentFrame, EnvironmentSelectionError> {
  if (input.environments.length > 1) {
    return err(
      new EnvironmentSourceConflictError(
        [...input.environments]
          .sort((left, right) => left.entityKey - right.entityKey)
          .map(({ kind, entityKey, sourceKey }) => ({ kind, entityKey, sourceKey })),
      ),
    );
  }
  if (input.fogs.length > 1) return err(new FogCardinalityError(input.fogs.length));
  const selectedFog = input.fogs[0];
  if (selectedFog !== undefined) {
    const issue = validateFogParameters(selectedFog);
    if (issue !== undefined) {
      return err(new EnvironmentSelectionParameterError(issue.field, issue.value, issue.expected));
    }
  }
  const selected = input.environments[0];
  const sky = selectGradientSky(input, selected?.kind === 'atmosphere');
  if (!sky.ok) return sky;
  if (selected?.kind === 'atmosphere') {
    const invalid = validateAtmosphereParameters(selected.atmosphere);
    if (invalid !== undefined) return err(invalid);
  }
  if (selected?.kind === 'atmosphere' && input.suns.length !== 1) {
    return err(new SunCardinalityError(input.suns.length));
  }
  const source: EnvironmentSource =
    selected === undefined
      ? { kind: 'none' }
      : selected.kind === 'atmosphere'
        ? {
            kind: 'atmosphere',
            entityKey: selected.entityKey,
            sourceKey: selected.sourceKey,
            atmosphere: freezeAtmosphere(selected.atmosphere),
          }
        : {
            kind: 'image',
            entityKey: selected.entityKey,
            sourceKey: selected.sourceKey,
          };
  const sun = input.suns[0] === undefined ? undefined : freezeCandidate({ ...input.suns[0] });
  const fog = selectedFog === undefined ? undefined : freezeFog(selectedFog);
  const signatureInput = {
    environments: selected === undefined ? [] : [selected],
    fogs: selectedFog === undefined ? [] : [selectedFog],
    suns: input.suns,
  };
  const signatures = environmentFactSignatures(signatureInput);
  const result = {
    source: Object.freeze(source),
    fog,
    ...(sky.value === undefined ? {} : { sky: sky.value }),
    ...signatures,
    revision: 0,
    sun,
  } as SelectedEnvironmentFrame;
  return ok(Object.freeze(result));
}
