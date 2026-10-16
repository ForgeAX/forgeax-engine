import { isOpaqueWorkspaceDiagnostic } from './contract.ts';

export function workspaceDiagnosticRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
type ErrorContext = { signal?: AbortSignal; operation?: string };
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

function errorText(value: unknown) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function pickDiagnostic(candidates: readonly unknown[]) {
  const texts = candidates.map(errorText).filter((value) => value !== undefined);
  const real = texts.filter((value) => !isOpaqueWorkspaceDiagnostic(value));
  return real[0] ?? texts[0];
}

function collectDiagnosticSources(value: unknown, sources: Record<string, unknown>[] = [], depth = 0) {
  if (depth > 6 || value === undefined || value === null) return sources;
  if (typeof value !== 'object') return sources;
  const record = workspaceDiagnosticRecord(value);
  sources.push(record);
  if (Array.isArray(value)) {
    for (const entry of value) collectDiagnosticSources(entry, sources, depth + 1);
    return sources;
  }
  collectDiagnosticSources(record.detail, sources, depth + 1);
  collectDiagnosticSources(record.payload, sources, depth + 1);
  collectDiagnosticSources(record.failure, sources, depth + 1);
  collectDiagnosticSources(record.cause, sources, depth + 1);
  collectDiagnosticSources(record.error, sources, depth + 1);
  return sources;
}

function serializeErrorValue(value: unknown, seen = new Set<object>(), depth = 0): JsonValue {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value) || depth > 8) return '[Circular]';
  seen.add(value);
  const record = workspaceDiagnosticRecord(value);
  if (typeof record.message === 'string' && (value instanceof Error || typeof record.name === 'string')) {
    const serialized = {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      message: record.message,
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      ...(typeof record.expected === 'string' ? { expected: record.expected } : {}),
      ...(typeof record.hint === 'string' ? { hint: record.hint } : {}),
      ...(record.detail === undefined
        ? {}
        : { detail: serializeErrorValue(record.detail, seen, depth + 1) }),
      ...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
    };
    return serialized;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeErrorValue(entry, seen, depth + 1));
  }
  const result: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = serializeErrorValue(entry, seen, depth + 1);
  }
  return result;
}

export function isIgnorableWorkspaceCommandError(error: unknown, { signal, operation }: ErrorContext = {}) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const record = workspaceDiagnosticRecord(error);
  if (record.name === 'AbortError') return true;
  if (record.code === 'view-workspace-selection-superseded') return true;
  const code = record.code;
  // Snapshot readers recover once and render any remaining stale source as an
  // explicit partial result. The request still rejects for exact-generation callers.
  if (operation === 'plugins.inspect' && code === 'view-inspector-stale-generation') return true;
  return code === 'ABORT_ERR' || code === 'ERR_CANCELED';
}

export function formatWorkspaceCommandError(error: unknown) {
  const sources = collectDiagnosticSources(error);
  const code = pickDiagnostic(sources.map((source) => source?.code));
  const expected = pickDiagnostic(sources.map((source) => source?.expected));
  const hint = pickDiagnostic([
    ...sources.map((source) => source?.hint),
    ...sources.map((source) => source?.message),
    expected,
  ]);
  const rawMessage = error instanceof Error
    ? error.message
    : error === undefined || error === null
      ? undefined
      : String(error);
  const description = pickDiagnostic([expected, hint, rawMessage, code]);
  const visibleHint = hint && hint !== description ? hint : undefined;
  let detailsText: string | undefined;
  try {
    const json = JSON.stringify(serializeErrorValue(error), null, 2);
    if (json && json !== '{}' && json !== '[]' && json !== 'null') detailsText = json;
  } catch {
    detailsText = rawMessage;
  }
  return {
    code,
    description,
    hint: visibleHint,
    detailsText,
  };
}

const listeners = new Set<(error: unknown, context: ErrorContext) => void>();

export function subscribeWorkspaceCommandErrors(listener: (error: unknown, context: ErrorContext) => void) {
  if (typeof listener !== 'function') {
    throw new TypeError('subscribeWorkspaceCommandErrors requires a function');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportWorkspaceCommandError(error: unknown, context: ErrorContext = {}) {
  if (isIgnorableWorkspaceCommandError(error, context)) return;
  for (const listener of listeners) {
    try {
      listener(error, context);
    } catch {
      // Presenter failures must not replace the original command error.
    }
  }
}
