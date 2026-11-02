export type ClusterWorkTransport = 'storage-buffer' | 'cpu-texture';
export type ClusterWorkScope = 'light-data-buffer' | 'cluster-texture-host-regions';

/** `pending` is a submitted preparation barrier, not an accepted scene graph. */
export type ClusterWorkFrameStatus = 'recording' | 'submitted' | 'pending' | 'unsubmitted';
export type ClusterWorkReceiptCompletion = 'pending' | 'completed' | 'failed';

export type ClusterWorkSample = {
  readonly frameNumber: number;
  readonly viewEntityKey: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly clusterTransportGeneration: number;
  readonly clusterUsedRows?: number;
  readonly clusterRowBytes?: number;
  readonly transport: ClusterWorkTransport;
  readonly scope: ClusterWorkScope;
  readonly packedLightSlots: number;
  readonly acceptedWriteBytes: number;
  readonly writeSucceeded: boolean;
  readonly errorCode?: string;
};

export type ClusterWorkObservation =
  | {
      readonly status: 'unavailable';
      readonly reason: 'awaiting-write' | 'device-generation-changed';
    }
  | ({ readonly status: 'captured'; readonly invocations: number } & ClusterWorkSample);

export interface ClusterWorkFrameIdentity {
  readonly graphGeneration: number;
  readonly recordFrameNumber: number;
  readonly textureIdentity: number;
}

export interface ClusterWorkGraphTargetCopyTrace {
  readonly targetName: string;
  /** RenderSystem-local frame number for the recording that owns this trace. */
  readonly recordFrameNumber: number;
  readonly expectedIdentity?: ClusterWorkFrameIdentity;
  readonly actualIdentity?: ClusterWorkFrameIdentity;
  readonly encoded: boolean;
  readonly reason?: string;
}

export interface ClusterWorkFrameReceiptTrace {
  /** Public Renderer submission counter; independent of recordFrameNumber. */
  readonly publicReceiptFrameId: number;
  readonly deviceGeneration: number;
  readonly presentation: 'ready' | 'pending';
  readonly completion: ClusterWorkReceiptCompletion;
}

export interface ClusterWorkFrameTrace {
  readonly recordFrameNumber: number;
  readonly observationFrameId?: number;
  readonly recordStatus: ClusterWorkFrameStatus;
  readonly viewEntityKey?: number;
  readonly deviceGeneration?: number;
  readonly graphGeneration?: number;
  readonly clusterTransportGeneration?: number;
  readonly clusterWork?: ClusterWorkObservation;
  readonly graphTargetCopy?: ClusterWorkGraphTargetCopyTrace;
  readonly receipt?: ClusterWorkFrameReceiptTrace;
}

interface MutableClusterWorkFrameTrace {
  recordFrameNumber: number;
  observationFrameId?: number;
  recordStatus: ClusterWorkFrameStatus;
  viewEntityKey?: number;
  deviceGeneration?: number;
  graphGeneration?: number;
  clusterTransportGeneration?: number;
  clusterWork?: ClusterWorkObservation;
  graphTargetCopy?: ClusterWorkGraphTargetCopyTrace;
  receipt?: ClusterWorkFrameReceiptTrace;
}

export interface ClusterWorkConformanceState {
  enabled: boolean;
  observation?: ClusterWorkObservation | undefined;
  trace?: MutableClusterWorkFrameTrace | undefined;
}

export function setClusterWorkConformanceEnabled(
  state: ClusterWorkConformanceState,
  enabled: boolean,
): void {
  state.enabled = enabled;
  state.observation = undefined;
  state.trace = undefined;
}

export function beginClusterWorkConformanceFrame(
  state: ClusterWorkConformanceState | undefined,
  recordFrameNumber?: number,
  observationFrameId?: number,
): void {
  if (state === undefined || !state.enabled) return;
  state.observation = undefined;
  state.trace =
    recordFrameNumber === undefined
      ? undefined
      : {
          recordFrameNumber,
          recordStatus: 'recording',
          ...(observationFrameId === undefined ? {} : { observationFrameId }),
        };
}

export function captureClusterWorkSample(
  state: ClusterWorkConformanceState,
  sample: ClusterWorkSample,
): void {
  if (!state.enabled) return;
  // Success describes the whole owner invocation. A failed multi-range write
  // can still have accepted earlier ranges, so keep its measured byte count.
  const previous = state.observation;
  const sameFrameScope =
    previous?.status === 'captured' &&
    previous.frameNumber === sample.frameNumber &&
    previous.viewEntityKey === sample.viewEntityKey &&
    previous.deviceGeneration === sample.deviceGeneration &&
    previous.graphGeneration === sample.graphGeneration &&
    previous.clusterTransportGeneration === sample.clusterTransportGeneration &&
    previous.transport === sample.transport &&
    previous.scope === sample.scope;
  state.observation = Object.freeze(
    sameFrameScope
      ? {
          status: 'captured' as const,
          ...sample,
          invocations: previous.invocations + 1,
          packedLightSlots: previous.packedLightSlots + sample.packedLightSlots,
          acceptedWriteBytes: previous.acceptedWriteBytes + sample.acceptedWriteBytes,
          writeSucceeded: previous.writeSucceeded && sample.writeSucceeded,
          ...((previous.errorCode ?? sample.errorCode) === undefined
            ? {}
            : { errorCode: previous.errorCode ?? sample.errorCode }),
        }
      : { status: 'captured' as const, ...sample, invocations: 1 },
  );
  const trace = state.trace;
  if (trace !== undefined && trace.recordFrameNumber === sample.frameNumber) {
    trace.viewEntityKey = sample.viewEntityKey;
    trace.deviceGeneration = sample.deviceGeneration;
    trace.graphGeneration = sample.graphGeneration;
    trace.clusterTransportGeneration = sample.clusterTransportGeneration;
    trace.clusterWork = Object.freeze({ ...state.observation });
  }
}

export function settleClusterWorkConformanceFrame(
  state: ClusterWorkConformanceState | undefined,
  recordFrameNumber: number,
  status: Exclude<ClusterWorkFrameStatus, 'recording'>,
): void {
  if (state === undefined || !state.enabled) return;
  const trace = state.trace;
  if (trace === undefined || trace.recordFrameNumber !== recordFrameNumber) return;
  trace.recordStatus = status;
}

export function recordClusterWorkGraphTargetCopyForConformance(
  state: ClusterWorkConformanceState | undefined,
  input: {
    readonly recordFrameNumber: number;
    readonly targetName: string;
    readonly expectedIdentity?: ClusterWorkFrameIdentity;
    readonly actualIdentity?: ClusterWorkFrameIdentity;
    readonly encoded: boolean;
    readonly reason?: string;
  },
): void {
  if (state === undefined || !state.enabled) return;
  const trace = state.trace;
  if (trace === undefined) return;
  const wrongRecordAttempt = input.recordFrameNumber !== trace.recordFrameNumber;
  trace.graphTargetCopy = Object.freeze({
    targetName: input.targetName,
    recordFrameNumber: trace.recordFrameNumber,
    ...(input.expectedIdentity === undefined
      ? {}
      : { expectedIdentity: Object.freeze({ ...input.expectedIdentity }) }),
    ...(input.actualIdentity === undefined
      ? {}
      : { actualIdentity: Object.freeze({ ...input.actualIdentity }) }),
    encoded: input.encoded && !wrongRecordAttempt,
    ...((wrongRecordAttempt ? 'wrong-record-attempt' : input.reason) === undefined
      ? {}
      : { reason: wrongRecordAttempt ? 'wrong-record-attempt' : input.reason }),
  });
}

export function recordClusterWorkFrameReceiptForConformance(
  state: ClusterWorkConformanceState | undefined,
  input: {
    readonly observationFrameId: number;
    readonly publicReceiptFrameId: number;
    readonly deviceGeneration: number;
    readonly presentation: 'ready' | 'pending';
    readonly completed: Promise<unknown>;
  },
): boolean {
  if (state === undefined || !state.enabled) return false;
  const trace = state.trace;
  if (
    trace === undefined ||
    (trace.recordStatus !== 'submitted' && trace.recordStatus !== 'pending') ||
    trace.observationFrameId !== input.observationFrameId ||
    trace.receipt !== undefined
  ) {
    return false;
  }
  trace.deviceGeneration ??= input.deviceGeneration;
  const receipt: ClusterWorkFrameReceiptTrace = Object.freeze({
    publicReceiptFrameId: input.publicReceiptFrameId,
    deviceGeneration: input.deviceGeneration,
    presentation: input.presentation,
    completion: 'pending',
  });
  trace.receipt = receipt;
  const updateCompletion = (completion: 'completed' | 'failed'): void => {
    if (trace.receipt !== receipt) return;
    trace.receipt = Object.freeze({ ...receipt, completion });
  };
  void input.completed.then(
    (result) => {
      const failed =
        typeof result === 'object' && result !== null && 'ok' in result && result.ok === false;
      updateCompletion(failed ? 'failed' : 'completed');
    },
    () => updateCompletion('failed'),
  );
  return true;
}

export function readClusterWorkFrameTrace(
  state: ClusterWorkConformanceState | undefined,
): ClusterWorkFrameTrace | undefined {
  if (state === undefined || !state.enabled || state.trace === undefined) return undefined;
  const trace = state.trace;
  return Object.freeze({
    recordFrameNumber: trace.recordFrameNumber,
    recordStatus: trace.recordStatus,
    ...(trace.observationFrameId === undefined
      ? {}
      : { observationFrameId: trace.observationFrameId }),
    ...(trace.viewEntityKey === undefined ? {} : { viewEntityKey: trace.viewEntityKey }),
    ...(trace.deviceGeneration === undefined ? {} : { deviceGeneration: trace.deviceGeneration }),
    ...(trace.graphGeneration === undefined ? {} : { graphGeneration: trace.graphGeneration }),
    ...(trace.clusterTransportGeneration === undefined
      ? {}
      : { clusterTransportGeneration: trace.clusterTransportGeneration }),
    ...(trace.clusterWork === undefined ? {} : { clusterWork: trace.clusterWork }),
    ...(trace.graphTargetCopy === undefined ? {} : { graphTargetCopy: trace.graphTargetCopy }),
    ...(trace.receipt === undefined ? {} : { receipt: trace.receipt }),
  });
}

export function readClusterWorkObservation(
  state: ClusterWorkConformanceState,
  currentDeviceGeneration: number,
): ClusterWorkObservation | undefined {
  if (!state.enabled) return undefined;
  const observation = state.observation;
  if (observation === undefined) {
    return Object.freeze({ status: 'unavailable', reason: 'awaiting-write' });
  }
  if (
    observation.status === 'captured' &&
    observation.deviceGeneration !== currentDeviceGeneration
  ) {
    return Object.freeze({ status: 'unavailable', reason: 'device-generation-changed' });
  }
  return Object.freeze({ ...observation });
}
