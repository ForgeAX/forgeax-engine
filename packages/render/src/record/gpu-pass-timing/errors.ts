export type GpuPassTimingReasonCode =
  | 'gpu-timing-not-enabled'
  | 'timestamp-query-unsupported'
  | 'timestamp-period-unavailable'
  | 'query-budget-exceeded'
  | 'timing-in-flight-exhausted'
  | 'timing-retention-expired'
  | 'timestamp-write-unavailable'
  | 'timestamp-owner-conflict'
  | 'timestamp-resolve-failed'
  | 'timestamp-readback-failed'
  | 'timestamp-range-invalid'
  | 'timing-device-generation-stale'
  | 'timing-session-disposed'
  | 'invalid-timing-options';

export type GpuPassTimingJson =
  | null
  | boolean
  | number
  | string
  | readonly GpuPassTimingJson[]
  | { readonly [key: string]: GpuPassTimingJson };

export interface GpuPassTimingReason {
  readonly code: GpuPassTimingReasonCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly [key: string]: GpuPassTimingJson };
  readonly cause?: { readonly [key: string]: GpuPassTimingJson } | undefined;
}

export type GpuPassTimingError = GpuPassTimingReason;
export type GpuPassTimingErrorCode = GpuPassTimingReasonCode;
