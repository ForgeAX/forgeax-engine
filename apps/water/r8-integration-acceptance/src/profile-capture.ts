import type { PhysicsWorld } from '@forgeax/engine/physics';
import {
  buildProfileModel,
  createProfiler,
  type ProfileCapture,
  type ProfileCompletionCpuObservation,
  type ProfileModel,
  type ProfilerError,
  type RecorderSession,
} from '@forgeax/engine/profiler';
import type { FrameReceipt, Renderer, RenderInspection } from '@forgeax/engine/render';

const R8_PROFILE_LIMITS = Object.freeze({
  normal: Object.freeze({
    frameLimit: 900,
    eventLimit: 1_048_576,
    detail: 'passes' as const,
  }),
  nested: Object.freeze({
    frameLimit: 180,
    eventLimit: 1_048_576,
    detail: 'nested' as const,
  }),
});
const R8_PROFILE_SIDECAR_LIMIT = 8_192;
const R8_PROFILE_MAX_FRAME_LIMIT = 900;
const R8_PROFILE_MAX_EVENT_LIMIT = 1_048_576;
const R8_PROFILE_DEFAULT_FINISH_WAIT_MS = 5_000;
const R8_PROFILE_MAX_FINISH_WAIT_MS = 10_000;

type R8ProfileDetail = 'owner' | 'passes' | 'nested';
type R8ProfileCaptureRequest =
  | 'normal'
  | 'nested'
  | Readonly<{
      preset?: 'normal' | 'nested';
      frameLimit?: number;
      eventLimit?: number;
      detail?: R8ProfileDetail;
    }>;
type R8ProfileFinishResult =
  | { readonly ok: true; readonly value: R8ProfileExport }
  | { readonly ok: false; readonly error: unknown };

export type R8FrameCompletion = Pick<
  FrameReceipt,
  'frameId' | 'deviceGeneration' | 'presentation'
> & {
  readonly profileFrame?: FrameReceipt['profileFrame'];
};

export type R8ProfileReceipt = {
  readonly captureId: string;
  readonly profileFrameId: number;
  readonly receiptFrameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration?: FrameReceipt['graphGeneration'];
  readonly renderPassCpuIdentities?: FrameReceipt['renderPassCpuIdentities'];
  readonly renderPassCpuIdentitiesComplete?: FrameReceipt['renderPassCpuIdentitiesComplete'];
  resultStatus: 'pending' | 'fulfilled' | 'rejected';
  status:
    | 'submitted'
    | 'completed'
    | 'presentation-pending'
    | 'generation-mismatch'
    | 'identity-mismatch'
    | 'missing'
    | 'ledger-evicted'
    | 'failed';
};

type R8GpuSidecar = Readonly<{
  captureId: string;
  profileFrameId: number;
  receiptFrameId: number;
  deviceGeneration: number;
  timingStatus: 'complete' | 'partial' | 'unavailable' | 'failed' | 'missing';
  executedPassCount: number | null;
  measuredPassCount: number | null;
  droppedPassCount: number | null;
  timings: unknown;
}>;

export type R8ProfileRun = {
  readonly session: RecorderSession;
  readonly captureId: string;
  readonly detail: R8ProfileDetail;
  readonly receipts: R8ProfileReceipt[];
  readonly completionCpu: ProfileCompletionCpuObservation[];
  readonly expectedCompletionKeys: Set<string>;
  readonly observedCompletionKeys: Set<string>;
  readonly callbackCompletionKeys: Set<string>;
  readonly native: Record<string, unknown>[];
  readonly gpu: R8GpuSidecar[];
  readonly pendingReceipts: Map<string, R8ProfileReceipt>;
  finishPromise?: Promise<R8ProfileFinishResult>;
  releaseCompletionCpu?: (() => void) | undefined;
  releaseNative?: (() => void) | undefined;
  nativeAvailable: boolean;
  nativeFenceStartStep?: number;
  nativeFenceEndStep?: number;
  nativeFenceFailures: number;
  nativeObserverRows: number;
  nativeIndexGapCount: number;
  nativeFixedStepGapCount: number;
  nativeInvalidIdentityCount: number;
  nativeLastIndex?: number;
  nativeLastFixedStep?: number;
  nativeUnassociated: number;
  nativeDropped: number;
  gpuPending: number;
  readonly gpuTimingStatusCounts: Record<R8GpuSidecar['timingStatus'], number>;
  gpuUnmeasuredPasses: number;
  gpuDroppedPasses: number;
  gpuMissingMeasurementReceipts: number;
  cpuFinished: boolean;
  finalized: boolean;
  completionExpected: number;
  completionCallbacksActual: number;
  completionCpuActual: number;
  completionCpuUnassociated: number;
  completionCpuDuplicates: number;
  receiptExpected: number;
  receiptDropped: number;
  receiptLedgerEvicted: number;
  receiptFailures: number;
  readonly receiptResultCounts: Record<R8ProfileReceipt['resultStatus'], number>;
  readonly receiptStatusCounts: Record<R8ProfileReceipt['status'], number>;
  completionIdentityMismatch: number;
  completionDropped: number;
  gpuExpected: number;
  gpuFailed: number;
  gpuDropped: number;
};

type R8ProfileExport = Readonly<{
  version: 1;
  capture: ProfileCapture;
  model: ProfileModel;
  sidecars: Readonly<{
    receipts: readonly Readonly<R8ProfileReceipt>[];
    completionCpu: readonly ProfileCompletionCpuObservation[];
    nativePhysics: readonly Readonly<Record<string, unknown>>[];
    gpu: readonly R8GpuSidecar[];
    diagnostics: Readonly<{
      profileSourceFailure: Extract<
        ProfilerError,
        { readonly code: 'profile-source-failed' }
      > | null;
    }>;
    completeness: Readonly<Record<string, unknown>>;
  }>;
}>;

export function appendBounded<T>(items: T[], item: T): boolean {
  if (items.length >= R8_PROFILE_SIDECAR_LIMIT) return false;
  items.push(item);
  return true;
}

type R8NativeFenceReader = () => number | undefined;

type R8GpuPassIdentity = Readonly<{
  viewId?: number;
  passName: string;
  passKind: string;
  executionIndex: number;
  status: 'measured' | 'unmeasured';
}>;

type R8GpuTimingFrameFacts = Readonly<{
  frameId: number;
  deviceGeneration: number;
  graphGeneration: number;
  executedPassCount: number;
  measuredPassCount: number;
  droppedPassCount: number;
  passes: readonly R8GpuPassIdentity[];
}>;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function gpuTimingFrameFacts(value: unknown): R8GpuTimingFrameFacts | undefined {
  const observation = objectRecord(value);
  const frame = objectRecord(observation?.frame);
  if (frame === undefined) return undefined;
  const number = (name: string) =>
    typeof frame[name] === 'number' && Number.isSafeInteger(frame[name])
      ? (frame[name] as number)
      : undefined;
  const frameId = number('frameId');
  const deviceGeneration = number('deviceGeneration');
  const graphGeneration = number('graphGeneration');
  const executedPassCount = number('executedPassCount');
  const measuredPassCount = number('measuredPassCount');
  const droppedPassCount = number('droppedPassCount');
  if (
    frameId === undefined ||
    deviceGeneration === undefined ||
    graphGeneration === undefined ||
    executedPassCount === undefined ||
    measuredPassCount === undefined ||
    droppedPassCount === undefined ||
    !Array.isArray(frame.passes)
  )
    return undefined;
  const passes: R8GpuPassIdentity[] = [];
  for (const entryValue of frame.passes) {
    const entry = objectRecord(entryValue);
    const passName = entry?.passName;
    const passKind = entry?.passKind;
    const executionIndex = entry?.executionIndex;
    const viewId = entry?.viewId;
    const status = entry?.status;
    if (
      typeof passName !== 'string' ||
      typeof passKind !== 'string' ||
      typeof executionIndex !== 'number' ||
      !Number.isSafeInteger(executionIndex) ||
      (status !== 'measured' && status !== 'unmeasured') ||
      (viewId !== undefined && (typeof viewId !== 'number' || !Number.isSafeInteger(viewId)))
    )
      continue;
    passes.push({
      ...(viewId === undefined ? {} : { viewId: viewId as number }),
      passName,
      passKind,
      executionIndex,
      status,
    });
  }
  return {
    frameId,
    deviceGeneration,
    graphGeneration,
    executedPassCount,
    measuredPassCount,
    droppedPassCount,
    passes,
  };
}

function gpuPassIdentityKey(identity: R8GpuPassIdentity): string {
  return JSON.stringify([
    identity.viewId ?? null,
    identity.passName,
    identity.passKind,
    identity.executionIndex,
  ]);
}

function gpuReceiptMatches(
  receipt: R8ProfileReceipt,
  gpu: R8ProfileRun['gpu'][number],
  frame: ReturnType<typeof gpuTimingFrameFacts>,
): frame is NonNullable<ReturnType<typeof gpuTimingFrameFacts>> {
  return !(
    frame === undefined ||
    frame.frameId !== receipt.receiptFrameId ||
    frame.deviceGeneration !== receipt.deviceGeneration ||
    (receipt.graphGeneration !== undefined && frame.graphGeneration !== receipt.graphGeneration) ||
    gpu.timingStatus !== 'complete' ||
    gpu.executedPassCount !== frame.executedPassCount ||
    gpu.measuredPassCount !== frame.measuredPassCount ||
    gpu.droppedPassCount !== frame.droppedPassCount ||
    frame.measuredPassCount !== frame.executedPassCount ||
    frame.passes.length !== frame.executedPassCount ||
    frame.passes.some((pass) => pass.status !== 'measured') ||
    frame.droppedPassCount !== 0
  );
}

function joinReceiptPassIdentities(receipt: R8ProfileReceipt, gpuPassKeys: ReadonlySet<string>) {
  let incompleteCpuIdentityReceipts = 0;
  let cpuRows = 0;
  let unavailableCpuRows = 0;
  let duplicateCpuRows = 0;
  let matchedRows = 0;
  let unmatchedCpuRows = 0;
  let unmatchedGpuRows = 0;
  if (
    receipt.renderPassCpuIdentities === undefined ||
    receipt.renderPassCpuIdentitiesComplete !== true
  )
    incompleteCpuIdentityReceipts += 1;
  const cpuPassKeys = new Set<string>();
  for (const row of receipt.renderPassCpuIdentities ?? []) {
    cpuRows += 1;
    if (
      row.deviceGeneration !== receipt.deviceGeneration ||
      row.gpuIdentityStatus !== 'available' ||
      row.gpuIdentity === undefined
    ) {
      unavailableCpuRows += 1;
      continue;
    }
    const tuple: R8GpuPassIdentity = {
      ...(row.gpuIdentity.viewId === undefined ? {} : { viewId: row.gpuIdentity.viewId }),
      passName: row.gpuIdentity.passName,
      passKind: row.gpuIdentity.passKind,
      executionIndex: row.gpuIdentity.executionIndex,
      status: 'measured',
    };
    const tupleKey = gpuPassIdentityKey(tuple);
    if (cpuPassKeys.has(tupleKey)) duplicateCpuRows += 1;
    cpuPassKeys.add(tupleKey);
    if (gpuPassKeys.has(tupleKey)) matchedRows += 1;
    else unmatchedCpuRows += 1;
  }
  for (const tupleKey of gpuPassKeys) if (!cpuPassKeys.has(tupleKey)) unmatchedGpuRows += 1;
  return {
    incompleteCpuIdentityReceipts,
    cpuRows,
    unavailableCpuRows,
    duplicateCpuRows,
    matchedRows,
    unmatchedCpuRows,
    unmatchedGpuRows,
  };
}

function analyzeR8GpuIdentityJoin(run: R8ProfileRun) {
  const identityJoinApplicable = run.detail !== 'owner';
  let matchedReceipts = 0;
  let missingGpuReceipts = 0;
  let incompleteCpuIdentityReceipts = 0;
  let mismatchedGpuReceipts = 0;
  let cpuRows = 0;
  let matchedRows = 0;
  let unavailableCpuRows = 0;
  let unmatchedCpuRows = 0;
  let unmatchedGpuRows = 0;
  let duplicateCpuRows = 0;
  let duplicateGpuRows = 0;
  let expectedGpuReceipts = 0;
  const gpuByReceipt = new Map(
    run.gpu.map((sidecar) => [
      profileCompletionKey(
        sidecar.captureId,
        sidecar.profileFrameId,
        sidecar.receiptFrameId,
        sidecar.deviceGeneration,
      ),
      sidecar,
    ]),
  );
  for (const receipt of run.receipts) {
    if (receipt.status !== 'completed') continue;
    expectedGpuReceipts += 1;
    const key = profileCompletionKey(
      receipt.captureId,
      receipt.profileFrameId,
      receipt.receiptFrameId,
      receipt.deviceGeneration,
    );
    const gpu = gpuByReceipt.get(key);
    if (gpu === undefined) {
      missingGpuReceipts += 1;
      continue;
    }
    const frame = gpuTimingFrameFacts(gpu.timings);
    if (!gpuReceiptMatches(receipt, gpu, frame)) {
      mismatchedGpuReceipts += 1;
      continue;
    }
    matchedReceipts += 1;
    const gpuPassKeys = new Set(frame.passes.map(gpuPassIdentityKey));
    duplicateGpuRows += frame.passes.length - gpuPassKeys.size;
    if (!identityJoinApplicable) continue;
    const joined = joinReceiptPassIdentities(receipt, gpuPassKeys);
    incompleteCpuIdentityReceipts += joined.incompleteCpuIdentityReceipts;
    cpuRows += joined.cpuRows;
    unavailableCpuRows += joined.unavailableCpuRows;
    duplicateCpuRows += joined.duplicateCpuRows;
    matchedRows += joined.matchedRows;
    unmatchedCpuRows += joined.unmatchedCpuRows;
    unmatchedGpuRows += joined.unmatchedGpuRows;
  }
  const gpuFrameIntegrityComplete =
    run.receiptExpected === run.receipts.length &&
    run.gpuExpected === run.gpu.length &&
    run.gpuExpected === expectedGpuReceipts &&
    matchedReceipts === expectedGpuReceipts &&
    missingGpuReceipts === 0 &&
    mismatchedGpuReceipts === 0 &&
    duplicateGpuRows === 0;
  const passIdentityJoinComplete = () => {
    const identityJoinComplete =
      gpuFrameIntegrityComplete &&
      incompleteCpuIdentityReceipts === 0 &&
      unavailableCpuRows === 0 &&
      unmatchedCpuRows === 0 &&
      unmatchedGpuRows === 0 &&
      duplicateCpuRows === 0 &&
      duplicateGpuRows === 0;
    return identityJoinComplete;
  };
  const identityJoinComplete = passIdentityJoinComplete();
  return Object.freeze({
    status: !identityJoinApplicable
      ? 'not-applicable'
      : identityJoinComplete
        ? 'complete'
        : 'partial',
    identityJoinApplicable,
    gpuFrameIntegrityStatus: gpuFrameIntegrityComplete ? 'complete' : 'partial',
    ...(identityJoinApplicable
      ? {}
      : { reason: 'owner detail does not record per-pass CPU identities' }),
    expectedReceipts: run.gpuExpected,
    eligibleReceiptRows: expectedGpuReceipts,
    matchedReceipts,
    missingGpuReceipts,
    incompleteCpuIdentityReceipts,
    mismatchedGpuReceipts,
    cpuRows,
    matchedRows,
    unavailableCpuRows,
    unmatchedCpuRows,
    unmatchedGpuRows,
    duplicateCpuRows,
    duplicateGpuRows,
  });
}

function captureNativeStepFence(
  run: R8ProfileRun,
  readCompletedStep: R8NativeFenceReader,
): number | undefined {
  try {
    const step = readCompletedStep();
    if (typeof step === 'number' && Number.isSafeInteger(step) && step >= 0) return step;
  } catch {
    // Fence reads are diagnostic; retain their failure in the sidecar.
  }
  run.nativeFenceFailures += 1;
  return undefined;
}

function closeR8CpuCapture(run: R8ProfileRun, readCompletedStep: R8NativeFenceReader): void {
  if (run.cpuFinished) return;
  // Read the closing fence before releasing the native timing lease. The
  // profiler sink calls this at the exact explicit or automatic finish point.
  const endStep = captureNativeStepFence(run, readCompletedStep);
  if (endStep !== undefined) run.nativeFenceEndStep = endStep;
  run.cpuFinished = true;
  run.releaseNative?.();
  run.releaseNative = undefined;
}

export function setR8ReceiptStatus(
  run: R8ProfileRun,
  receipt: R8ProfileReceipt,
  status: R8ProfileReceipt['status'],
): void {
  run.receiptStatusCounts[receipt.status] = Math.max(
    0,
    run.receiptStatusCounts[receipt.status] - 1,
  );
  receipt.status = status;
  run.receiptStatusCounts[status] += 1;
}

export function profileCompletionKey(
  captureId: string,
  profileFrameId: number,
  receiptFrameId: number,
  deviceGeneration: number,
): string {
  return `${captureId}/${profileFrameId}/${deviceGeneration}/${receiptFrameId}`;
}

async function waitForR8ProfileDrain(run: R8ProfileRun, waitMs: number): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  while (run.pendingReceipts.size > 0 || run.gpuPending > 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
  // Let the profiler's completion listener run after its wrapped App callback.
  await Promise.resolve();
  return run.pendingReceipts.size === 0 && run.gpuPending === 0;
}

function resolveProfileCaptureRequest(request: R8ProfileCaptureRequest) {
  const requestOptions = typeof request === 'object' && request !== null ? request : undefined;
  const preset = typeof request === 'string' ? request : (requestOptions?.preset ?? 'normal');
  if (preset !== 'normal' && preset !== 'nested')
    return { ok: false as const, error: { code: 'profile-capture-preset-invalid' } };
  const defaults = R8_PROFILE_LIMITS[preset];
  const limits = Object.freeze({
    frameLimit: requestOptions?.frameLimit ?? defaults.frameLimit,
    eventLimit: requestOptions?.eventLimit ?? defaults.eventLimit,
    detail: requestOptions?.detail ?? defaults.detail,
  });
  if (
    !Number.isSafeInteger(limits.frameLimit) ||
    limits.frameLimit < 1 ||
    limits.frameLimit > R8_PROFILE_MAX_FRAME_LIMIT ||
    !Number.isSafeInteger(limits.eventLimit) ||
    limits.eventLimit < 1 ||
    limits.eventLimit > R8_PROFILE_MAX_EVENT_LIMIT ||
    (limits.detail !== 'owner' && limits.detail !== 'passes' && limits.detail !== 'nested')
  ) {
    return {
      ok: false as const,
      error: {
        code: 'profile-capture-limits-invalid',
        expected: `frameLimit 1..${R8_PROFILE_MAX_FRAME_LIMIT} and eventLimit 1..${R8_PROFILE_MAX_EVENT_LIMIT}`,
        hint: 'Choose the normal or nested preset, or pass bounded RecorderLimits overrides.',
        detail: { limits },
      },
    };
  }
  return { ok: true as const, value: { preset, limits } };
}

function profileCompletionFacts(
  run: R8ProfileRun,
  drained: boolean,
  missingCompletionNotifications: number,
) {
  const missingCompletionCallbacks = Math.max(
    missingCompletionNotifications,
    run.completionExpected - run.completionCallbacksActual,
  );
  const missingCompletionCpu = Math.max(0, run.completionExpected - run.completionCpuActual);
  const receiptsComplete = () => {
    const receiptStatusIncomplete =
      run.receiptStatusCounts.submitted > 0 ||
      run.receiptStatusCounts['presentation-pending'] > 0 ||
      run.receiptStatusCounts['generation-mismatch'] > 0 ||
      run.receiptStatusCounts['identity-mismatch'] > 0 ||
      run.receiptStatusCounts.missing > 0 ||
      run.receiptStatusCounts['ledger-evicted'] > 0 ||
      run.receiptStatusCounts.failed > 0;
    return !receiptStatusIncomplete;
  };
  const completionCpuStatus =
    drained &&
    receiptsComplete() &&
    run.completionCallbacksActual === run.completionExpected &&
    run.completionCpuActual === run.completionExpected &&
    missingCompletionCallbacks === 0 &&
    missingCompletionCpu === 0 &&
    run.pendingReceipts.size === 0 &&
    run.completionIdentityMismatch === 0 &&
    run.completionCpuUnassociated === 0 &&
    run.completionCpuDuplicates === 0 &&
    run.receiptDropped === 0 &&
    run.receiptLedgerEvicted === 0 &&
    run.receiptFailures === 0 &&
    run.completionDropped === 0
      ? 'complete'
      : 'partial';
  return { missingCompletionCallbacks, missingCompletionCpu, completionCpuStatus };
}

function profileNativeFacts(run: R8ProfileRun) {
  const expectedNativeSteps =
    run.nativeFenceStartStep === undefined || run.nativeFenceEndStep === undefined
      ? undefined
      : run.nativeFenceEndStep - run.nativeFenceStartStep;
  const nativePhysicsStatus = !run.nativeAvailable
    ? 'unavailable'
    : expectedNativeSteps !== undefined &&
        expectedNativeSteps >= 0 &&
        run.nativeFenceFailures === 0 &&
        run.nativeObserverRows === expectedNativeSteps &&
        run.native.length === run.nativeObserverRows &&
        run.nativeUnassociated === 0 &&
        run.nativeIndexGapCount === 0 &&
        run.nativeFixedStepGapCount === 0 &&
        run.nativeInvalidIdentityCount === 0 &&
        run.nativeDropped === 0
      ? 'complete'
      : 'partial';
  return { expectedNativeSteps, nativePhysicsStatus };
}

function profileGpuFacts(run: R8ProfileRun, drained: boolean) {
  const gpuIdentityJoin = analyzeR8GpuIdentityJoin(run);
  const gpuStatus =
    drained &&
    run.gpuPending === 0 &&
    run.gpuFailed === 0 &&
    run.gpuDropped === 0 &&
    run.gpu.length === run.gpuExpected &&
    run.gpuTimingStatusCounts.complete === run.gpuExpected &&
    run.gpuTimingStatusCounts.partial === 0 &&
    run.gpuTimingStatusCounts.unavailable === 0 &&
    run.gpuTimingStatusCounts.failed === 0 &&
    run.gpuTimingStatusCounts.missing === 0 &&
    run.gpuUnmeasuredPasses === 0 &&
    run.gpuDroppedPasses === 0 &&
    run.gpuMissingMeasurementReceipts === 0 &&
    gpuIdentityJoin.gpuFrameIntegrityStatus === 'complete' &&
    (!gpuIdentityJoin.identityJoinApplicable || gpuIdentityJoin.status === 'complete')
      ? 'complete'
      : 'partial';
  return { gpuIdentityJoin, gpuStatus };
}

function profileAllComplete(
  run: R8ProfileRun,
  capture: ProfileCapture,
  drained: boolean,
  completionCpuStatus: string,
  nativePhysicsStatus: string,
  gpuStatus: string,
) {
  const allComplete =
    drained &&
    run.receiptExpected > 0 &&
    capture.completeness.status === 'complete' &&
    run.receiptExpected === run.receipts.length &&
    run.receiptDropped === 0 &&
    run.receiptLedgerEvicted === 0 &&
    completionCpuStatus === 'complete' &&
    nativePhysicsStatus === 'complete' &&
    gpuStatus === 'complete';
  return allComplete;
}

/** Owns one bounded diagnostic capture; scene changes and renderer admission stay with the demo. */
export function createR8ProfileCapture(
  readPhysics: () => PhysicsWorld,
  record: (kind: string, detail?: unknown) => void,
  serialize: (key: string, value: unknown) => unknown,
) {
  let profileRun: R8ProfileRun | undefined;
  let latestProfileExport: R8ProfileExport | undefined;
  const readNativeCompletedStep = () => readPhysics().getSolverClock?.().completedStep;
  const profiler = createProfiler({
    sink: {
      write(capture) {
        const run = profileRun;
        if (run !== undefined && capture.captureId === run.captureId)
          closeR8CpuCapture(run, readNativeCompletedStep);
      },
    },
  });
  const startProfileCapture = (request: R8ProfileCaptureRequest = 'normal') => {
    if (profileRun !== undefined)
      return { ok: false as const, error: { code: 'profile-capture-already-active' } };
    const resolved = resolveProfileCaptureRequest(request);
    if (!resolved.ok) return resolved;
    const { preset, limits } = resolved.value;
    // Profiler.startCapture applies the shared RecorderLimits validation before admission.
    const started = profiler.startCapture(limits);
    if (!started.ok) return started;
    const run: R8ProfileRun = {
      session: started.value,
      captureId: started.value.captureId,
      detail: limits.detail,
      receipts: [],
      completionCpu: [],
      expectedCompletionKeys: new Set(),
      observedCompletionKeys: new Set(),
      callbackCompletionKeys: new Set(),
      native: [],
      gpu: [],
      pendingReceipts: new Map(),
      nativeAvailable: false,
      nativeFenceFailures: 0,
      nativeObserverRows: 0,
      nativeIndexGapCount: 0,
      nativeFixedStepGapCount: 0,
      nativeInvalidIdentityCount: 0,
      nativeUnassociated: 0,
      nativeDropped: 0,
      cpuFinished: false,
      finalized: false,
      completionExpected: 0,
      completionCallbacksActual: 0,
      completionCpuActual: 0,
      completionCpuUnassociated: 0,
      completionCpuDuplicates: 0,
      receiptExpected: 0,
      receiptDropped: 0,
      receiptLedgerEvicted: 0,
      receiptFailures: 0,
      receiptResultCounts: { pending: 0, fulfilled: 0, rejected: 0 },
      receiptStatusCounts: {
        submitted: 0,
        completed: 0,
        'presentation-pending': 0,
        'generation-mismatch': 0,
        'identity-mismatch': 0,
        missing: 0,
        'ledger-evicted': 0,
        failed: 0,
      },
      completionIdentityMismatch: 0,
      completionDropped: 0,
      gpuExpected: 0,
      gpuPending: 0,
      gpuFailed: 0,
      gpuDropped: 0,
      gpuTimingStatusCounts: {
        complete: 0,
        partial: 0,
        unavailable: 0,
        failed: 0,
        missing: 0,
      },
      gpuUnmeasuredPasses: 0,
      gpuDroppedPasses: 0,
      gpuMissingMeasurementReceipts: 0,
    };
    const startStep = captureNativeStepFence(run, readNativeCompletedStep);
    if (startStep !== undefined) run.nativeFenceStartStep = startStep;
    profileRun = run;
    latestProfileExport = undefined;
    run.releaseCompletionCpu = profiler.observeCompletionCpu((observation) => {
      if (run.finalized || observation.captureId !== run.captureId) return;
      const key = profileCompletionKey(
        observation.captureId,
        observation.profileFrameId,
        observation.receiptFrameId,
        observation.deviceGeneration,
      );
      if (!run.expectedCompletionKeys.has(key)) {
        run.completionCpuUnassociated += 1;
        return;
      }
      if (run.observedCompletionKeys.has(key)) {
        run.completionCpuDuplicates += 1;
        return;
      }
      run.observedCompletionKeys.add(key);
      run.completionCpuActual += 1;
      if (!appendBounded(run.completionCpu, observation)) run.completionDropped += 1;
    });
    const physicsWorld = readPhysics();
    if (typeof physicsWorld.observeNativeStepTiming === 'function') {
      run.nativeAvailable = true;
      run.releaseNative = physicsWorld.observeNativeStepTiming((timing) => {
        if (run.finalized || run.cpuFinished || profiler.activeCaptureId() !== run.captureId) {
          closeR8CpuCapture(run, readNativeCompletedStep);
          return;
        }
        // Sample within the App frame that admitted this native step.
        const frameToken = run.session.currentFrameToken();
        const associated = frameToken?.captureId === run.captureId ? frameToken : undefined;
        if (associated === undefined) run.nativeUnassociated += 1;
        run.nativeObserverRows += 1;
        if (run.nativeLastIndex !== undefined) {
          if (timing.nativeStepIndex <= run.nativeLastIndex) run.nativeInvalidIdentityCount += 1;
          else if (timing.nativeStepIndex > run.nativeLastIndex + 1)
            run.nativeIndexGapCount += timing.nativeStepIndex - run.nativeLastIndex - 1;
        }
        if (run.nativeLastFixedStep !== undefined) {
          if (timing.fixedStep <= run.nativeLastFixedStep) run.nativeInvalidIdentityCount += 1;
          else if (timing.fixedStep > run.nativeLastFixedStep + 1)
            run.nativeFixedStepGapCount += timing.fixedStep - run.nativeLastFixedStep - 1;
        }
        run.nativeLastIndex = timing.nativeStepIndex;
        run.nativeLastFixedStep = timing.fixedStep;
        const row = Object.freeze({
          captureId: run.captureId,
          profileFrameId: associated?.frameId ?? null,
          nativeStepIndex: timing.nativeStepIndex,
          fixedStep: timing.fixedStep,
          deltaSeconds: timing.deltaSeconds,
          timingMs: timing.timingMs,
        });
        if (!appendBounded(run.native, row)) run.nativeDropped += 1;
      });
    }
    record('profile-capture-started', { captureId: run.captureId, preset, limits });
    return {
      ok: true as const,
      value: { captureId: run.captureId, preset, limits },
    };
  };

  const finishProfileCapture = async (
    options: { readonly waitMs?: number } = {},
  ): Promise<R8ProfileFinishResult> => {
    const run = profileRun;
    if (run === undefined) {
      return latestProfileExport === undefined
        ? { ok: false as const, error: { code: 'profile-capture-not-started' } }
        : { ok: true as const, value: latestProfileExport };
    }
    if (run.finishPromise !== undefined) return run.finishPromise;
    const waitMs = options?.waitMs ?? R8_PROFILE_DEFAULT_FINISH_WAIT_MS;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > R8_PROFILE_MAX_FINISH_WAIT_MS)
      return {
        ok: false as const,
        error: {
          code: 'profile-capture-finish-wait-invalid',
          expected: `waitMs 0..${R8_PROFILE_MAX_FINISH_WAIT_MS}`,
          hint: 'Use a bounded receipt and GPU drain interval.',
          detail: { waitMs },
        },
      };
    const finished = run.session.finish();
    if (!finished.ok) return { ok: false as const, error: finished.error };
    closeR8CpuCapture(run, readNativeCompletedStep);
    const finishPromise = (async (): Promise<R8ProfileFinishResult> => {
      const drained = await waitForR8ProfileDrain(run, waitMs);
      let missingCompletionNotifications = 0;
      for (const [key, receipt] of run.pendingReceipts) {
        if (receipt.resultStatus !== 'fulfilled') continue;
        missingCompletionNotifications += 1;
        if (receipt.status === 'submitted') setR8ReceiptStatus(run, receipt, 'missing');
        run.pendingReceipts.delete(key);
      }
      const pendingReceiptResults = [...run.pendingReceipts.values()].filter(
        (receipt) => receipt.resultStatus === 'pending',
      ).length;
      const modeled = buildProfileModel(finished.value, { orderEvidence: 'recorder-closure' });
      run.releaseCompletionCpu?.();
      run.releaseCompletionCpu = undefined;
      run.releaseNative?.();
      run.releaseNative = undefined;
      if (!modeled.ok) {
        run.finalized = true;
        profileRun = undefined;
        return { ok: false as const, error: modeled.error };
      }
      const { missingCompletionCallbacks, missingCompletionCpu, completionCpuStatus } =
        profileCompletionFacts(run, drained, missingCompletionNotifications);
      const { expectedNativeSteps, nativePhysicsStatus } = profileNativeFacts(run);
      const { gpuIdentityJoin, gpuStatus } = profileGpuFacts(run, drained);
      const allComplete = profileAllComplete(
        run,
        finished.value,
        drained,
        completionCpuStatus,
        nativePhysicsStatus,
        gpuStatus,
      );
      const sourceFailure = run.session.firstSourceFailure();
      const exportValue: R8ProfileExport = Object.freeze({
        version: 1,
        capture: finished.value,
        model: modeled.value,
        sidecars: Object.freeze({
          receipts: Object.freeze(run.receipts.map((row) => Object.freeze({ ...row }))),
          completionCpu: Object.freeze([...run.completionCpu]),
          nativePhysics: Object.freeze(run.native.map((row) => Object.freeze({ ...row }))),
          gpu: Object.freeze([...run.gpu]),
          diagnostics: Object.freeze({
            profileSourceFailure: sourceFailure ?? null,
          }),
          completeness: Object.freeze({
            status: allComplete ? 'complete' : 'partial',
            profile: finished.value.completeness,
            receiptCompletionCpu: {
              status: completionCpuStatus,
              expected: run.completionExpected,
              callbacksActual: run.completionCallbacksActual,
              actual: run.completionCpuActual,
              retained: run.completionCpu.length,
              missingCompletionCallbacks,
              missingCompletionCpu,
              pendingReceipts: pendingReceiptResults,
              identityMismatches: run.completionIdentityMismatch,
              unassociatedObservations: run.completionCpuUnassociated,
              duplicateObservations: run.completionCpuDuplicates,
              dropped: run.completionDropped,
              receiptExpected: run.receiptExpected,
              receiptRetained: run.receipts.length,
              receiptStatusCounts: Object.freeze({ ...run.receiptStatusCounts }),
              receiptDropped: run.receiptDropped,
              ledgerEvicted: run.receiptLedgerEvicted,
              failedReceipts: run.receiptFailures,
              receiptResultCounts: Object.freeze({ ...run.receiptResultCounts }),
              drainTimedOut: !drained,
            },
            nativePhysics: {
              status: nativePhysicsStatus,
              expectedSteps: expectedNativeSteps ?? null,
              expectedSource: 'PhysicsWorld.getSolverClock().completedStep delta',
              execution:
                'successful synchronous native steps only; async/worker steps are excluded',
              retainedSteps: run.native.length,
              observedSteps: run.nativeObserverRows,
              missingStepRows:
                expectedNativeSteps === undefined
                  ? null
                  : Math.max(0, expectedNativeSteps - run.nativeObserverRows),
              unexpectedStepRows:
                expectedNativeSteps === undefined
                  ? null
                  : Math.max(0, run.nativeObserverRows - expectedNativeSteps),
              fenceStartCompletedStep: run.nativeFenceStartStep ?? null,
              fenceEndCompletedStep: run.nativeFenceEndStep ?? null,
              fenceReadFailures: run.nativeFenceFailures,
              unassociatedSteps: run.nativeUnassociated,
              nativeIndexGaps: run.nativeIndexGapCount,
              fixedStepGaps: run.nativeFixedStepGapCount,
              invalidStepIdentities: run.nativeInvalidIdentityCount,
              dropped: run.nativeDropped,
            },
            gpu: {
              status: gpuStatus,
              expected: run.gpuExpected,
              retained: run.gpu.length,
              pending: run.gpuPending,
              failed: run.gpuFailed,
              dropped: run.gpuDropped,
              timingStatuses: Object.freeze({ ...run.gpuTimingStatusCounts }),
              unmeasuredPasses: run.gpuUnmeasuredPasses,
              droppedPasses: run.gpuDroppedPasses,
              missingMeasurementReceipts: run.gpuMissingMeasurementReceipts,
              cpuGpuIdentityJoin: gpuIdentityJoin,
              drainTimedOut: !drained,
            },
          }),
        }),
      });
      latestProfileExport = exportValue;
      run.finalized = true;
      profileRun = undefined;
      record('profile-capture-finished', {
        captureId: run.captureId,
        completeness: exportValue.sidecars.completeness,
      });
      return { ok: true as const, value: exportValue };
    })();
    run.finishPromise = finishPromise;
    return finishPromise;
  };

  const exportProfileCapture = () => latestProfileExport;
  const downloadProfileCapture = () => {
    const exported = exportProfileCapture();
    if (exported === undefined) throw new Error('Finish a profile capture before exporting it');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exported, serialize, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `water-r8-profile-${exported.capture.captureId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    return exported;
  };

  const retainSubmittedReceipt = (
    receipt: FrameReceipt,
    key: string,
    run: R8ProfileRun | undefined,
  ) => {
    let profileReceipt: R8ProfileReceipt | undefined;
    if (run !== undefined && !run.finalized && receipt.profileFrame?.captureId === run.captureId) {
      const token = receipt.profileFrame;
      profileReceipt = {
        captureId: token.captureId,
        profileFrameId: token.frameId,
        receiptFrameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: receipt.graphGeneration }),
        ...(receipt.renderPassCpuIdentities === undefined
          ? {}
          : { renderPassCpuIdentities: receipt.renderPassCpuIdentities }),
        ...(receipt.renderPassCpuIdentitiesComplete === undefined
          ? {}
          : { renderPassCpuIdentitiesComplete: receipt.renderPassCpuIdentitiesComplete }),
        resultStatus: 'pending',
        status: 'submitted',
      };
      run.receiptExpected += 1;
      run.receiptResultCounts.pending += 1;
      run.receiptStatusCounts.submitted += 1;
      run.expectedCompletionKeys.add(
        profileCompletionKey(
          profileReceipt.captureId,
          profileReceipt.profileFrameId,
          profileReceipt.receiptFrameId,
          profileReceipt.deviceGeneration,
        ),
      );
      run.pendingReceipts.set(key, profileReceipt);
      if (!appendBounded(run.receipts, profileReceipt)) run.receiptDropped += 1;
    }
    return profileReceipt;
  };
  const completeReceipt = (
    run: R8ProfileRun | undefined,
    profileReceipt: R8ProfileReceipt | undefined,
    key: string,
    completion: R8FrameCompletion,
    sameToken: boolean,
    sameGeneration: boolean,
  ) => {
    if (run !== undefined && profileReceipt !== undefined && !run.finalized) {
      run.pendingReceipts.delete(key);
      const completionKey = profileCompletionKey(
        profileReceipt.captureId,
        profileReceipt.profileFrameId,
        completion.frameId,
        completion.deviceGeneration,
      );
      if (run.expectedCompletionKeys.has(completionKey)) {
        if (run.callbackCompletionKeys.has(completionKey)) run.completionIdentityMismatch += 1;
        else {
          run.callbackCompletionKeys.add(completionKey);
          run.completionCallbacksActual += 1;
        }
      } else run.completionIdentityMismatch += 1;
      if (!sameToken) {
        run.completionIdentityMismatch += 1;
        setR8ReceiptStatus(run, profileReceipt, 'identity-mismatch');
      } else if (!sameGeneration) setR8ReceiptStatus(run, profileReceipt, 'generation-mismatch');
      else if (completion.presentation !== 'ready')
        setR8ReceiptStatus(run, profileReceipt, 'presentation-pending');
      else setR8ReceiptStatus(run, profileReceipt, 'completed');
    }
  };
  const evictReceipt = (run: R8ProfileRun | undefined, receipt: R8ProfileReceipt | undefined) => {
    if (run !== undefined && receipt !== undefined) {
      setR8ReceiptStatus(run, receipt, 'ledger-evicted');
      run.receiptLedgerEvicted += 1;
    }
  };
  const fulfillReceipt = (
    run: R8ProfileRun | undefined,
    profileReceipt: R8ProfileReceipt | undefined,
  ) => {
    if (
      profileReceipt !== undefined &&
      run !== undefined &&
      !run.finalized &&
      profileReceipt.resultStatus === 'pending'
    ) {
      profileReceipt.resultStatus = 'fulfilled';
      run.receiptResultCounts.pending -= 1;
      run.receiptResultCounts.fulfilled += 1;
      run.completionExpected += 1;
    }
  };
  const rejectReceipt = (
    run: R8ProfileRun | undefined,
    profileReceipt: R8ProfileReceipt | undefined,
    key: string,
  ) => {
    if (profileReceipt !== undefined && run !== undefined && !run.finalized) {
      if (profileReceipt.resultStatus === 'pending') {
        profileReceipt.resultStatus = 'rejected';
        run.receiptResultCounts.pending -= 1;
        run.receiptResultCounts.rejected += 1;
      }
      setR8ReceiptStatus(run, profileReceipt, 'failed');
      run.receiptFailures += 1;
      run.pendingReceipts.delete(key);
    }
  };
  const acceptGpuObservation = (
    receipt: FrameReceipt,
    run: R8ProfileRun | undefined,
    result: Awaited<ReturnType<Renderer['observe']>>,
  ) => {
    const token = receipt.profileFrame;
    const profileMatch = run !== undefined && token?.captureId === run.captureId;
    if (profileMatch && run !== undefined) {
      run.gpuPending = Math.max(0, run.gpuPending - 1);
      if (!result.ok) {
        run.gpuFailed += 1;
        run.gpuTimingStatusCounts.failed += 1;
      } else if (!run.finalized && token !== undefined) {
        const timings = result.value.timings;
        const timingStatus = timings?.status ?? 'missing';
        const timingFrame = timings && 'frame' in timings ? timings.frame : undefined;
        run.gpuTimingStatusCounts[timingStatus] += 1;
        if (timingFrame === undefined) run.gpuMissingMeasurementReceipts += 1;
        else {
          run.gpuUnmeasuredPasses += Math.max(
            0,
            timingFrame.executedPassCount -
              timingFrame.measuredPassCount -
              timingFrame.droppedPassCount,
          );
          run.gpuDroppedPasses += timingFrame.droppedPassCount;
        }
        const sidecar = Object.freeze({
          captureId: token.captureId,
          profileFrameId: token.frameId,
          receiptFrameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          timingStatus,
          executedPassCount: timingFrame?.executedPassCount ?? null,
          measuredPassCount: timingFrame?.measuredPassCount ?? null,
          droppedPassCount: timingFrame?.droppedPassCount ?? null,
          timings: timings ?? null,
        });
        if (!appendBounded(run.gpu, sidecar)) run.gpuDropped += 1;
      }
    }
  };
  const observeGpuTiming = (
    renderer: Renderer,
    receipt: FrameReceipt,
    run: R8ProfileRun | undefined,
    diagnosticsEnabled: () => boolean,
    recordTiming: (value: unknown) => void,
    report: (cause: unknown) => void,
  ) => {
    const token = receipt.profileFrame;
    const profileMatch = run !== undefined && token?.captureId === run.captureId;
    if (!diagnosticsEnabled() && !profileMatch) return;
    if (profileMatch && run !== undefined) {
      run.gpuExpected += 1;
      run.gpuPending += 1;
    }
    let pending: Promise<void>;
    try {
      pending = renderer
        .observe(receipt, { include: ['timings'] })
        .then((result) => {
          if (diagnosticsEnabled()) {
            recordTiming(result);
          }
          acceptGpuObservation(receipt, run, result);
        })
        .catch((cause) => {
          if (profileMatch && run !== undefined) {
            run.gpuPending = Math.max(0, run.gpuPending - 1);
            run.gpuFailed += 1;
            run.gpuTimingStatusCounts.failed += 1;
          }
          report(cause);
        });
    } catch (cause) {
      if (profileMatch && run !== undefined) {
        run.gpuPending = Math.max(0, run.gpuPending - 1);
        run.gpuFailed += 1;
        run.gpuTimingStatusCounts.failed += 1;
      }
      report(cause);
      return;
    }
    void pending;
  };
  return {
    profiler,
    observeGpuTiming,
    retainSubmittedReceipt,
    completeReceipt,
    evictReceipt,
    fulfillReceipt,
    rejectReceipt,
    acceptGpuObservation,
    get run() {
      return profileRun;
    },
    startProfileCapture,
    finishProfileCapture,
    exportProfileCapture,
    downloadProfileCapture,
  };
}

export type R8SubmittedFrameSample = {
  frameId: number;
  deviceGeneration: number;
  graphGeneration?: number;
  presentation: FrameReceipt['presentation'];
  waterGraph: RenderInspection['waterGraph'];
  allocation: RenderInspection['renderGraphGenerationAllocation'];
  featureGraph: RenderInspection['featureGraph'];
  completion: 'pending' | 'fulfilled' | 'rejected';
};

export const receiptKey = (frameId: number, deviceGeneration: number) =>
  `${deviceGeneration}/${frameId}`;
export const exactProfileToken = (
  left: FrameReceipt['profileFrame'],
  right: FrameReceipt['profileFrame'],
) =>
  left !== undefined &&
  right !== undefined &&
  left.captureId === right.captureId &&
  left.frameId === right.frameId;

export function submittedFrameSample(
  receipt: FrameReceipt,
  inspection: RenderInspection | undefined,
): R8SubmittedFrameSample {
  return {
    frameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
    ...(receipt.graphGeneration === undefined ? {} : { graphGeneration: receipt.graphGeneration }),
    presentation: receipt.presentation,
    waterGraph: inspection?.waterGraph,
    allocation: inspection?.renderGraphGenerationAllocation,
    featureGraph: inspection?.featureGraph,
    completion: 'pending' as 'pending' | 'fulfilled' | 'rejected',
  };
}
