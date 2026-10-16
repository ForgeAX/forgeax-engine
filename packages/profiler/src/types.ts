import type {
  ProfileCapture,
  ProfileCompleteness,
  ProfilePhaseRecord,
  ProfileRecord,
  ProfileSkipRecord,
  ProfileSource,
} from './generated/profile-capture.js';

export type {
  ProfileCapture,
  ProfileCompleteness,
  ProfilePhaseRecord,
  ProfileRecord,
  ProfileSkipRecord,
  ProfileSource,
};

export type ProfileResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type ProfileSinkFailure = {
  readonly code: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: { readonly message?: string };
};

export type ProfileSinkWriteResult =
  | { readonly ok: true; readonly value?: undefined }
  | { readonly ok: false; readonly error: ProfileSinkFailure };

export interface ProfileSink {
  write(capture: ProfileCapture): void | ProfileSinkWriteResult;
}

export interface ProfileAllocationReport {
  profilerEventObjectAllocations: number;
}

export interface ProfileFrameToken {
  readonly captureId: string;
  readonly frameId: number;
}

export interface ProfilePhaseStart {
  readonly source: ProfileSource;
  readonly phase: string;
}

export interface ProfileSkipInput {
  readonly source: ProfileSource;
  readonly phase: string;
  readonly reason: string;
}
