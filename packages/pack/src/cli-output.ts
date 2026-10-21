/** Output boundary shared by asset discovery and built-in source producers. */
export interface AssetCliContext {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
}

export interface AssetCliError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

export function emitAssetCliError(ctx: AssetCliContext, error: AssetCliError): number {
  const payload: Record<string, unknown> = {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
  };
  if (error.detail !== undefined) payload.detail = error.detail;
  ctx.stderrWrite(JSON.stringify(payload));
  return 1;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function serializeMetaJson(meta: unknown): string {
  return `${JSON.stringify(sortKeysDeep(meta), null, 2)}\n`;
}
