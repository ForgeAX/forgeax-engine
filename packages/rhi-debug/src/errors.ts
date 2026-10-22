// @forgeax/engine-rhi-debug/src/errors -- one closed core error union.

/// <reference types="@webgpu/types" />

/** The only error vocabulary crossing the RHI-debug core boundary. */
export type RhiDebugErrorCode = keyof RhiDebugDetailByCode;

export type CaptureStage = 'capture' | 'snapshot';

export interface CaptureFailureDetail {
  readonly stage: CaptureStage;
  readonly cause: string;
  readonly handleId?: string;
  readonly resourceKind?: 'buffer' | 'texture';
  readonly progress?: {
    readonly snapshotStage: 'queue-drain' | 'resource-readback' | 'resource-hash';
    readonly totalResources: number;
    readonly completedResources: number;
    readonly skippedResources: number;
    readonly currentHandleId: string | null;
    readonly currentKind: 'buffer' | 'texture' | null;
    readonly currentSizeBytes: number | null;
    readonly elapsedMs: number;
  };
}

export interface CaptureTimeoutDetail extends CaptureFailureDetail {
  readonly stage: 'snapshot';
  readonly timeoutMs: number;
}

export interface TapeFailureDetail {
  readonly stage: 'decode' | 'validate';
  readonly cause: string;
  readonly handleId?: string;
  readonly eventIndex?: number;
}

export interface TapeVersionDetail {
  readonly foundVersion: number;
  readonly expectedVersion: number;
}

export interface ReplayCapabilityFailureDetail {
  readonly stage: 'replay';
  readonly cause: string;
}

export interface ReplayEventFailureDetail {
  readonly eventIndex: number;
  readonly kind: string;
  readonly stage: string;
  readonly cause: string;
}

export interface ReplayPositionDetail {
  readonly requested: number;
  readonly available: number;
}

export interface ReadbackFailureDetail {
  readonly stage: 'readback';
  readonly cause: string;
  readonly phase?: 'copy' | 'map';
}

export interface ReadbackUnsupportedDetail {
  readonly stage: 'readback';
  readonly resourceId?: string;
  readonly format?: string;
  readonly reason: string;
}

type RhiDebugDetailByCode = {
  'capture-unavailable': CaptureFailureDetail;
  'capture-busy': CaptureFailureDetail;
  'capture-snapshot-failed': CaptureFailureDetail;
  'capture-timeout': CaptureTimeoutDetail;
  'tape-invalid': TapeFailureDetail;
  'tape-version-unsupported': TapeVersionDetail;
  'replay-capability-mismatch': ReplayCapabilityFailureDetail;
  'replay-event-failed': ReplayEventFailureDetail;
  'replay-position-invalid': ReplayPositionDetail;
  'readback-failed': ReadbackFailureDetail;
  'readback-unsupported': ReadbackUnsupportedDetail;
};

export type RhiDebugErrorFor<C extends RhiDebugErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RhiDebugDetailByCode[C];
};

export type RhiDebugError = {
  [C in RhiDebugErrorCode]: RhiDebugErrorFor<C>;
}[RhiDebugErrorCode];

const VERSION_HINT =
  'use the source revision/tool that produced this tape, or capture again on the current revision';

export function createRhiDebugError<C extends RhiDebugErrorCode>(
  code: C,
  detail: RhiDebugDetailByCode[C],
): RhiDebugErrorFor<C> {
  return {
    code,
    expected: expectedFor(code),
    hint: recoveryHint(code),
    detail,
  };
}

function expectedFor(code: RhiDebugErrorCode): string {
  switch (code) {
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
      return 'a capture capability that can complete one bounded frame';
    case 'tape-invalid':
    case 'tape-version-unsupported':
      return 'a valid v7 RHI debug tape';
    case 'replay-capability-mismatch':
    case 'replay-event-failed':
    case 'replay-position-invalid':
      return 'a fresh replay session with a valid workIndex';
    case 'readback-failed':
    case 'readback-unsupported':
      return 'a supported readback target';
  }
}

function recoveryHint(code: RhiDebugErrorCode): string {
  switch (code) {
    case 'capture-unavailable':
      return 'enable the single RHI capture capability and retry';
    case 'capture-busy':
      return 'wait for the active capture to finish, then issue one new request';
    case 'capture-snapshot-failed':
      return 'inspect the snapshot stage and capture again after fixing the resource';
    case 'capture-timeout':
      return 'increase the bounded timeout or capture again after the device becomes idle';
    case 'tape-invalid':
      return 'obtain complete bytes and retry strict decoding; do not continue to replay';
    case 'tape-version-unsupported':
      return VERSION_HINT;
    case 'replay-capability-mismatch':
      return 'use a fresh device satisfying the recorded RHI capabilities';
    case 'replay-event-failed':
      return 'inspect eventIndex, kind, stage, and cause; later work is not valid';
    case 'replay-position-invalid':
      return 'choose a workIndex present in FrameModel.works';
    case 'readback-failed':
      return 'inspect the readback cause and retry on a live fresh replay session';
    case 'readback-unsupported':
      return 'inspect the descriptor or use a backend with the requested readback support';
  }
}
