/** Closed errors produced by the CloudLayer authoring and resource route. */

export interface CloudLayerInvalidParameterDetail {
  readonly field: string;
  readonly value: unknown;
  readonly expected: string;
}

export class CloudLayerInvalidParameterError extends Error {
  readonly code = 'cloud-layer-invalid-parameter' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: CloudLayerInvalidParameterDetail;

  constructor(field: string, value: unknown, expected: string) {
    super(`CloudLayer.${field} is invalid`);
    this.name = 'CloudLayerInvalidParameterError';
    this.expected = `CloudLayer.${field} must be ${expected}`;
    this.hint = `set CloudLayer.${field} to ${expected}`;
    this.detail = { field, value, expected };
  }
}

export interface CloudLayerOwnerConflictDetail {
  readonly count: number;
}

export class CloudLayerOwnerConflictError extends Error {
  readonly code = 'cloud-layer-owner-conflict' as const;
  readonly expected = 'at most one CloudLayer owns a World frame';
  readonly hint = 'remove additional CloudLayer owners before extraction';
  readonly detail: CloudLayerOwnerConflictDetail;

  constructor(count: number) {
    super(`CloudLayer owner cardinality is ${count}`);
    this.name = 'CloudLayerOwnerConflictError';
    this.detail = { count };
  }
}

export interface CloudLayerCacheInvalidDetail {
  readonly sourceKey: string;
  readonly reason: string;
}

export class CloudLayerCacheInvalidError extends Error {
  readonly code = 'cloud-layer-cache-invalid' as const;
  readonly expected = 'the density cache payload matches its reconstructible source';
  readonly hint = 'discard the derived cache and rebuild it from CloudLayer source facts';
  readonly detail: CloudLayerCacheInvalidDetail;

  constructor(sourceKey: string, reason: string) {
    super(`CloudLayer cache is invalid: ${reason}`);
    this.name = 'CloudLayerCacheInvalidError';
    this.detail = { sourceKey, reason };
  }
}

export interface CloudLayerCapabilityMissingDetail {
  readonly capability: string;
}

export class CloudLayerCapabilityMissingError extends Error {
  readonly code = 'cloud-layer-capability-missing' as const;
  readonly expected = 'the selected backend exposes the capability required by the cloud lane';
  readonly hint =
    'inspect the capability report, disable the cloud lane on this backend, or retry on a backend with the required capability';
  readonly detail: CloudLayerCapabilityMissingDetail;

  constructor(capability: string) {
    super(`CloudLayer capability is unavailable: ${capability}`);
    this.name = 'CloudLayerCapabilityMissingError';
    this.detail = { capability };
  }
}

export interface CloudLayerResourceFailureDetail {
  readonly stage: 'cache' | 'shadow' | 'view' | 'history' | 'retire';
  readonly generation: number;
  readonly cause?: unknown;
}

export class CloudLayerResourceFailureError extends Error {
  readonly code = 'cloud-layer-resource-failed' as const;
  readonly expected = 'cloud resources are created, submitted and retired as one generation';
  readonly hint = 'keep the last-known-good cloud generation and retry after recovery';
  readonly detail: CloudLayerResourceFailureDetail;

  constructor(detail: CloudLayerResourceFailureDetail) {
    super(`CloudLayer ${detail.stage} resource failed at generation ${detail.generation}`);
    this.name = 'CloudLayerResourceFailureError';
    this.detail = detail;
  }
}

export type CloudLayerError =
  | CloudLayerInvalidParameterError
  | CloudLayerOwnerConflictError
  | CloudLayerCacheInvalidError
  | CloudLayerCapabilityMissingError
  | CloudLayerResourceFailureError;

export type CloudLayerErrorCode = CloudLayerError['code'];
