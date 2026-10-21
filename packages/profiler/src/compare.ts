import { buildProfileModel, type ProfileModel, type ProfilePhaseModel, phaseKey } from './model.js';
import type { ProfileArtifactError } from './schema.js';
import type { ProfileResult } from './types.js';

export type ProfileComparisonPhaseIdentity = Pick<
  ProfilePhaseModel,
  'source' | 'phase' | 'parentSource' | 'parentPhase'
>;

export type ProfileComparisonPhaseFact = Pick<
  ProfilePhaseModel,
  'count' | 'skipCount' | 'p95DurationMicros'
>;

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

export type ProfileComparisonSide = Pick<ProfileModel, 'summary'>;

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

function withSide(
  side: ProfileComparisonError['detail']['side'],
  error: ProfileArtifactError,
): ProfileComparisonError {
  return {
    ...error,
    detail: { ...error.detail, side },
  };
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
  return {
    count: right.count - left.count,
    skipCount: right.skipCount - left.skipCount,
    ...(comparableTimeUnit && left.p95DurationMicros !== null && right.p95DurationMicros !== null
      ? { p95DurationMicros: right.p95DurationMicros - left.p95DurationMicros }
      : {}),
  };
}

function projectPhases(
  left: ProfileModel,
  right: ProfileModel,
): readonly ProfileComparisonPhaseRow[] {
  const rows = new Map<string, ProfileComparisonPhaseRow>();
  const comparableTimeUnit = left.summary.timeUnit === right.summary.timeUnit;
  for (const phase of left.phases) {
    rows.set(phaseKey(phase), { identity: phaseIdentity(phase), left: phaseFact(phase) });
  }
  for (const phase of right.phases) {
    const key = phaseKey(phase);
    const row = rows.get(key);
    const rightFact = phaseFact(phase);
    const delta = phaseDelta(row?.left, rightFact, comparableTimeUnit);
    rows.set(key, {
      ...(row ?? { identity: phaseIdentity(phase) }),
      right: rightFact,
      ...(delta === undefined ? {} : { delta }),
    });
  }
  return [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

function projectModels(left: ProfileModel, right: ProfileModel): ProfileComparisonProjection {
  return {
    left: {
      summary: left.summary,
    },
    right: {
      summary: right.summary,
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
