import type { ProfileClock } from './clock.js';
import { boundaryError, type ProfilerResult, stateError } from './errors.js';
import type {
  ProfileCapture,
  ProfilePhaseStart,
  ProfileRecord,
  ProfileSkipInput,
  ProfileSource,
} from './types.js';

export interface RecorderLimits {
  readonly frameLimit: number;
  readonly eventLimit: number;
  readonly detail?: ProfileDetail;
}

export type ProfileDetail = 'owner' | 'passes' | 'nested';

export type RecorderPhaseCatalog = Readonly<Record<ProfileSource, readonly string[]>>;

export interface RecorderSession {
  readonly captureId: string;
  readonly detail: ProfileDetail;
  beginFrame(frameId: number): ProfilerResult<void>;
  beginPhase(input: ProfilePhaseStart): ProfilerResult<void>;
  beginPhase(source: ProfileSource, phase: string): ProfilerResult<void>;
  endPhase(): ProfilerResult<void>;
  recordSkip(input: ProfileSkipInput): ProfilerResult<void>;
  endFrame(): ProfilerResult<void>;
  finish(): ProfilerResult<ProfileCapture>;
}

const PHASE_RECORD_KIND = 1;
const SKIP_RECORD_KIND = 2;
// Keep the hot capture path out of repeated sparse-array growth while still
// bounding the up-front reservation for callers that choose a very large
// event limit. The recorder grows beyond this reserve on demand.
const INITIAL_RECORD_CAPACITY = 65_536;

interface RetainedRecordStore {
  readonly kinds: number[];
  readonly sources: ProfileSource[];
  readonly phases: string[];
  readonly frameIds: number[];
  readonly parentSources: Array<ProfileSource | undefined>;
  readonly parentPhases: Array<string | undefined>;
  readonly startMicros: number[];
  readonly endMicros: number[];
  readonly reasons: Array<string | undefined>;
  count: number;
}

interface RecorderState {
  readonly limits: RecorderLimits;
  readonly phaseCatalog: RecorderPhaseCatalog;
  readonly phaseCache: Record<
    ProfileSource,
    { definition: readonly string[]; names: ReadonlySet<string> }
  >;
  readonly recordStore: RetainedRecordStore;
  readonly captureId: string;
  readonly allocationReport: { profilerEventObjectAllocations: number } | undefined;
  frameCount: number;
  lastFrameId: number;
  currentFrameId: number | undefined;
  openSources: Array<ProfileSource | undefined>;
  openPhaseNames: Array<string | undefined>;
  openStartMicros: Array<number | undefined>;
  openDepth: number;
  droppedEventCount: number;
  firstAffectedFrameId: number | undefined;
  lastAffectedFrameId: number | undefined;
  finished: boolean;
}

const OK_VOID: ProfilerResult<void> = Object.freeze({ ok: true, value: undefined });

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateRecorderLimits(limits: RecorderLimits): ProfilerResult<void> {
  if (!positiveSafeInteger(limits.frameLimit) || !positiveSafeInteger(limits.eventLimit)) {
    return { ok: false, error: boundaryError(limits.frameLimit, limits.eventLimit) };
  }
  return OK_VOID;
}

function recordOverflow(state: RecorderState, frameId: number): void {
  state.droppedEventCount += 1;
  state.firstAffectedFrameId ??= frameId;
  state.lastAffectedFrameId = frameId;
}

function stateResult(state: RecorderState, operation: string): ProfilerResult<void> {
  if (state.finished) return { ok: false, error: stateError(operation) };
  return OK_VOID;
}

function sourceHasPhase(state: RecorderState, source: string, phase: string): boolean {
  if (source !== 'app' && source !== 'render') return false;
  const key = source;
  const phases = state.phaseCatalog[key];
  if (state.phaseCache[key].definition !== phases) {
    state.phaseCache[key] = { definition: phases, names: new Set(phases) };
  }
  return state.phaseCache[key].names.has(phase);
}

function sourceError(source: string, phase: string, frameId: number): ProfilerResult<never> {
  return {
    ok: false,
    error: {
      code: 'profile-source-failed',
      expected: 'a phase declared by the source catalog',
      hint: 'Use the source-owned phase catalog and retry the frame.',
      detail: { source, phase, frameId },
    },
  };
}

function requireRetained<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('profiler record storage is incomplete');
  return value;
}

function reserveRecord(state: RecorderState, frameId: number): number | undefined {
  if (state.recordStore.count >= state.limits.eventLimit) {
    recordOverflow(state, frameId);
    return undefined;
  }
  const index = state.recordStore.count;
  state.recordStore.count += 1;
  return index;
}

function retainPhaseRecord(
  state: RecorderState,
  source: ProfileSource,
  frameId: number,
  phase: string,
  parentSource: ProfileSource | undefined,
  parentPhase: string | undefined,
  startMicros: number,
  endMicros: number,
): void {
  const index = reserveRecord(state, frameId);
  if (index === undefined) return;
  const records = state.recordStore;
  records.kinds[index] = PHASE_RECORD_KIND;
  records.sources[index] = source;
  records.frameIds[index] = frameId;
  records.phases[index] = phase;
  records.parentSources[index] = parentSource;
  records.parentPhases[index] = parentPhase;
  records.startMicros[index] = startMicros;
  records.endMicros[index] = endMicros;
}

function retainSkipRecord(
  state: RecorderState,
  source: ProfileSource,
  frameId: number,
  phase: string,
  reason: string,
): void {
  const index = reserveRecord(state, frameId);
  if (index === undefined) return;
  const records = state.recordStore;
  records.kinds[index] = SKIP_RECORD_KIND;
  records.sources[index] = source;
  records.frameIds[index] = frameId;
  records.phases[index] = phase;
  records.reasons[index] = reason;
}

function materializeRecords(state: RecorderState): ProfileRecord[] {
  const retained = state.recordStore;
  const records = new Array<ProfileRecord>(retained.count);
  for (let index = 0; index < retained.count; index += 1) {
    const kind = requireRetained(retained.kinds[index]);
    const source = requireRetained(retained.sources[index]);
    const frameId = requireRetained(retained.frameIds[index]);
    const phase = requireRetained(retained.phases[index]);
    if (kind === PHASE_RECORD_KIND) {
      const parentSource = retained.parentSources[index];
      const parentPhase = retained.parentPhases[index];
      const startMicros = requireRetained(retained.startMicros[index]);
      const endMicros = requireRetained(retained.endMicros[index]);
      records[index] = {
        kind: 'phase',
        source,
        frameId,
        phase,
        startMicros,
        endMicros,
        durationMicros: endMicros - startMicros,
        ...(parentSource === undefined
          ? {}
          : { parentSource, parentPhase: requireRetained(parentPhase) }),
      };
    } else {
      records[index] = {
        kind: 'skip',
        source,
        frameId,
        phase,
        reason: requireRetained(retained.reasons[index]),
      };
    }
    if (state.allocationReport !== undefined) {
      state.allocationReport.profilerEventObjectAllocations += 1;
    }
  }
  return records;
}

function buildCapture(state: RecorderState): ProfileCapture {
  const status =
    state.droppedEventCount > 0
      ? 'overflow'
      : state.frameCount < state.limits.frameLimit || state.currentFrameId !== undefined
        ? 'partial'
        : 'complete';
  const completeness = {
    status,
    retainedEventCount: state.recordStore.count,
    droppedEventCount: state.droppedEventCount,
    ...(status === 'partial' ? { incompleteReason: 'stopped-before-frame' } : {}),
    ...(state.firstAffectedFrameId !== undefined
      ? { firstAffectedFrameId: state.firstAffectedFrameId }
      : {}),
    ...(state.lastAffectedFrameId !== undefined
      ? { lastAffectedFrameId: state.lastAffectedFrameId }
      : {}),
  } as ProfileCapture['completeness'];
  return {
    schemaVersion: '1.0',
    captureId: state.captureId,
    timeUnit: 'microseconds',
    frameLimit: state.limits.frameLimit,
    eventLimit: state.limits.eventLimit,
    phaseCatalog: {
      app: [...state.phaseCatalog.app],
      render: [...state.phaseCatalog.render],
    },
    records: materializeRecords(state),
    completeness,
  };
}

export function createRecorder(
  captureId: string,
  limits: RecorderLimits,
  clock: ProfileClock,
  phaseCatalog: RecorderPhaseCatalog,
  allocationReport?: { profilerEventObjectAllocations: number },
): ProfilerResult<RecorderSession> {
  const validLimits = validateRecorderLimits(limits);
  if (!validLimits.ok) return validLimits;
  const initialRecordCapacity = Math.min(limits.eventLimit, INITIAL_RECORD_CAPACITY);
  const state: RecorderState = {
    limits,
    phaseCatalog,
    phaseCache: {
      app: { definition: phaseCatalog.app, names: new Set(phaseCatalog.app) },
      render: { definition: phaseCatalog.render, names: new Set(phaseCatalog.render) },
    },
    recordStore: {
      kinds: new Array(initialRecordCapacity),
      sources: new Array(initialRecordCapacity),
      phases: new Array(initialRecordCapacity),
      frameIds: new Array(initialRecordCapacity),
      parentSources: new Array(initialRecordCapacity),
      parentPhases: new Array(initialRecordCapacity),
      startMicros: new Array(initialRecordCapacity),
      endMicros: new Array(initialRecordCapacity),
      reasons: new Array(initialRecordCapacity),
      count: 0,
    },
    captureId,
    allocationReport,
    frameCount: 0,
    lastFrameId: 0,
    currentFrameId: undefined,
    openSources: [],
    openPhaseNames: [],
    openStartMicros: [],
    openDepth: 0,
    droppedEventCount: 0,
    firstAffectedFrameId: undefined,
    lastAffectedFrameId: undefined,
    finished: false,
  };

  const session: RecorderSession = {
    captureId,
    detail: limits.detail ?? 'owner',
    beginFrame(frameId) {
      const stateCheck = stateResult(state, 'beginFrame');
      if (!stateCheck.ok) return stateCheck;
      if (
        !positiveSafeInteger(frameId) ||
        state.currentFrameId !== undefined ||
        frameId <= state.lastFrameId
      ) {
        return { ok: false, error: stateError('beginFrame') };
      }
      state.lastFrameId = frameId;
      state.currentFrameId = frameId;
      state.frameCount += 1;
      if (state.frameCount > state.limits.frameLimit)
        recordOverflow(state, state.limits.frameLimit);
      return OK_VOID;
    },
    beginPhase(inputOrSource: ProfilePhaseStart | ProfileSource, phaseName?: string) {
      const stateCheck = stateResult(state, 'beginPhase');
      if (!stateCheck.ok) return stateCheck;
      const frameId = state.currentFrameId;
      if (frameId === undefined) return { ok: false, error: stateError('beginPhase') };
      const source = typeof inputOrSource === 'string' ? inputOrSource : inputOrSource.source;
      const phase = typeof inputOrSource === 'string' ? phaseName : inputOrSource.phase;
      if (phase === undefined) return { ok: false, error: stateError('beginPhase') };
      if (!sourceHasPhase(state, source, phase)) return sourceError(source, phase, frameId);
      const index = state.openDepth;
      state.openSources[index] = source;
      state.openPhaseNames[index] = phase;
      state.openStartMicros[index] = clock.nowMicros();
      state.openDepth += 1;
      return OK_VOID;
    },
    endPhase() {
      const stateCheck = stateResult(state, 'endPhase');
      if (!stateCheck.ok) return stateCheck;
      if (state.openDepth === 0) return { ok: false, error: stateError('endPhase') };
      const index = state.openDepth - 1;
      state.openDepth = index;
      const source = state.openSources[index];
      const phase = state.openPhaseNames[index];
      const frameId = state.currentFrameId;
      const startMicros = state.openStartMicros[index];
      if (
        source === undefined ||
        phase === undefined ||
        frameId === undefined ||
        startMicros === undefined
      ) {
        return { ok: false, error: stateError('endPhase') };
      }
      const parentIndex = index - 1;
      const parentSource = parentIndex >= 0 ? state.openSources[parentIndex] : undefined;
      const parentPhase = parentIndex >= 0 ? state.openPhaseNames[parentIndex] : undefined;
      if (state.droppedEventCount === 0) {
        const endMicros = Math.max(startMicros, clock.nowMicros());
        retainPhaseRecord(
          state,
          source,
          frameId,
          phase,
          parentSource,
          parentPhase,
          startMicros,
          endMicros,
        );
      } else {
        recordOverflow(state, frameId);
      }
      return OK_VOID;
    },
    recordSkip(input) {
      const stateCheck = stateResult(state, 'recordSkip');
      if (!stateCheck.ok) return stateCheck;
      const frameId = state.currentFrameId;
      if (frameId === undefined || state.openDepth > 0)
        return { ok: false, error: stateError('recordSkip') };
      if (!sourceHasPhase(state, input.source, input.phase))
        return sourceError(input.source, input.phase, frameId);
      if (state.droppedEventCount > 0) recordOverflow(state, frameId);
      else retainSkipRecord(state, input.source, frameId, input.phase, input.reason);
      return OK_VOID;
    },
    endFrame() {
      const stateCheck = stateResult(state, 'endFrame');
      if (!stateCheck.ok) return stateCheck;
      if (state.currentFrameId === undefined || state.openDepth > 0)
        return { ok: false, error: stateError('endFrame') };
      state.currentFrameId = undefined;
      return OK_VOID;
    },
    finish() {
      const stateCheck = stateResult(state, 'finish');
      if (!stateCheck.ok) return { ok: false, error: stateCheck.error };
      if (state.openDepth > 0 || state.currentFrameId !== undefined) {
        return { ok: false, error: stateError('finish') };
      }
      state.finished = true;
      return { ok: true, value: buildCapture(state) };
    },
  };
  return { ok: true, value: session };
}
