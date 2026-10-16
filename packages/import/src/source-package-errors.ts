import type { ImportError } from '@forgeax/engine-types';

const SOURCE_PACKAGE_ERROR_POLICY = {
  'source-package-meta-invalid': {
    expected: 'a valid source Meta declaration with complete GUID topology',
    hint: 'repair the Meta declaration, then rebuild or cold-cook the source package',
  },
  'source-package-importer-missing': {
    expected: 'a registered importer for the source Meta importer key',
    hint: 'register the named importer, then rebuild or cold-cook the source package',
  },
  'source-package-conversion-failed': {
    expected: 'the configured importer to convert the source successfully',
    hint: 'repair the source or importer, then rebuild or cold-cook the source package',
  },
  'source-package-ddc-failed': {
    expected: 'a readable persistent DDC entry with matching integrity evidence',
    hint: 'discard the invalid derived entry, then rebuild or cold-cook the source package',
  },
  'source-package-publication-invalid': {
    expected: 'a complete Pack body, refs, artifacts, and route integrity',
    hint: 'repair the missing product bytes, then rebuild or cold-cook the source package',
  },
  'source-package-guid-closure-mismatch': {
    expected: 'exactly one produced asset for every declared GUID',
    hint: 'repair the Meta topology or importer output, then rebuild the whole source package',
  },
} as const;

export type SourcePackageErrorCode = keyof typeof SOURCE_PACKAGE_ERROR_POLICY;

export type SourcePackageErrorStage =
  | 'meta'
  | 'importer'
  | 'conversion'
  | 'closure'
  | 'ddc'
  | 'route-integrity';

export interface SourcePackageErrorContext {
  readonly sourceMeta: string;
  readonly anchorGuid: string;
  readonly affectedGuids: readonly string[];
  readonly producer: string;
  readonly importer: string;
}

export interface SourcePackageErrorDetail extends SourcePackageErrorContext {
  readonly stage: SourcePackageErrorStage;
  readonly reason?: string;
  readonly missing?: readonly string[];
  readonly unexpected?: readonly string[];
  readonly registeredImporters?: readonly string[];
}

export interface SourcePackageError {
  readonly code: SourcePackageErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SourcePackageErrorDetail;
}

export function sourcePackageError(
  code: SourcePackageErrorCode,
  context: SourcePackageErrorContext,
  detail: Omit<SourcePackageErrorDetail, keyof SourcePackageErrorContext>,
): SourcePackageError {
  const policy = SOURCE_PACKAGE_ERROR_POLICY[code];
  return {
    code,
    expected: policy?.expected as string,
    hint: policy?.hint as string,
    detail: { ...context, ...detail },
  };
}

function unknownReason(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value.code === 'string') {
      const detail = value.detail;
      const reason =
        detail !== null && typeof detail === 'object' && 'reason' in detail
          ? (detail as { readonly reason?: unknown }).reason
          : undefined;
      const diagnostic =
        detail !== null && typeof detail === 'object' && 'diagnostic' in detail
          ? (detail as { readonly diagnostic?: unknown }).diagnostic
          : undefined;
      return `${value.code}: ${
        typeof diagnostic === 'string'
          ? diagnostic
          : typeof reason === 'string'
            ? reason
            : String(value.expected ?? 'producer failure')
      }`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function importFailureCode(error: ImportError): SourcePackageErrorCode {
  switch (error.code) {
    case 'importer-not-registered':
      return 'source-package-importer-missing';
    case 'import-produced-no-assets':
    case 'guid-mismatch':
    case 'source-validation-failed':
      return 'source-package-guid-closure-mismatch';
    case 'source-read-failed':
    case 'import-internal-error':
    case 'mesh-material-slot-topology-change':
    case 'mesh-lod-contract-invalid':
    case 'mesh-lod-topology-change':
    case 'mesh-lod-authority-conflict':
    case 'unknown-source-key':
    case 'duplicate-source-key':
    case 'invalid-source-overrides':
    case 'invalid-source-override-payload':
      return 'source-package-conversion-failed';
  }
}

const IMPORT_ERROR_CODES = new Set([
  'importer-not-registered',
  'source-read-failed',
  'import-produced-no-assets',
  'guid-mismatch',
  'mesh-material-slot-topology-change',
  'mesh-lod-contract-invalid',
  'mesh-lod-topology-change',
  'mesh-lod-authority-conflict',
  'import-internal-error',
  'source-validation-failed',
  'unknown-source-key',
  'duplicate-source-key',
  'invalid-source-overrides',
  'invalid-source-override-payload',
]);

function findNormalizableCause(error: unknown, seen = new Set<unknown>()): unknown {
  if (error === null || typeof error !== 'object' || seen.has(error)) return undefined;
  seen.add(error);
  if (isSourcePackageError(error) || isScriptablePackFailure(error) || isImportError(error)) {
    return error;
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause === undefined ? undefined : findNormalizableCause(cause, seen);
}

/** Return whether an error chain contains a source-package/import contract error. */
export function containsSourcePackageError(error: unknown, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (isSourcePackageError(error) || isImportError(error)) return true;
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause !== undefined && containsSourcePackageError(cause, seen);
}

export function normalizeSourcePackageError(
  error: unknown,
  context: SourcePackageErrorContext,
): SourcePackageError {
  const cause = findNormalizableCause(error);
  if (cause !== undefined && cause !== error) return normalizeSourcePackageError(cause, context);
  if (isSourcePackageError(error)) return error;
  if (isScriptablePackFailure(error)) {
    return sourcePackageError('source-package-conversion-failed', context, {
      stage: 'conversion',
      reason: unknownReason(error),
    });
  }
  if (isImportError(error)) {
    const code = importFailureCode(error);
    const detail: Omit<SourcePackageErrorDetail, keyof SourcePackageErrorContext> = {
      stage: code === 'source-package-importer-missing' ? 'importer' : 'conversion',
      reason: unknownReason(error),
      ...(code === 'source-package-importer-missing' && 'registeredImporters' in error.detail
        ? { registeredImporters: error.detail.registeredImporters }
        : {}),
    };
    return sourcePackageError(code, context, detail);
  }
  return sourcePackageError(contextErrorStage(error), context, {
    stage: 'conversion',
    reason: unknownReason(error),
  });
}

function isSourcePackageError(error: unknown): error is SourcePackageError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code in SOURCE_PACKAGE_ERROR_POLICY &&
    'expected' in error &&
    typeof error.expected === 'string' &&
    'hint' in error &&
    typeof error.hint === 'string' &&
    'detail' in error &&
    error.detail !== null &&
    typeof error.detail === 'object'
  );
}

function contextErrorStage(error: unknown): SourcePackageErrorCode {
  return error instanceof SyntaxError
    ? 'source-package-meta-invalid'
    : 'source-package-conversion-failed';
}

function isImportError(error: unknown): error is ImportError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    IMPORT_ERROR_CODES.has(error.code) &&
    'expected' in error &&
    'hint' in error &&
    'detail' in error
  );
}

function isScriptablePackFailure(error: unknown): error is {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
} {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('pack-source-') &&
    'expected' in error &&
    typeof error.expected === 'string' &&
    'hint' in error &&
    typeof error.hint === 'string' &&
    'detail' in error
  );
}
