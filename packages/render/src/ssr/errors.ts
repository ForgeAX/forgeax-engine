export type SsrOwnerRecoveryAction =
  | 'use-LKG'
  | 'use-Skylight'
  | 'use-neutral'
  | 'recapture'
  | 'rebuild'
  | 'retry';

/** Closed authoring fields accepted by the ScreenSpaceReflection schema. */
export type SsrConfigField = 'maxDistance' | 'thickness' | 'maxRoughness';

/** Dynamic finite range returned by ScreenSpaceReflection validation. */
export interface SsrConfigRange {
  readonly min: number;
  readonly minInclusive: boolean;
  readonly max: number;
  readonly maxInclusive: boolean;
}

/** Structured invalid-authoring failure; callers branch on code and detail. */
export interface SsrConfigInvalidError {
  readonly code: 'ssr-config-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly field: SsrConfigField;
    readonly value: number;
    readonly range: SsrConfigRange;
  };
}

/** Closed spatial admission reasons. */
export type SsrSpatialUnavailableReason =
  | 'lane-unsupported'
  | 'projection-unsupported'
  | 'scene-input-unavailable'
  | 'capability-unavailable'
  | 'format-unavailable'
  | 'temporal-unavailable'
  | 'reflection-fallback-unavailable'
  | 'recovery-unavailable';

/** Structured spatial admission failure with bounded actual facts. */
export interface SsrUnavailableError {
  readonly code: 'ssr-unavailable';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly lane: string;
    readonly reason: SsrSpatialUnavailableReason;
    readonly required: readonly string[];
    readonly actual: Readonly<Record<string, boolean | number | string>>;
    readonly recovery: string;
  };
}
