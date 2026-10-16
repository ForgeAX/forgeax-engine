import { type ProfileArtifactError, validateProfileCapture } from './schema.js';
import type { ProfileCapture, ProfilePhaseRecord, ProfileRecord, ProfileResult } from './types.js';

export interface ProfileFrameModel {
  readonly frameId: number;
  readonly recordCount: number;
  readonly phaseCount: number;
  readonly skipCount: number;
  readonly durationMicros: number;
  readonly records: readonly ProfileRecord[];
}

export interface ProfilePhaseModel {
  readonly source: ProfilePhaseRecord['source'];
  readonly phase: string;
  readonly parentSource?: ProfilePhaseRecord['source'];
  readonly parentPhase?: string;
  readonly count: number;
  readonly skipCount: number;
  readonly p95DurationMicros: number | null;
}

export interface ProfileSummaryModel {
  readonly schemaVersion: ProfileCapture['schemaVersion'];
  readonly captureId: string;
  readonly timeUnit: ProfileCapture['timeUnit'];
  readonly frameLimit: number;
  readonly eventLimit: number;
  readonly completeness: ProfileCapture['completeness'];
  readonly frameRange: { readonly first: number; readonly last: number } | null;
  readonly frameCount: number;
  readonly recordCount: number;
  readonly phaseCount: number;
  readonly skipCount: number;
  readonly p95DurationMicros: number | null;
}

export interface ProfileModel {
  readonly summary: ProfileSummaryModel;
  readonly completeness: ProfileCapture['completeness'];
  readonly frames: readonly ProfileFrameModel[];
  readonly phases: readonly ProfilePhaseModel[];
}

function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function cloneRecord(record: ProfileRecord): ProfileRecord {
  return { ...record };
}

function isRootPhase(record: ProfileRecord): record is ProfilePhaseRecord {
  return record.kind === 'phase' && record.parentPhase === undefined;
}

function buildFrames(records: readonly ProfileRecord[]): ProfileFrameModel[] {
  const frameMap = new Map<number, ProfileRecord[]>();
  for (const record of records) {
    const frameRecords = frameMap.get(record.frameId);
    if (frameRecords === undefined) frameMap.set(record.frameId, [cloneRecord(record)]);
    else frameRecords.push(cloneRecord(record));
  }
  return [...frameMap.entries()].map(([frameId, frameRecords]) => ({
    frameId,
    recordCount: frameRecords.length,
    phaseCount: frameRecords.filter((record) => record.kind === 'phase').length,
    skipCount: frameRecords.filter((record) => record.kind === 'skip').length,
    durationMicros: frameRecords.reduce(
      (total, record) => total + (isRootPhase(record) ? record.durationMicros : 0),
      0,
    ),
    records: frameRecords,
  }));
}

function buildPhases(records: readonly ProfileRecord[]): ProfilePhaseModel[] {
  const phaseMap = new Map<
    string,
    {
      source: ProfilePhaseRecord['source'];
      phase: string;
      parentSource: ProfilePhaseRecord['source'] | undefined;
      parentPhase: string | undefined;
      durations: number[];
      skipCount: number;
    }
  >();
  for (const record of records) {
    const parentSource = record.kind === 'phase' ? record.parentSource : undefined;
    const parentPhase = record.kind === 'phase' ? record.parentPhase : undefined;
    const key = `${record.source}:${parentSource ?? ''}:${parentPhase ?? ''}:${record.phase}`;
    let entry = phaseMap.get(key);
    if (entry === undefined) {
      entry = {
        source: record.source,
        phase: record.phase,
        parentSource,
        parentPhase,
        durations: [],
        skipCount: 0,
      };
      phaseMap.set(key, entry);
    }
    if (record.kind === 'phase') entry.durations.push(record.durationMicros);
    else entry.skipCount += 1;
  }
  return [...phaseMap.values()].map(
    ({ source, phase, parentSource, parentPhase, durations, skipCount }) => ({
      source,
      phase,
      ...(parentSource === undefined ? {} : { parentSource }),
      ...(parentPhase === undefined ? {} : { parentPhase }),
      count: durations.length,
      skipCount,
      p95DurationMicros: nearestRankP95(durations),
    }),
  );
}

export function buildProfileModel(
  value: unknown,
): ProfileResult<ProfileModel, ProfileArtifactError> {
  const validated = validateProfileCapture(value);
  if (!validated.ok) return validated;
  const capture = validated.value;
  const frames = buildFrames(capture.records);
  const phases = buildPhases(capture.records);
  const durations = capture.records.filter(isRootPhase).map((record) => record.durationMicros);
  const completeness = { ...capture.completeness };
  const phaseCount = capture.records.filter((record) => record.kind === 'phase').length;
  const skipCount = capture.records.length - phaseCount;
  const frameRange =
    frames.length === 0
      ? null
      : { first: frames[0]?.frameId as number, last: frames[frames.length - 1]?.frameId as number };
  return {
    ok: true,
    value: {
      summary: {
        schemaVersion: capture.schemaVersion,
        captureId: capture.captureId,
        timeUnit: capture.timeUnit,
        frameLimit: capture.frameLimit,
        eventLimit: capture.eventLimit,
        completeness,
        frameRange,
        frameCount: frames.length,
        recordCount: capture.records.length,
        phaseCount,
        skipCount,
        p95DurationMicros: nearestRankP95(durations),
      },
      completeness,
      frames,
      phases,
    },
  };
}
