export type QueryBatchUnavailableReason =
  | 'write-access'
  | 'temporal-filter'
  | 'undeclared-component'
  | 'unknown-field'
  | 'non-numeric-field'
  | 'missing-required-data'
  | 'expired-batch';

/** The read-only physical batch boundary rejects unsupported access explicitly. */
export class QueryBatchUnavailableError extends Error {
  override readonly name = 'QueryBatchUnavailableError';
  readonly code = 'query-batch-unavailable' as const;
  readonly expected = 'a live read-only batch and a declared inline numeric field';
  readonly hint =
    'Use read/optional numeric fields within this batch; use existing rows or spans for write/temporal descriptors.';
  readonly detail: {
    readonly reason: QueryBatchUnavailableReason;
    readonly componentName?: string;
    readonly fieldName?: string;
  };

  constructor(reason: QueryBatchUnavailableReason, componentName?: string, fieldName?: string) {
    super(`Query batch access is unavailable: ${reason}.`);
    this.detail = {
      reason,
      ...(componentName === undefined ? {} : { componentName }),
      ...(fieldName === undefined ? {} : { fieldName }),
    };
  }
}
