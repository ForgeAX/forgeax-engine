import {
  buildProfileModel,
  type ProfileModel,
  type ProfilePhaseModel,
  type ProfileSummaryModel,
} from './model.js';
import type { ProfileArtifactError } from './schema.js';
import type { ProfileCapture, ProfileResult } from './types.js';

export interface ProfileComparisonPhaseIdentity {
  readonly source: ProfilePhaseModel['source'];
  readonly phase: string;
  readonly parentSource?: ProfilePhaseModel['parentSource'];
  readonly parentPhase?: string;
}

export interface ProfileComparisonPhaseFact {
  readonly count: number;
  readonly skipCount: number;
  readonly p95DurationMicros: number | null;
}

export interface ProfileComparisonPhaseDelta {
  readonly count?: number;
  readonly skipCount?: number;
  readonly p95DurationMicros?: number;
}

export interface ProfileComparisonPhaseRow {
  readonly identity: ProfileComparisonPhaseIdentity;
  readonly left?: ProfileComparisonPhaseFact;
  readonly right?: ProfileComparisonPhaseFact;
  readonly delta?: ProfileComparisonPhaseDelta;
}

export interface ProfileComparisonSide {
  readonly summary: ProfileSummaryModel;
  readonly completeness: ProfileCapture['completeness'];
}

export interface ProfileComparisonProjection {
  readonly left: ProfileComparisonSide;
  readonly right: ProfileComparisonSide;
  readonly phases: readonly ProfileComparisonPhaseRow[];
}

export type ProfileComparisonError = ProfileArtifactError & {
  readonly detail: ProfileArtifactError['detail'] & {
    readonly side: 'left' | 'right';
  };
};

function withSide(side: 'left' | 'right', error: ProfileArtifactError): ProfileComparisonError {
  return {
    ...error,
    detail: { ...error.detail, side },
  };
}

function phaseKey(phase: ProfilePhaseModel): string {
  return JSON.stringify([
    phase.source,
    phase.parentSource ?? null,
    phase.parentPhase ?? null,
    phase.phase,
  ]);
}

function phaseIdentity(phase: ProfilePhaseModel): ProfileComparisonPhaseIdentity {
  return {
    source: phase.source,
    phase: phase.phase,
    ...(phase.parentSource === undefined ? {} : { parentSource: phase.parentSource }),
    ...(phase.parentPhase === undefined ? {} : { parentPhase: phase.parentPhase }),
  };
}

function phaseFact(phase: ProfilePhaseModel): ProfileComparisonPhaseFact {
  return {
    count: phase.count,
    skipCount: phase.skipCount,
    p95DurationMicros: phase.p95DurationMicros,
  };
}

function phaseDelta(
  left: ProfileComparisonPhaseFact | undefined,
  right: ProfileComparisonPhaseFact | undefined,
  comparableTimeUnit: boolean,
): ProfileComparisonPhaseDelta | undefined {
  if (left === undefined || right === undefined) return undefined;
  const delta: {
    count?: number;
    skipCount?: number;
    p95DurationMicros?: number;
  } = {
    count: right.count - left.count,
    skipCount: right.skipCount - left.skipCount,
  };
  if (comparableTimeUnit && left.p95DurationMicros !== null && right.p95DurationMicros !== null) {
    delta.p95DurationMicros = right.p95DurationMicros - left.p95DurationMicros;
  }
  return delta;
}

function projectPhases(
  left: ProfileModel,
  right: ProfileModel,
): readonly ProfileComparisonPhaseRow[] {
  const leftByKey = new Map(left.phases.map((phase) => [phaseKey(phase), phase]));
  const rightByKey = new Map(right.phases.map((phase) => [phaseKey(phase), phase]));
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const comparableTimeUnit = left.summary.timeUnit === right.summary.timeUnit;

  return keys.map((key) => {
    const leftPhase = leftByKey.get(key);
    const rightPhase = rightByKey.get(key);
    const leftFact = leftPhase === undefined ? undefined : phaseFact(leftPhase);
    const rightFact = rightPhase === undefined ? undefined : phaseFact(rightPhase);
    const delta = phaseDelta(leftFact, rightFact, comparableTimeUnit);
    return {
      identity: phaseIdentity(leftPhase ?? (rightPhase as ProfilePhaseModel)),
      ...(leftFact === undefined ? {} : { left: leftFact }),
      ...(rightFact === undefined ? {} : { right: rightFact }),
      ...(delta === undefined ? {} : { delta }),
    };
  });
}

function projectModels(left: ProfileModel, right: ProfileModel): ProfileComparisonProjection {
  return {
    left: {
      summary: left.summary,
      completeness: left.completeness,
    },
    right: {
      summary: right.summary,
      completeness: right.completeness,
    },
    phases: projectPhases(left, right),
  };
}

/** Compares two imported ProfileCapture artifacts without mutating either input. */
export function compareProfileCaptures(
  left: unknown,
  right: unknown,
): ProfileResult<ProfileComparisonProjection, ProfileComparisonError> {
  const leftModel = buildProfileModel(left);
  if (!leftModel.ok) return { ok: false, error: withSide('left', leftModel.error) };

  const rightModel = buildProfileModel(right);
  if (!rightModel.ok) return { ok: false, error: withSide('right', rightModel.error) };

  return { ok: true, value: projectModels(leftModel.value, rightModel.value) };
}
