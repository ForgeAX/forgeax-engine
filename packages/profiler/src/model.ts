import { type ProfileArtifactError, validateProfileCapture } from './schema.js';
import type { ProfileCapture, ProfilePhaseRecord, ProfileRecord, ProfileResult } from './types.js';

export interface ProfileFrameModel {
  readonly frameId: number;
  readonly recordCount: number;
  readonly phaseCount: number;
  readonly skipCount: number;
  readonly durationMicros: number;
  /** Union of all observed phase intervals in this frame, so overlapping scopes count once. */
  readonly unionDurationMicros: number;
  /** Sum of proven exclusive spans; null when retained records cannot prove the frame's full tree. */
  readonly selfDurationMicros: number | null;
  readonly records: readonly ProfileRecord[];
}

export interface ProfileDurationDistribution {
  readonly sampleCount: number;
  readonly totalDurationMicros: number;
  readonly p50DurationMicros: number | null;
  readonly p90DurationMicros: number | null;
  readonly p95DurationMicros: number | null;
  readonly p99DurationMicros: number | null;
  readonly maxDurationMicros: number | null;
}

export interface ProfilePhaseModel
  extends Pick<ProfilePhaseRecord, 'source' | 'phase' | 'parentSource' | 'parentPhase'> {
  readonly count: number;
  readonly skipCount: number;
  readonly totalDurationMicros: number;
  /** Sum of observed interval unions within each frame for this phase identity. */
  readonly unionDurationMicros: number;
  /** Sum of exclusive spans, absent when retained records cannot prove every parent/child link. */
  readonly selfDurationMicros: number | null;
  /** Per-invocation samples for this phase identity. */
  readonly callDuration: ProfileDurationDistribution;
  /** Per-frame interval-union samples, with zero for frames without a call. */
  readonly frameDuration: ProfileDurationDistribution;
  readonly calledFrameCount: number;
  readonly p95DurationMicros: number | null;
}

export interface ProfilePhaseInvocationModel
  extends Pick<
    ProfilePhaseRecord,
    | 'frameId'
    | 'source'
    | 'phase'
    | 'parentSource'
    | 'parentPhase'
    | 'startMicros'
    | 'endMicros'
    | 'durationMicros'
  > {
  readonly recordIndex: number;
  readonly parentRecordIndex?: number;
  readonly childRecordIndices: readonly number[];
  /** Null when the capture is incomplete or this invocation's parent is orphaned. */
  readonly selfDurationMicros: number | null;
}

export interface ProfileSummaryModel
  extends Pick<
    ProfileCapture,
    'schemaVersion' | 'captureId' | 'timeUnit' | 'frameLimit' | 'eventLimit' | 'completeness'
  > {
  readonly frameRange: { readonly first: number; readonly last: number } | null;
  readonly frameCount: number;
  readonly recordCount: number;
  readonly phaseCount: number;
  readonly skipCount: number;
  readonly p95DurationMicros: number | null;
  readonly frameDuration: ProfileDurationDistribution;
}

export interface ProfileModel {
  readonly summary: ProfileSummaryModel;
  readonly frames: readonly ProfileFrameModel[];
  readonly phases: readonly ProfilePhaseModel[];
  readonly invocations: readonly ProfilePhaseInvocationModel[];
}

export type ProfileRecordOrderEvidence = 'unspecified' | 'recorder-closure';

export interface BuildProfileModelOptions {
  /**
   * Evidence about record ordering supplied by the caller. v1 artifacts do
   * not encode recorder closure order, so imports default to interval-only
   * parent proof.
   */
  readonly orderEvidence?: ProfileRecordOrderEvidence;
}

function distribution(values: readonly number[]): ProfileDurationDistribution {
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number): number | null =>
    sorted.length === 0 ? null : (sorted[Math.ceil(sorted.length * percentile) - 1] ?? null);
  return {
    sampleCount: values.length,
    totalDurationMicros: values.reduce((total, value) => total + value, 0),
    p50DurationMicros: nearestRank(0.5),
    p90DurationMicros: nearestRank(0.9),
    p95DurationMicros: nearestRank(0.95),
    p99DurationMicros: nearestRank(0.99),
    maxDurationMicros: sorted.at(-1) ?? null,
  };
}

function distributionWithZeroSamples(
  nonzeroValues: readonly number[],
  sampleCount: number,
): ProfileDurationDistribution {
  const sorted = [...nonzeroValues].sort((left, right) => left - right);
  const zeroCount = sampleCount - sorted.length;
  const nearestRank = (percentile: number): number | null => {
    if (sampleCount === 0) return null;
    const index = Math.ceil(sampleCount * percentile) - 1;
    return index < zeroCount ? 0 : (sorted[index - zeroCount] ?? 0);
  };
  return {
    sampleCount,
    totalDurationMicros: sorted.reduce((total, value) => total + value, 0),
    p50DurationMicros: nearestRank(0.5),
    p90DurationMicros: nearestRank(0.9),
    p95DurationMicros: nearestRank(0.95),
    p99DurationMicros: nearestRank(0.99),
    maxDurationMicros: sorted.at(-1) ?? (sampleCount > 0 ? 0 : null),
  };
}

function cloneRecord(record: ProfileRecord): ProfileRecord {
  return { ...record };
}

function isRootPhase(record: ProfileRecord): record is ProfilePhaseRecord {
  return record.kind === 'phase' && record.parentPhase === undefined;
}

export function phaseKey(
  phase: Pick<ProfilePhaseModel, 'source' | 'phase' | 'parentSource' | 'parentPhase'>,
): string {
  return JSON.stringify([
    phase.source,
    phase.parentPhase === undefined ? null : (phase.parentSource ?? phase.source),
    phase.parentPhase ?? null,
    phase.phase,
  ]);
}

function buildFrames(
  records: readonly ProfileRecord[],
  invocations: readonly ProfilePhaseInvocationModel[],
): ProfileFrameModel[] {
  const frameMap = new Map<number, ProfileRecord[]>();
  const invocationsByFrame = new Map<number, ProfilePhaseInvocationModel[]>();
  for (const invocation of invocations) {
    const frameInvocations = invocationsByFrame.get(invocation.frameId);
    if (frameInvocations === undefined) invocationsByFrame.set(invocation.frameId, [invocation]);
    else frameInvocations.push(invocation);
  }
  for (const record of records) {
    const frameRecords = frameMap.get(record.frameId);
    if (frameRecords === undefined) frameMap.set(record.frameId, [cloneRecord(record)]);
    else frameRecords.push(cloneRecord(record));
  }
  return [...frameMap.entries()].map(([frameId, frameRecords]) => {
    const phaseRecords = frameRecords.filter(
      (record): record is ProfilePhaseRecord => record.kind === 'phase',
    );
    const frameInvocations = invocationsByFrame.get(frameId) ?? [];
    const rootPhaseRecords = phaseRecords.filter(isRootPhase);
    return {
      frameId,
      recordCount: frameRecords.length,
      phaseCount: phaseRecords.length,
      skipCount: frameRecords.length - phaseRecords.length,
      durationMicros: intervalUnion(rootPhaseRecords),
      unionDurationMicros: intervalUnion(phaseRecords),
      selfDurationMicros: frameInvocations.every(
        (invocation) => invocation.selfDurationMicros !== null,
      )
        ? frameInvocations.reduce(
            (total, invocation) => total + (invocation.selfDurationMicros ?? 0),
            0,
          )
        : null,
      records: frameRecords,
    };
  });
}

function intervalUnion(records: readonly ProfilePhaseRecord[]): number {
  const byFrame = new Map<number, ProfilePhaseRecord[]>();
  for (const record of records) {
    const entries = byFrame.get(record.frameId);
    if (entries === undefined) byFrame.set(record.frameId, [record]);
    else entries.push(record);
  }
  let union = 0;
  for (const entries of byFrame.values()) {
    entries.sort(
      (left, right) => left.startMicros - right.startMicros || left.endMicros - right.endMicros,
    );
    let start: number | undefined;
    let end: number | undefined;
    for (const entry of entries) {
      if (start === undefined || end === undefined) {
        start = entry.startMicros;
        end = entry.endMicros;
      } else if (entry.startMicros <= end) end = Math.max(end, entry.endMicros);
      else {
        union += end - start;
        start = entry.startMicros;
        end = entry.endMicros;
      }
    }
    if (start !== undefined && end !== undefined) union += end - start;
  }
  return union;
}

function incompleteFrame(frameId: number, completeness: ProfileCapture['completeness']): boolean {
  if (completeness.status === 'complete') return false;
  if (
    completeness.firstAffectedFrameId !== undefined &&
    completeness.lastAffectedFrameId !== undefined
  )
    return (
      frameId >= completeness.firstAffectedFrameId && frameId <= completeness.lastAffectedFrameId
    );
  return true;
}

function buildInvocations(
  records: readonly ProfileRecord[],
  completeness: ProfileCapture['completeness'],
  orderEvidence: NonNullable<BuildProfileModelOptions['orderEvidence']>,
): ProfilePhaseInvocationModel[] {
  const parents = new Map<number, number>();
  const children = new Map<number, number[]>();
  const orphaned = new Set<number>();
  const orphanedFrames = new Set<number>();
  const phases: Array<{ readonly record: ProfilePhaseRecord; readonly index: number }> = [];
  const candidatesByIdentity = new Map<
    string,
    Array<{ readonly record: ProfilePhaseRecord; readonly index: number }>
  >();
  const stackByFrame = new Map<
    number,
    Array<{ readonly record: ProfilePhaseRecord; readonly index: number }>
  >();

  const identity = (frameId: number, source: string, phase: string): string =>
    JSON.stringify([frameId, source, phase]);
  const expectedParentIdentity = (record: ProfilePhaseRecord): string | undefined =>
    record.parentPhase === undefined
      ? undefined
      : identity(record.frameId, record.parentSource ?? record.source, record.parentPhase);
  const attach = (parentIndex: number, childIndex: number): void => {
    if (parents.has(childIndex)) return;
    parents.set(childIndex, parentIndex);
    const siblings = children.get(parentIndex);
    if (siblings === undefined) children.set(parentIndex, [childIndex]);
    else siblings.push(childIndex);
  };

  // The live recorder's explicit closure evidence selects this linear stack
  // path, which disambiguates equal-tick repeated invocations. Imported v1
  // artifacts use interval evidence below because v1 does not record order.
  const collectInvocationCandidates = () => {
    for (const [index, record] of records.entries()) {
      if (record.kind !== 'phase') continue;
      const entry = { record, index };
      phases.push(entry);
      const candidateKey = identity(record.frameId, record.source, record.phase);
      const candidates = candidatesByIdentity.get(candidateKey);
      if (candidates === undefined) candidatesByIdentity.set(candidateKey, [entry]);
      else candidates.push(entry);

      if (orderEvidence === 'recorder-closure') {
        let stack = stackByFrame.get(record.frameId);
        if (stack === undefined) {
          stack = [];
          stackByFrame.set(record.frameId, stack);
        }
        while (stack.length > 0) {
          const child = stack[stack.length - 1];
          if (
            child === undefined ||
            child.record.parentPhase === undefined ||
            expectedParentIdentity(child.record) !== candidateKey ||
            child.record.startMicros < record.startMicros ||
            child.record.endMicros > record.endMicros
          )
            break;
          stack.pop();
          attach(index, child.index);
        }
        stack.push(entry);
      }
    }
  };
  collectInvocationCandidates();
  const pendingByParent = new Map<
    string,
    Array<{ readonly record: ProfilePhaseRecord; readonly index: number }>
  >();
  if (orderEvidence === 'unspecified')
    for (const entry of phases) {
      const key = expectedParentIdentity(entry.record);
      if (key === undefined) continue;
      const pending = pendingByParent.get(key);
      if (pending === undefined) pendingByParent.set(key, [entry]);
      else pending.push(entry);
    }

  // Resolve an order-unspecified child to the unique innermost containing parent. A
  // sweep over start times leaves only candidate intervals whose starts can
  // contain each child; a segment tree queries the least eligible end and the
  // greatest eligible start. If those extrema do not identify one interval,
  // the candidates cross or repeat an equal interval and remain ambiguous.
  const attachIntervalParents = () => {
    for (const [key, pending] of pendingByParent) {
      const candidates = candidatesByIdentity.get(key);
      if (candidates === undefined) continue;
      const orderedParents = [...candidates].sort(
        (left, right) =>
          left.record.startMicros - right.record.startMicros || left.index - right.index,
      );
      const orderedChildren = [...pending].sort(
        (left, right) =>
          left.record.startMicros - right.record.startMicros ||
          left.record.endMicros - right.record.endMicros ||
          left.index - right.index,
      );
      const ends = [...new Set(orderedParents.map(({ record }) => record.endMicros))].sort(
        (left, right) => left - right,
      );
      let treeSize = 1;
      while (treeSize < ends.length) treeSize *= 2;
      const counts = new Array<number>(treeSize * 2).fill(0);
      const maximumStarts = new Array<number>(treeSize * 2).fill(Number.NEGATIVE_INFINITY);
      const latestAtEnd = new Array<number>(ends.length).fill(-1);
      const latestStartAtEnd = new Array<number>(ends.length).fill(Number.NEGATIVE_INFINITY);
      const latestStartCountAtEnd = new Array<number>(ends.length).fill(0);
      const insert = (parent: {
        readonly record: ProfilePhaseRecord;
        readonly index: number;
      }): void => {
        const endRank = lowerBound(ends, parent.record.endMicros);
        if (latestStartAtEnd[endRank] === parent.record.startMicros)
          latestStartCountAtEnd[endRank] = (latestStartCountAtEnd[endRank] ?? 0) + 1;
        else {
          latestStartAtEnd[endRank] = parent.record.startMicros;
          latestStartCountAtEnd[endRank] = 1;
          latestAtEnd[endRank] = parent.index;
        }
        let node = treeSize + endRank;
        counts[node] = (counts[node] ?? 0) + 1;
        maximumStarts[node] = Math.max(
          maximumStarts[node] ?? Number.NEGATIVE_INFINITY,
          parent.record.startMicros,
        );
        for (node = Math.floor(node / 2); node > 0; node = Math.floor(node / 2)) {
          counts[node] = (counts[node * 2] ?? 0) + (counts[node * 2 + 1] ?? 0);
          maximumStarts[node] = Math.max(
            maximumStarts[node * 2] ?? Number.NEGATIVE_INFINITY,
            maximumStarts[node * 2 + 1] ?? Number.NEGATIVE_INFINITY,
          );
        }
      };
      const firstWithCount = (node: number, low: number, high: number, from: number): number => {
        if (high <= from || (counts[node] ?? 0) === 0) return -1;
        if (high - low === 1) return low;
        const middle = (low + high) >>> 1;
        const left = firstWithCount(node * 2, low, middle, from);
        return left >= 0 ? left : firstWithCount(node * 2 + 1, middle, high, from);
      };
      const maximumInSuffix = (from: number): number => {
        let left = treeSize + from;
        let right = treeSize + ends.length;
        let maximum = Number.NEGATIVE_INFINITY;
        while (left < right) {
          if ((left & 1) === 1)
            maximum = Math.max(maximum, maximumStarts[left++] ?? Number.NEGATIVE_INFINITY);
          if ((right & 1) === 1)
            maximum = Math.max(maximum, maximumStarts[--right] ?? Number.NEGATIVE_INFINITY);
          left = Math.floor(left / 2);
          right = Math.floor(right / 2);
        }
        return maximum;
      };
      let parentCursor = 0;
      for (const child of orderedChildren) {
        while (
          parentCursor < orderedParents.length &&
          (orderedParents[parentCursor]?.record.startMicros ?? Number.POSITIVE_INFINITY) <=
            child.record.startMicros
        ) {
          const parent = orderedParents[parentCursor];
          if (parent === undefined) break;
          insert(parent);
          parentCursor += 1;
        }
        const firstEnd = lowerBound(ends, child.record.endMicros);
        const nearestEnd = firstWithCount(1, 0, treeSize, firstEnd);
        if (nearestEnd < 0 || nearestEnd >= ends.length) continue;
        const maximumStart = maximumInSuffix(firstEnd);
        const parentIndex = latestAtEnd[nearestEnd] ?? -1;
        if (
          parentIndex >= 0 &&
          latestStartAtEnd[nearestEnd] === maximumStart &&
          latestStartCountAtEnd[nearestEnd] === 1
        ) {
          attach(parentIndex, child.index);
        }
      }
    }
  };
  attachIntervalParents();
  for (const entry of phases) {
    if (entry.record.parentPhase === undefined || parents.has(entry.index)) continue;
    orphaned.add(entry.index);
    orphanedFrames.add(entry.record.frameId);
  }

  // Even individually plausible links can form a cycle when schema-valid
  // parent-first rows repeat the same interval under different phase names.
  // Remove every edge in such a cycle and withhold self time for that frame.
  const removeInvocationCycles = () => {
    const state = new Map<number, 0 | 1 | 2>();
    for (const entry of phases) {
      if (state.get(entry.index) !== undefined) continue;
      const path: number[] = [];
      const positionByRecord = new Map<number, number>();
      let current: number | undefined = entry.index;
      while (current !== undefined && state.get(current) === undefined) {
        state.set(current, 1);
        positionByRecord.set(current, path.length);
        path.push(current);
        current = parents.get(current);
      }
      if (current !== undefined && state.get(current) === 1) {
        const cycleStart = positionByRecord.get(current);
        if (cycleStart !== undefined) {
          for (const cycleIndex of path.slice(cycleStart)) {
            parents.delete(cycleIndex);
            orphaned.add(cycleIndex);
            const cycleRecord = records[cycleIndex];
            if (cycleRecord?.kind === 'phase') orphanedFrames.add(cycleRecord.frameId);
          }
        }
      }
      for (const pathIndex of path) state.set(pathIndex, 2);
    }
  };
  removeInvocationCycles();
  children.clear();
  for (const [childIndex, parentIndex] of parents) {
    const siblings = children.get(parentIndex);
    if (siblings === undefined) children.set(parentIndex, [childIndex]);
    else siblings.push(childIndex);
  }

  return phases.map(({ record, index: recordIndex }) => {
    const childRecords = (children.get(recordIndex) ?? []).flatMap((index) => {
      const child = records[index];
      return child?.kind === 'phase' ? [child] : [];
    });
    const complete =
      !incompleteFrame(record.frameId, completeness) &&
      !orphaned.has(recordIndex) &&
      !orphanedFrames.has(record.frameId);
    const selfDurationMicros = complete
      ? Math.max(0, record.durationMicros - intervalUnion(childRecords))
      : null;
    const parentRecordIndex = parents.get(recordIndex);
    return {
      recordIndex,
      frameId: record.frameId,
      source: record.source,
      phase: record.phase,
      ...(record.parentSource === undefined ? {} : { parentSource: record.parentSource }),
      ...(record.parentPhase === undefined ? {} : { parentPhase: record.parentPhase }),
      startMicros: record.startMicros,
      endMicros: record.endMicros,
      durationMicros: record.durationMicros,
      ...(parentRecordIndex === undefined ? {} : { parentRecordIndex }),
      childRecordIndices: Object.freeze([...(children.get(recordIndex) ?? [])]),
      selfDurationMicros,
    };
  });
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildPhases(
  records: readonly ProfileRecord[],
  invocations: readonly ProfilePhaseInvocationModel[],
  frameIds: readonly number[],
): ProfilePhaseModel[] {
  const phaseMap = new Map<
    string,
    {
      source: ProfilePhaseRecord['source'];
      phase: string;
      parentSource: ProfilePhaseRecord['source'] | undefined;
      parentPhase: string | undefined;
      durations: number[];
      phaseRecordsByFrame: Map<number, ProfilePhaseRecord[]>;
      invocations: ProfilePhaseInvocationModel[];
      skipCount: number;
    }
  >();
  const invocationByRecordIndex = new Map(
    invocations.map((invocation) => [invocation.recordIndex, invocation] as const),
  );
  for (const [recordIndex, record] of records.entries()) {
    const parentSource =
      record.kind === 'phase' && record.parentPhase !== undefined
        ? (record.parentSource ?? record.source)
        : undefined;
    const parentPhase = record.kind === 'phase' ? record.parentPhase : undefined;
    const key = phaseKey(record);
    let entry = phaseMap.get(key);
    if (entry === undefined) {
      entry = {
        source: record.source,
        phase: record.phase,
        parentSource,
        parentPhase,
        durations: [],
        phaseRecordsByFrame: new Map(),
        invocations: [],
        skipCount: 0,
      };
      phaseMap.set(key, entry);
    }
    if (record.kind === 'phase') {
      entry.durations.push(record.durationMicros);
      const framePhaseRecords = entry.phaseRecordsByFrame.get(record.frameId);
      if (framePhaseRecords === undefined) entry.phaseRecordsByFrame.set(record.frameId, [record]);
      else framePhaseRecords.push(record);
      const invocation = invocationByRecordIndex.get(recordIndex);
      if (invocation !== undefined) entry.invocations.push(invocation);
    } else entry.skipCount += 1;
  }
  return [...phaseMap.values()].map(
    ({
      source,
      phase,
      parentSource,
      parentPhase,
      durations,
      phaseRecordsByFrame,
      invocations,
      skipCount,
    }) => {
      const perFrameUnion = [...phaseRecordsByFrame.values()].map(intervalUnion);
      const callDuration = distribution(durations);
      return {
        source,
        phase,
        ...(parentSource === undefined ? {} : { parentSource }),
        ...(parentPhase === undefined ? {} : { parentPhase }),
        count: durations.length,
        skipCount,
        totalDurationMicros: callDuration.totalDurationMicros,
        unionDurationMicros: perFrameUnion.reduce((total, value) => total + value, 0),
        selfDurationMicros:
          invocations.length > 0 &&
          invocations.every((invocation) => invocation.selfDurationMicros !== null)
            ? invocations.reduce(
                (total, invocation) => total + (invocation.selfDurationMicros ?? 0),
                0,
              )
            : null,
        callDuration,
        frameDuration: distributionWithZeroSamples(
          perFrameUnion.filter((value) => value > 0),
          frameIds.length,
        ),
        calledFrameCount: phaseRecordsByFrame.size,
        p95DurationMicros: callDuration.p95DurationMicros,
      };
    },
  );
}

export function buildProfileModel(
  value: unknown,
  options: BuildProfileModelOptions = {},
): ProfileResult<ProfileModel, ProfileArtifactError> {
  const validated = validateProfileCapture(value);
  if (!validated.ok) return validated;
  const capture = validated.value;
  const invocations = buildInvocations(
    capture.records,
    capture.completeness,
    options.orderEvidence ?? 'unspecified',
  );
  const frames = buildFrames(capture.records, invocations);
  const phases = buildPhases(
    capture.records,
    invocations,
    frames.map((frame) => frame.frameId),
  );
  const frameDuration = distribution(frames.map((frame) => frame.durationMicros));
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
        p95DurationMicros: frameDuration.p95DurationMicros,
        frameDuration,
      },
      frames,
      phases,
      invocations,
    },
  };
}
