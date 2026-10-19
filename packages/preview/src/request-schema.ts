import type { SnapshotRef, ToolSchemaResult, ToolSubjectRef } from '@forgeax/engine-tool-runtime';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) if (typeof entry !== 'string') return false;
  return true;
}

/** Admit the shared envelope before a domain reads any binding fields. */
export function parsePreviewRequest(
  value: unknown,
  kind: string,
): ToolSchemaResult<
  Record<string, unknown> & {
    readonly subject: ToolSubjectRef;
    readonly snapshot: SnapshotRef;
    readonly binding: Record<string, unknown>;
  }
> {
  if (!isRecord(value)) return { ok: false, error: `expected a ${kind} preview request object` };
  const { subject, snapshot, binding } = value;
  if (!isRecord(subject) || subject.kind !== kind || typeof subject.guid !== 'string')
    return { ok: false, error: `expected a ${kind} subject` };
  if (
    !isRecord(snapshot) ||
    !isSafeInteger(snapshot.revision) ||
    typeof snapshot.digest !== 'string'
  )
    return { ok: false, error: 'expected a revisioned snapshot' };
  if (!isRecord(binding) || binding.guid !== subject.guid)
    return { ok: false, error: `expected a bound ${kind} binding` };
  return {
    ok: true,
    value: {
      ...value,
      subject: { kind, guid: subject.guid },
      snapshot: { revision: snapshot.revision, digest: snapshot.digest },
      binding,
    },
  };
}
