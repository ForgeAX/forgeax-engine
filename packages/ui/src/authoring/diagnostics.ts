import type { ImportDiagnostic, ImportSourceRange } from '@forgeax/engine-types';

export function sourceRange(source: string, start: number, end = start + 1): ImportSourceRange {
  const boundedStart = Math.max(0, Math.min(start, source.length));
  const boundedEnd = Math.max(
    boundedStart + 1,
    Math.min(Math.max(end, boundedStart + 1), source.length + 1),
  );
  const prefix = source.slice(0, boundedStart);
  return {
    start: boundedStart,
    end: boundedEnd,
    line: prefix.split('\n').length,
    column: boundedStart - prefix.lastIndexOf('\n'),
  };
}

export function serializeDiagnostics(diagnostics: readonly ImportDiagnostic[]): string {
  return JSON.stringify(diagnostics, (_key, value: unknown) => value, 2);
}

export function hasBlockingDiagnostics(diagnostics: readonly ImportDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}
