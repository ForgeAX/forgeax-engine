import { err, ok, type Result } from '@forgeax/engine-types';
import { EnvironmentSourceConflictError, FogCardinalityError } from '../errors/render';
import type {
  EnvironmentCandidate,
  EnvironmentFrame,
  EnvironmentSource,
  FogCandidate,
  FogFrame,
} from '../extract/environment';
import {
  freezeAtmosphere,
  validateAtmosphereParameters,
  validateFogParameters,
} from '../extract/environment';
import { environmentFactSignatures } from './signature';

export type { EnvironmentCandidate, EnvironmentFrame, EnvironmentSource, FogCandidate, FogFrame };

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
  readonly lane: 'direct' | 'clustered';
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
    super(`environment selection field ${field} is invalid`);
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

export interface EnvironmentSelectionErrorDetail {
  readonly owners?: readonly {
    readonly kind: 'image' | 'atmosphere';
    readonly entityKey: number;
    readonly sourceKey: string;
  }[];
  readonly field?: string;
  readonly value?: number;
  readonly count?: number;
}

export interface EnvironmentSelectionError {
  readonly code:
    | 'environment-source-conflict'
    | 'fog-cardinality'
    | 'environment-selection-invalid'
    | 'atmosphere-invalid-parameter'
    | 'sun-cardinality';
  readonly expected: string;
  readonly hint: string;
  readonly detail: EnvironmentSelectionErrorDetail;
}

export interface SelectedEnvironmentFrame extends EnvironmentFrame {
  readonly sun: SunCandidate | undefined;
  readonly lane: 'direct' | 'clustered';
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

/** Select one immutable frame fact set for both Standard lighting lanes. */
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
    ...signatures,
    revision: 0,
    sun,
  } as SelectedEnvironmentFrame;
  Object.defineProperty(result, 'lane', { value: input.lane, enumerable: false });
  return ok(Object.freeze(result));
}
