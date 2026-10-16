import type { Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import type { RhiCallEvent as LegacyRhiCallEvent } from '../types';

export const TAPE_FORMAT_VERSION = 7 as const;
export const TAPE_MAGIC = 'RHITAPE' as const;

export type RhiCallEvent = LegacyRhiCallEvent;
export type EventKind = RhiCallEvent['kind'];
export type TapeBlobCompression = 'none' | 'gzip';
export type ResourceKind =
  | 'buffer'
  | 'texture'
  | 'query-set'
  | 'acceleration-structure'
  | 'texture-view'
  | 'sampler'
  | 'shader-module'
  | 'pipeline'
  | 'binding'
  | 'encoder';

export interface RhiCapsRecorded {
  readonly [key: string]: boolean | number | string | null;
}

export interface InitialDataSlice {
  readonly hash: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface BootstrapResource {
  readonly handleId: string;
  readonly kind: ResourceKind;
  readonly create: Record<string, unknown>;
  readonly initialData: readonly InitialDataSlice[];
  /** Present only when a capture seed scope left this live resource unseeded. */
  readonly seed?: 'omitted';
}

export interface TapeBlob {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly compression: TapeBlobCompression;
}

export interface Tape {
  readonly header: {
    readonly formatVersion: typeof TAPE_FORMAT_VERSION;
    readonly rhiCaps: RhiCapsRecorded;
    readonly eventCount: number;
    readonly blobCount: number;
  };
  readonly bootstrap: readonly BootstrapResource[];
  readonly events: readonly RhiCallEvent[];
  readonly blobs: readonly TapeBlob[];
}

/** Tape shape whose blob payloads are identified but not necessarily resident. */
export type TapeStructure = Omit<Tape, 'blobs'> & {
  readonly blobs: readonly { readonly hash: string }[];
};

export interface TapeEncodeOptions {
  readonly compression?: TapeBlobCompression;
}

export type RhiDebugResult<T> = Result<T, RhiDebugError>;
