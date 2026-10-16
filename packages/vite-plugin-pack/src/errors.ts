import type { CatalogDiagnosticCause } from '@forgeax/engine-types';
export type PluginPackFailureStage =
  | 'config'
  | 'scan'
  | 'produce'
  | 'finalize'
  | 'commit'
  | 'emit'
  | 'watch'
  | 'route'
  | 'cleanup';

export type PluginPackFailureCode =
  | 'config-failed'
  | 'scan-failed'
  | 'produce-failed'
  | 'finalize-failed'
  | 'commit-failed'
  | 'emit-failed'
  | 'watch-failed'
  | 'route-failed'
  | 'cleanup-failed'
  | 'stale-generation';

export interface PluginPackFailureDetail {
  readonly stage: PluginPackFailureStage;
  readonly subject?: string;
}

export interface PluginPackFailure {
  readonly code: PluginPackFailureCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PluginPackFailureDetail;
  readonly cause?: unknown;
  readonly cleanup?: readonly PluginPackFailure[];
}

export function createPluginPackFailure(
  input: Omit<PluginPackFailure, 'cleanup'>,
): PluginPackFailure {
  return {
    code: input.code,
    expected: input.expected,
    hint: input.hint,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
}

export function appendPluginPackCleanup(
  primary: PluginPackFailure,
  cleanup: PluginPackFailure,
): PluginPackFailure {
  return {
    ...primary,
    cleanup: [...(primary.cleanup ?? []), cleanup],
  };
}

export function projectFailureCause(value: unknown): CatalogDiagnosticCause | undefined {
  const seen = new Set<object>();
  const project = (value: unknown, depth: number): CatalogDiagnosticCause | undefined => {
    if (value === undefined || value === null || depth >= 6 || seen.size >= 40) return undefined;
    if (typeof value === 'string') return { message: value.slice(0, 2000) };
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 40)
        .map((entry) => project(entry, depth + 1))
        .filter((entry) => entry !== undefined);
    }
    const input = value as Record<string, unknown>;
    const result: {
      -readonly [K in keyof Exclude<CatalogDiagnosticCause, readonly unknown[]>]?: Exclude<
        CatalogDiagnosticCause,
        readonly unknown[]
      >[K];
    } = {};
    for (const key of ['code', 'message', 'expected', 'actual', 'hint', 'path'] as const) {
      if (typeof input[key] === 'string') result[key] = input[key].slice(0, 2000);
    }
    if (input.detail && typeof input.detail === 'object') {
      const detail: Record<string, string | readonly string[]> = {};
      const source = input.detail as Record<string, unknown>;
      for (const key of [
        'stage',
        'subject',
        'sourcePath',
        'sourceKey',
        'reason',
        'path',
        'missingGuids',
        'unexpectedSourceKeys',
        'undeclaredReferencedGuids',
        'undeclaredReadGuids',
        'unusedDeclaredGuids',
      ]) {
        const item = source[key];
        if (typeof item === 'string') detail[key] = item.slice(0, 2000);
        else if (Array.isArray(item))
          detail[key] = item
            .slice(0, 40)
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.slice(0, 2000));
      }
      for (const key of ['propertyPath', 'actual', 'diagnostic', 'phase']) {
        if (typeof source[key] === 'string') detail[key] = source[key].slice(0, 2000);
      }
      if (Object.keys(detail).length) result.detail = detail;
    }
    const cause = project(input.cause, depth + 1);
    if (cause !== undefined) result.cause = cause;
    return Object.keys(result).length > 0 ? result : undefined;
  };
  return project(value, 0);
}
